-- Heizung München – Migration 018: Planer auf den Stand von Venediger (24.11.2026)
-- Beschreibung: doc/PLANER-WIE-VENEDIGER-2026-11-24.md
-- Vorbild Venediger: SQL 38_planer_pruefung.sql (13.11.), 41_messwerte_cache.sql (14.11.), 42_planer_min_hart.sql (14.11.),
--                    45_planer_regeln_rahmen.sql (16.11.)
-- Im Supabase SQL-Editor ausführen, kann gefahrlos mehrfach ausgeführt werden. Ändert nur muc_-Objekte.
--
-- Inhalt
--   1. muc_settings.planer_pruefung  – Stand der Plan-Prüfung je Raum (schreibt heizplaner-muenchen, liest App und Collector)
--      planer_sicherheit_abstand = 0 – Min hart wie Venediger (14.11.2026, Uli: „Min ist die Untergrenze, keinen Wert darunter“)
--   2. muc_raum_messwerte(p_tage)    – was je Raum GEMESSEN ist (Aufheizen, Heizstunden je Tag, Übersteuern) für die Prüfung
--   3. Cache stündlich (pg_cron)    – sonst Timeout in muc_heizplaner_daten (Venediger 14.11.: 8-s-Grenze von PostgREST);
--                                     gemessen 24.11.2026: muc_raum_messwerte(14) braucht ~22 s (Minutenwerte, 16 Räume)
--   4. muc_heizplaner_daten          – liefert zusätzlich messwerte, pruefung, pv_min_soc, wait_min_kwh, seq_on_delta

-- ---------------------------------------------------------------------------
-- 1) Einstellungen
-- ---------------------------------------------------------------------------
alter table public.muc_settings add column if not exists planer_pruefung jsonb;
comment on column public.muc_settings.planer_pruefung is
  'Plan-Prüfung je Raum (heizplaner-muenchen): {stand, at, raeume: {id: {ok, gruende, hinweis, geplant_h, erlaubt_h}}} – auffällige Räume steuert bei „KI steuert“ die Regel-Steuerung';
alter table public.muc_settings add column if not exists raum_messwerte_cache jsonb;
comment on column public.muc_settings.raum_messwerte_cache is 'Cache von muc_raum_messwerte(14), stündlich (cron muc-raum-messwerte)';

-- Venediger 14.11.2026: Der Planer hält Min hart, ohne Abstand darunter (Regler „Sicherheit unter Untergrenze“ entfällt)
update public.muc_settings set planer_sicherheit_abstand = 0 where id = 1 and planer_sicherheit_abstand <> 0;
comment on column public.muc_settings.planer_sicherheit_abstand is 'seit 24.11.2026 ohne Wirkung (0): der Planer hält die Untergrenze hart, wie Venediger seit 14.11.2026';
comment on column public.muc_settings.planer_modus is
  'aus = Planer (Regeln, nur Collector) · schatten = KI rechnet mit (Plan nur aufschreiben) · steuern = KI steuert (Collector setzt den Plan um, innerhalb der Regeln). Schaltet nur Uli.';

-- ---------------------------------------------------------------------------
-- 2) Messwerte je Raum (wie Venediger raum_messwerte, SQL 38)
--    MÜNCHEN: Quelle muc_room_readings (jede Minute) → 5-min-Mittel; „heizt“ = Ventil offen; Außentemperatur aus
--    muc_energy_readings.outdoor_c; „unter Eco“ = unter dem Tagesziel (Normal bei „tagsüber heizen“, sonst Untergrenze);
--    „übersteuert“ = Beginn eines Übersteuerns (Modus OVERRIDE) in 24 h.
-- ---------------------------------------------------------------------------
create or replace function public.muc_raum_messwerte(p_tage int default 14)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $function$
  with roh as (
    select room_id, to_timestamp(floor(extract(epoch from ts) / 300) * 300) ts,
           avg(temp) t, bool_or(coalesce(valve, 0) > 0) h, bool_or(mode = 'OVERRIDE') ov
    from muc_room_readings
    where ts > now() - make_interval(days => p_tage) and temp is not null
    group by 1, 2
  ), s0 as (
    select *, lag(h) over (partition by room_id order by ts) hv, lag(ov) over (partition by room_id order by ts) ovv from roh
  ), s as (
    select *, sum(case when h <> coalesce(hv, not h) then 1 else 0 end) over (partition by room_id order by ts) seg from s0
  ), seg as (
    select room_id, seg, min(ts) t0, max(ts) t1, (array_agg(t order by ts))[1] ta
    from s where h group by 1, 2
  ), heiz as (
    select g.room_id, extract(epoch from g.t1 - g.t0) / 3600 + 1 / 12.0 dauer,
           (select max(x.t) from s x where x.room_id = g.room_id and x.ts between g.t0 and g.t1 + interval '90 min') - g.ta anstieg,
           (select avg(x.t) from s x where x.room_id = g.room_id and x.ts between g.t1 + interval '100 min' and g.t1 + interval '140 min') - g.ta bleibt,
           not coalesce((select bool_or(x.h) from s x where x.room_id = g.room_id and x.ts > g.t1 + interval '6 min' and x.ts < g.t1 + interval '4 hours'), true) allein
    from seg g where g.t1 > g.t0
  ), tag as (
    select room_id, (ts at time zone 'Europe/Berlin')::date d, avg(h::int) * 24 heiz_h, avg(t) tin
    from s group by 1, 2
  ), aussen as (
    select (ts at time zone 'Europe/Berlin')::date d, avg(outdoor_c) tout from muc_energy_readings
    where ts > now() - make_interval(days => p_tage + 1) and outdoor_c is not null group by 1
  ), voll as (
    select t.room_id, avg(t.heiz_h) heiz_h, avg(t.tin) tin, avg(a.tout) tout
    from tag t left join aussen a on a.d = t.d
    where t.d < (now() at time zone 'Europe/Berlin')::date group by 1
  ), drei as (
    select x.room_id,
           avg(case when x.t < (case when coalesce(r.heat_day, true) then greatest(r.temp_normal, r.temp_night) else r.temp_night end) - 0.3
                    then 1.0 else 0.0 end)
             filter (where extract(hour from x.ts at time zone 'Europe/Berlin') between 8 and 21) unter_eco,
           avg(x.h::int) * 24 heiz_h
    from s x join muc_rooms r on r.id = x.room_id
    where x.ts > now() - interval '3 days' group by 1
  ), manuell as (
    select room_id, count(*) n from s where ts > now() - interval '24 hours' and ov and not coalesce(ovv, false) group by 1
  )
  select coalesce(jsonb_object_agg(r.id, jsonb_build_object(
      'n_heiz', (select count(*) from heiz h where h.room_id = r.id and h.dauer >= 0.2),
      'auf_k_h', (select round((percentile_cont(0.5) within group (order by h.anstieg / h.dauer))::numeric, 2)
                    from heiz h where h.room_id = r.id and h.dauer >= 0.2),
      'auf_dauer_k_h', (select round((percentile_cont(0.5) within group (order by h.bleibt / h.dauer))::numeric, 2)
                          from heiz h where h.room_id = r.id and h.dauer >= 0.2 and h.allein and h.bleibt is not null),
      'n_dauer', (select count(*) from heiz h where h.room_id = r.id and h.dauer >= 0.2 and h.allein and h.bleibt is not null),
      'heiz_dauer', (select round((percentile_cont(0.5) within group (order by h.dauer))::numeric, 2)
                       from heiz h where h.room_id = r.id and h.dauer >= 0.2),
      'heiz_h_tag', round(v.heiz_h::numeric, 2), 'tin', round(v.tin::numeric, 1), 'tout', round(v.tout::numeric, 1),
      'unter_eco', round(d.unter_eco::numeric, 2), 'heiz_h_3t', round(d.heiz_h::numeric, 2),
      'uebersteuert', coalesce(m.n, 0))), '{}'::jsonb)
  from muc_rooms r
  left join voll v on v.room_id = r.id
  left join drei d on d.room_id = r.id
  left join manuell m on m.room_id = r.id
  where r.enabled;
$function$;

-- ---------------------------------------------------------------------------
-- 3) Cache (wie Venediger SQL 41, hier stündlich)
-- ---------------------------------------------------------------------------
create or replace function public.muc_raum_messwerte_aktualisieren()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  update muc_settings set raum_messwerte_cache = jsonb_build_object('at', now(), 'werte', public.muc_raum_messwerte(14)) where id = 1;
end
$function$;

-- ---------------------------------------------------------------------------
-- 4) Eingaben des Planers (migration-014 + messwerte, pruefung, Regel-Rahmen)
-- ---------------------------------------------------------------------------
create or replace function public.muc_heizplaner_daten(p_tage int default 2)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $function$
  with von as (select now() - make_interval(days => p_tage) as t),
  st as (select * from muc_settings where id = 1),
  letzt as (
    select distinct on (room_id) room_id, temp, valve, ts from muc_room_readings
    where ts > now() - interval '30 minutes' order by room_id, ts desc
  ),
  leistung as (
    select room_id, round(avg(heat_w::numeric / greatest(rooms_heating, 1))) w, count(*) n from muc_heat_runs
    where minutes >= 30 and heat_w > 800 and ended_at > now() - interval '30 days' group by room_id
  )
  select jsonb_build_object(
    'jetzt', extract(epoch from now())::bigint,
    'settings', (select jsonb_build_object('night_start', night_start, 'morning_start', morning_start, 'morning_end', morning_end,
                   'evening_start', evening_start, 'max_grid_circuits', max_grid_circuits, 'battery_kwh', battery_kwh,
                   'baseload_w', baseload_w, 'automation_enabled', automation_enabled, 'planer_modus', planer_modus,
                   'planer_gewicht_ziel', planer_gewicht_ziel, 'planer_gewicht_unter', planer_gewicht_unter,
                   'planer_sicherheit_abstand', planer_sicherheit_abstand,
                   -- 018: Regel-Rahmen wie der Collector (Wartetag, Akku zuerst, Spielraum)
                   'pv_min_soc', pv_min_soc, 'wait_min_kwh', wait_min_kwh, 'seq_on_delta', seq_on_delta) from st),
    'preis', (select jsonb_build_object('grid_ct', grid_ct, 'feed_ct', feed_ct) from muc_prices
              where valid_from <= (now() at time zone 'Europe/Berlin')::date order by valid_from desc limit 1),
    'raeume', (select jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name, 'p', l.w, 'p_n', coalesce(l.n, 0),
                 'prio', r.priority, 'normal', r.temp_normal, 'unter', r.temp_night, 'pv', r.temp_pv, 'pv_prio', r.pv_prio,
                 'morgens', r.heat_morning, 'tags', r.heat_day, 't', x.temp, 'heizt', coalesce(x.valve, 0) > 0,
                 'auto', r.enabled and (select automation_enabled from st),
                 'manuell_bis', case when r.override_temp is not null then r.override_until end) order by r.priority, r.sort)
               from muc_rooms r left join letzt x on x.room_id = r.id left join leistung l on l.room_id = r.id
               where r.enabled),
    'modell', (select jsonb_object_agg(room_id, jsonb_build_object('param', param, 'heiz_std', heiz_std, 'prior', prior)) from muc_heizmodell),
    'pv_modell', (select planer_pv_modell from st),
    'energie15', (select jsonb_agg(jsonb_build_array(b, c, pv, soc, netz) order by b) from (
        select (floor(extract(epoch from ts) / 900) * 900)::bigint b, round(avg(consumption_w)) c, round(avg(pv_w)) pv,
               round(avg(soc)::numeric, 1) soc, round(avg(grid_w)) netz
        from muc_energy_readings, von where ts > von.t group by 1) e),
    'samples15', (select jsonb_object_agg(room_id, arr) from (
        select room_id, jsonb_agg(jsonb_build_array(b, t, h) order by b) arr from (
          select room_id, (floor(extract(epoch from ts) / 900) * 900)::bigint b,
                 round(avg(temp)::numeric, 2) t, round(avg(case when valve > 0 then 1 else 0 end)::numeric, 2) h
          from muc_room_readings, von where ts > von.t - interval '12 hours' and temp is not null group by 1, 2) s group by room_id) z),
    'pv_h', (select jsonb_agg(jsonb_build_array(to_char(h, 'YYYY-MM-DD HH24'), pv) order by h) from (
        select date_trunc('hour', ts at time zone 'Europe/Berlin') h, round(avg(pv_w)) pv
        from muc_energy_readings where ts > now() - make_interval(days => greatest(p_tage, 30)) group by 1) x),
    -- 018: Messwerte (Cache, alle 30 min) und letzter Stand der Plan-Prüfung
    'messwerte', coalesce((select raum_messwerte_cache->'werte' from st), '{}'::jsonb),
    'pruefung', (select planer_pruefung from st)
  );
$function$;

-- ---------------------------------------------------------------------------
-- 5) Rechte, Takt, Erstbefüllung
-- ---------------------------------------------------------------------------
revoke all on function public.muc_raum_messwerte(int) from public, anon, authenticated;
grant execute on function public.muc_raum_messwerte(int) to service_role;
revoke all on function public.muc_raum_messwerte_aktualisieren() from public, anon, authenticated;
grant execute on function public.muc_raum_messwerte_aktualisieren() to service_role;
revoke all on function public.muc_heizplaner_daten(int) from public, anon, authenticated;
grant execute on function public.muc_heizplaner_daten(int) to service_role;

do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'muc-raum-messwerte';
  -- Minute 11, stündlich (Venediger: alle 30 min, dort 8–10 s; hier ~22 s – 14-Tage-Statistik, 1 h Verzug ändert nichts).
  -- Nicht auf den Viertelstunden des Planers, nicht auf Minute 7 (muc-nacht-pruefen, Venediger-Cache).
  perform cron.schedule('muc-raum-messwerte', '11 * * * *', 'select public.muc_raum_messwerte_aktualisieren()');
end $$;

select public.muc_raum_messwerte_aktualisieren();

-- Prüfen:
-- select raum_messwerte_cache->>'at', jsonb_pretty(raum_messwerte_cache->'werte') from muc_settings;
-- select planer_pruefung from muc_settings;
