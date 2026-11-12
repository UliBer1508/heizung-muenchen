-- Heizung München – Migration 014: Auto-Steuerung wie in Venediger (12.11.2026)
-- Konzept: doc/AUTO-STEUERUNG-2026-11-12.md
--
-- Uli, 12.11.2026: „Ich will eine Auto-Steuerung auch in München – wie in Venediger: die Analyse, wie sie ist, und
-- zusätzlich die Auto-Steuerung“ – „In Venediger haben wir Steuerung und Planung in diesem Teil.“
-- Grundregel: aus Venediger übernehmen, nicht neu entwickeln; alles liegt im München-Repo, Venediger wird nicht geändert.
--
-- Übernommen (angepasst auf muc_*-Tabellen):
--   A) Venediger SQL 35 (energie_stunde / energie_tag)  → muc_energie_stunde / muc_energie_tag  (Verlauf und Wirkung)
--   B) Venediger SQL 25 (heizmodell, heizplan, heizplan_vergleich, heizplaner_daten)
--                                                       → muc_heizmodell, muc_heizplan, muc_heizplan_vergleich,
--                                                         muc_heizplaner_daten  (Planer, Edge Function heizplaner-muenchen)
-- Unterschiede nur, wo die Heizart es verlangt:
--   * Heizung = Wärmepumpe (inkl. Warmwasser) = Verbrauch − Auto (evcc) − Grundlast – wie bisher in der Analyse,
--     solange die Wärmepumpe nicht eigens gemessen wird. Auto ist gemessen (evcc), Venediger schätzt es.
--   * „Haus unter Ziel“ statt „unter Eco“: Ziel je Raum nach seinem Profil (morgens/tagsüber Normal, sonst Untergrenze).
--   * Raumleistung für den Planer: aus den gemessenen Heizläufen (muc_heat_runs: Heizstrom ÷ offene Kreise).
--
-- Im Supabase SQL-Editor ausführen, kann gefahrlos mehrfach ausgeführt werden. Ändert nur muc_-Objekte.

-- =====================================================================================================================
-- A) Dauerhafter Energie-Verlauf je Stunde und Tag (Rohdaten bleiben nur 90 Tage)
-- =====================================================================================================================
create table if not exists public.muc_energie_stunde (
  stunde             timestamptz primary key,          -- Beginn der Stunde (UTC)
  pv_kwh             numeric not null default 0,
  verbrauch_kwh      numeric not null default 0,       -- Hausverbrauch laut FENECON (alles)
  heizung_kwh        numeric not null default 0,       -- Wärmepumpe inkl. Warmwasser (geschätzt, siehe oben)
  auto_kwh           numeric not null default 0,       -- evcc
  haus_kwh           numeric not null default 0,       -- Grundlast
  netz_kwh           numeric not null default 0,       -- Bezug
  einspeisung_kwh    numeric not null default 0,
  batt_laden_kwh     numeric not null default 0,
  batt_entladen_kwh  numeric not null default 0,
  netz_batt_leer_kwh numeric not null default 0,       -- Bezug, solange Ladestand ≤ 5 %
  soc_min            numeric,
  soc_max            numeric,
  soc_ende           numeric,
  aussen_c           numeric,
  messwerte          integer not null default 0,
  berechnet_at       timestamptz not null default now()
);

create table if not exists public.muc_energie_tag (
  tag                date primary key,                 -- Münchner Kalendertag
  pv_kwh numeric, verbrauch_kwh numeric, heizung_kwh numeric, auto_kwh numeric, haus_kwh numeric,
  netz_kwh numeric, einspeisung_kwh numeric,
  batt_laden_kwh numeric, batt_entladen_kwh numeric, netz_batt_leer_kwh numeric,
  soc_min numeric, soc_max numeric, aussen_avg numeric,
  raum_h_unter_ziel  numeric,                          -- Raum-Stunden unter Ziel − 0,3 °C, 08–22 Uhr
  planer_netz_kwh    numeric,                          -- Gegenrechnung des Planers bei gleicher Sonne
  bezug_ct numeric, einspeise_ct numeric,              -- an diesem Tag gültiger Preis (muc_prices)
  netz_kosten_eur numeric, einspeise_erloes_eur numeric, grundgebuehr_eur numeric,
  stunden            integer not null default 0,       -- Stunden mit Messwerten (24 = vollständig)
  berechnet_at       timestamptz not null default now()
);

-- Raum-Stunden unter Ziel (08–22 Uhr). Ziel je Raum nach Profil: morgens/tagsüber angehakt → Normal, sonst Untergrenze.
-- Rechnet mit den heutigen Raumeinstellungen.
create or replace function public.muc_raum_h_unter_ziel(p_tag date)
returns numeric
language sql stable security definer set search_path = public as $$
  with b as (select * from muc_day_bounds(p_tag)),
  s as (select morning_start ms, morning_end me, evening_start es from muc_settings where id = 1),
  r as (
    select rr.room_id, rr.temp, to_char(rr.ts at time zone 'Europe/Berlin', 'HH24:MI') hm,
           least(extract(epoch from lead(rr.ts) over (partition by rr.room_id order by rr.ts) - rr.ts), 300) dt
    from muc_room_readings rr, b
    where rr.ts >= b.t0 and rr.ts < b.t1 and rr.temp is not null
  )
  select case when count(*) = 0 then null else round(coalesce(sum(r.dt) filter (where
           r.hm >= '08:00' and r.hm < '22:00' and r.temp < (case
             when (m.heat_morning and r.hm >= s.ms and r.hm < s.me) or (m.heat_day and r.hm >= s.me and r.hm < s.es)
             then m.temp_normal else m.temp_night end) - 0.3), 0) / 3600.0, 1) end
  from r join muc_rooms m on m.id = r.room_id and m.enabled, s
  where r.dt is not null;
$$;

create or replace function public.muc_energie_stunde_rechnen(p_von timestamptz, p_bis timestamptz)
returns integer
language plpgsql security definer set search_path = public as $function$
declare v_n integer;
begin
  with s as (select coalesce(baseload_w, 350) base from muc_settings where id = 1),
  er as (
    select ts, coalesce(pv_w, 0) pv, coalesce(consumption_w, 0) c,
           least(coalesce(car_w, 0), coalesce(consumption_w, 0)) car, coalesce(grid_w, 0) io,
           coalesce(battery_w, 0) bp, soc, outdoor_c,
           least(extract(epoch from lead(ts) over (order by ts) - ts), 300) dt
      from muc_energy_readings
     where ts >= date_trunc('hour', p_von) - interval '10 min' and ts < date_trunc('hour', p_bis) + interval '70 min'
  ), e as (
    select date_trunc('hour', ts) st,
           sum(pv * dt) / 3600000.0 pv, sum(c * dt) / 3600000.0 c, sum(car * dt) / 3600000.0 car,
           sum(greatest(0, c - car - (select base from s)) * dt) / 3600000.0 heiz,
           sum(least((select base from s), greatest(0, c - car)) * dt) / 3600000.0 haus,
           sum(greatest(io, 0) * dt) / 3600000.0 netz, sum(greatest(-io, 0) * dt) / 3600000.0 einsp,
           sum(greatest(-bp, 0) * dt) / 3600000.0 lad, sum(greatest(bp, 0) * dt) / 3600000.0 ent,   -- battery_w: + Entladen
           sum(case when soc <= 5 then greatest(io, 0) * dt else 0 end) / 3600000.0 leer,
           min(soc) smin, max(soc) smax, (array_agg(soc order by ts desc))[1] send, round(avg(outdoor_c), 1) aussen, count(*) n
      from er
     where dt is not null and ts >= date_trunc('hour', p_von) and ts < date_trunc('hour', p_bis) + interval '1 hour'
     group by 1
  )
  insert into muc_energie_stunde as z (stunde, pv_kwh, verbrauch_kwh, heizung_kwh, auto_kwh, haus_kwh, netz_kwh, einspeisung_kwh,
                                       batt_laden_kwh, batt_entladen_kwh, netz_batt_leer_kwh, soc_min, soc_max, soc_ende,
                                       aussen_c, messwerte, berechnet_at)
  select st, round(pv, 3), round(c, 3), round(heiz, 3), round(car, 3), round(haus, 3), round(netz, 3), round(einsp, 3),
         round(lad, 3), round(ent, 3), round(leer, 3), smin, smax, send, aussen, n, now()
    from e
  on conflict (stunde) do update set
    pv_kwh = excluded.pv_kwh, verbrauch_kwh = excluded.verbrauch_kwh, heizung_kwh = excluded.heizung_kwh,
    auto_kwh = excluded.auto_kwh, haus_kwh = excluded.haus_kwh, netz_kwh = excluded.netz_kwh,
    einspeisung_kwh = excluded.einspeisung_kwh, batt_laden_kwh = excluded.batt_laden_kwh,
    batt_entladen_kwh = excluded.batt_entladen_kwh, netz_batt_leer_kwh = excluded.netz_batt_leer_kwh,
    soc_min = excluded.soc_min, soc_max = excluded.soc_max, soc_ende = excluded.soc_ende, aussen_c = excluded.aussen_c,
    messwerte = excluded.messwerte, berechnet_at = now();
  get diagnostics v_n = row_count;
  return v_n;
end $function$;

create or replace function public.muc_energie_tag_rechnen(p_tag date)
returns void
language plpgsql security definer set search_path = public as $function$
declare
  von timestamptz := p_tag::timestamp at time zone 'Europe/Berlin';
  bis timestamptz := (p_tag + 1)::timestamp at time zone 'Europe/Berlin';
  v_bezug numeric; v_einsp numeric; v_gebuehr numeric;
begin
  select grid_ct, feed_ct, base_eur_year into v_bezug, v_einsp, v_gebuehr
    from muc_prices where valid_from <= p_tag order by valid_from desc limit 1;

  insert into muc_energie_tag as z (tag, pv_kwh, verbrauch_kwh, heizung_kwh, auto_kwh, haus_kwh, netz_kwh, einspeisung_kwh,
      batt_laden_kwh, batt_entladen_kwh, netz_batt_leer_kwh, soc_min, soc_max, aussen_avg, raum_h_unter_ziel, planer_netz_kwh,
      bezug_ct, einspeise_ct, netz_kosten_eur, einspeise_erloes_eur, grundgebuehr_eur, stunden, berechnet_at)
  select p_tag, round(sum(s.pv_kwh), 2), round(sum(s.verbrauch_kwh), 2), round(sum(s.heizung_kwh), 2),
         round(sum(s.auto_kwh), 2), round(sum(s.haus_kwh), 2), round(sum(s.netz_kwh), 2), round(sum(s.einspeisung_kwh), 2),
         round(sum(s.batt_laden_kwh), 2), round(sum(s.batt_entladen_kwh), 2), round(sum(s.netz_batt_leer_kwh), 2),
         min(s.soc_min), max(s.soc_max), round(avg(s.aussen_c), 1),
         muc_raum_h_unter_ziel(p_tag),
         (select (planer ->> 'netz_kwh')::numeric from muc_heizplan_vergleich where tag = p_tag),
         v_bezug, v_einsp,
         case when v_bezug is null then null else round(sum(s.netz_kwh) * v_bezug / 100.0, 2) end,
         case when v_einsp is null then null else round(sum(s.einspeisung_kwh) * v_einsp / 100.0, 2) end,
         case when v_gebuehr is null then null else round(v_gebuehr / 365.0, 2) end,
         count(*), now()
    from muc_energie_stunde s where s.stunde >= von and s.stunde < bis
  having count(*) > 0
  on conflict (tag) do update set
    pv_kwh = excluded.pv_kwh, verbrauch_kwh = excluded.verbrauch_kwh, heizung_kwh = excluded.heizung_kwh,
    auto_kwh = excluded.auto_kwh, haus_kwh = excluded.haus_kwh, netz_kwh = excluded.netz_kwh,
    einspeisung_kwh = excluded.einspeisung_kwh, batt_laden_kwh = excluded.batt_laden_kwh,
    batt_entladen_kwh = excluded.batt_entladen_kwh, netz_batt_leer_kwh = excluded.netz_batt_leer_kwh,
    soc_min = excluded.soc_min, soc_max = excluded.soc_max, aussen_avg = excluded.aussen_avg,
    raum_h_unter_ziel = coalesce(excluded.raum_h_unter_ziel, z.raum_h_unter_ziel),   -- Raumdaten nach 90 Tagen weg
    planer_netz_kwh = coalesce(excluded.planer_netz_kwh, z.planer_netz_kwh),
    bezug_ct = excluded.bezug_ct, einspeise_ct = excluded.einspeise_ct, netz_kosten_eur = excluded.netz_kosten_eur,
    einspeise_erloes_eur = excluded.einspeise_erloes_eur, grundgebuehr_eur = excluded.grundgebuehr_eur,
    stunden = excluded.stunden, berechnet_at = now();
end $function$;

-- stündlich: letzte 3 Stunden + heute + gestern (Gegenrechnung des Planers kommt um 03:00 für gestern)
create or replace function public.muc_energie_verlauf_tick()
returns void
language plpgsql security definer set search_path = public as $function$
declare v_heute date := (now() at time zone 'Europe/Berlin')::date;
begin
  perform muc_energie_stunde_rechnen(now() - interval '3 hours', now());
  perform muc_energie_tag_rechnen(v_heute);
  perform muc_energie_tag_rechnen(v_heute - 1);
end $function$;

-- =====================================================================================================================
-- B) Planer (Schattenbetrieb) – Tabellen wie Venediger SQL 25, mit muc_-Präfix
-- =====================================================================================================================
create table if not exists public.muc_heizmodell (
  room_id     text primary key references public.muc_rooms(id) on delete cascade,
  raum        text not null,
  param       jsonb not null,            -- {k, g, s, c, tau}: Auskühlen/h, Aufheizen °C/h, Sonne °C/h/kW, innere Wärme °C/h, Estrich h
  fehler_12h  numeric,                   -- mittlere Abweichung nach 12 h (°C)
  gleich_12h  numeric,                   -- zum Vergleich: Annahme „Temperatur bleibt gleich“
  heiz_std    numeric,                   -- so viele Stunden war das Ventil im Lernzeitraum offen
  prior       boolean not null default false,
  tage        int,
  p_w         numeric,                   -- Strom der Wärmepumpe je offenem Kreis (W), aus muc_heat_runs
  gelernt_at  timestamptz not null default now()
);

create table if not exists public.muc_heizplan (
  id            bigserial primary key,
  erstellt_at   timestamptz not null default now(),
  start_at      timestamptz not null,
  modus         text not null default 'schatten',
  plan          jsonb not null,
  jetzt         jsonb,
  pv_kwh numeric, heiz_kwh numeric, netz_kwh numeric, einspeis_kwh numeric,
  unter_ziel_gradstd numeric, unter_grenze_gradstd numeric,
  nachfuehrung  numeric
);
create index if not exists muc_heizplan_at_idx on public.muc_heizplan (erstellt_at desc);

create table if not exists public.muc_heizplan_vergleich (
  tag               date primary key,
  netz_gemessen_kwh numeric,
  steuerung         jsonb,               -- heutige Steuerung (Collector), im Modell nachgerechnet
  planer            jsonb,               -- Planer bei gleicher Sonne, gleichem Wetter, gleichem Start
  planer_gleich     jsonb,               -- Planer bei gleichem Komfort wie die Steuerung
  modell_abw        numeric,
  erstellt_at       timestamptz not null default now()
);

alter table public.muc_settings add column if not exists planer_modus text not null default 'schatten';
alter table public.muc_settings add column if not exists planer_gewicht_ziel numeric not null default 0.6;
alter table public.muc_settings add column if not exists planer_gewicht_unter numeric not null default 2.0;
alter table public.muc_settings add column if not exists planer_sicherheit_abstand numeric not null default 1.5;
alter table public.muc_settings add column if not exists planer_pv_modell jsonb;
alter table public.muc_settings drop constraint if exists muc_settings_planer_modus_check;
alter table public.muc_settings add constraint muc_settings_planer_modus_check check (planer_modus in ('aus', 'schatten', 'steuern'));
comment on column public.muc_settings.planer_modus is 'Planer: aus | schatten (rechnet und zeigt, steuert nicht). Steuern kommt erst nach Freigabe.';
comment on column public.muc_settings.planer_gewicht_ziel is 'Planer: so viele kWh Netzstrom ist 1 °C·h unter dem Ziel wert.';
comment on column public.muc_settings.planer_gewicht_unter is 'Planer: so viele kWh Netzstrom ist 1 °C·h unter der Untergrenze wert (zusätzlich).';
comment on column public.muc_settings.planer_sicherheit_abstand is 'Planer: so weit unter der Untergrenze darf ein Raum nie fallen (°C).';

-- Alle Eingaben für Lernen und Planen in einem JSON-Wert (wie heizplaner_daten; Wetter holt die Edge Function bei Open-Meteo).
-- Messwerte als Epoch-Sekunden (UTC) auf 15 min; PV je Stunde als Münchner Ortszeit „YYYY-MM-DD HH“.
create or replace function public.muc_heizplaner_daten(p_tage int default 2)
returns jsonb
language sql stable security definer set search_path = public as $$
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
                   'planer_sicherheit_abstand', planer_sicherheit_abstand) from st),
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
        from muc_energy_readings where ts > now() - make_interval(days => greatest(p_tage, 30)) group by 1) x)
  );
$$;

-- =====================================================================================================================
-- Rechte
-- =====================================================================================================================
do $$ declare t text; begin
  foreach t in array array['muc_energie_stunde','muc_energie_tag','muc_heizmodell','muc_heizplan','muc_heizplan_vergleich'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "muc auth read" on public.%I', t);
    execute format('create policy "muc auth read" on public.%I for select to authenticated using (true)', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;
grant usage, select on sequence public.muc_heizplan_id_seq to service_role;

revoke all on function public.muc_raum_h_unter_ziel(date) from public, anon, authenticated;
revoke all on function public.muc_energie_stunde_rechnen(timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.muc_energie_tag_rechnen(date) from public, anon, authenticated;
revoke all on function public.muc_energie_verlauf_tick() from public, anon, authenticated;
revoke all on function public.muc_heizplaner_daten(int) from public, anon, authenticated;
grant execute on function public.muc_heizplaner_daten(int) to service_role;

-- =====================================================================================================================
-- Takt (pg_cron, reines SQL wie muc-ki-tick) und Nachtragen ab dem ältesten Messwert
-- =====================================================================================================================
do $$ begin
  if exists (select 1 from cron.job where jobname = 'muc-energie-verlauf') then perform cron.unschedule('muc-energie-verlauf'); end if;
  perform cron.schedule('muc-energie-verlauf', '9 * * * *', 'select public.muc_energie_verlauf_tick()');
end $$;

do $$
declare d date; v_von date;
begin
  select (min(ts) at time zone 'Europe/Berlin')::date into v_von from muc_energy_readings;
  d := v_von;
  while d is not null and d <= (now() at time zone 'Europe/Berlin')::date loop
    perform muc_energie_stunde_rechnen(d::timestamp at time zone 'Europe/Berlin', (d + 1)::timestamp at time zone 'Europe/Berlin' - interval '1 hour');
    perform muc_energie_tag_rechnen(d);
    d := d + 1;
  end loop;
end $$;

-- Prüfen
select tag, pv_kwh, verbrauch_kwh, heizung_kwh, auto_kwh, netz_kwh, netz_kosten_eur, raum_h_unter_ziel, stunden
from public.muc_energie_tag order by tag desc limit 5;
