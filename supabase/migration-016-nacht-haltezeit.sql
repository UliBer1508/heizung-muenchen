-- Heizung München – Migration 016: Ohne Sonne nur Untergrenze (früh zu), Nacht-Prüfung, Haltezeit (Collector 0.13)
-- Beschreibung: doc/NACHT-UND-HALTEZEIT-2026-11-24.md
-- Vorbild Venediger: SQL 46_haltezeiten.sql (16.11.2026) und 47_nacht_pruefung.sql (17.11.2026)
-- Im Supabase SQL-Editor ausführen, kann gefahrlos mehrfach ausgeführt werden. Ändert nur muc_-Objekte.
--
-- Grundsatz (Uli, 17.11.2026, gilt für beide Häuser): Nachts nur die Untergrenze halten, nie den Estrich laden.
-- Den Estrich laden wir nur tagsüber mit PV-Überschuss.
--
-- Inhalt
--   1. Einstellungen und Messwerte je Raum (Überlauf), Haltezeit
--   2. muc_ueberlauf_lernen()   – wie weit steigt ein Raum nach „Ventil zu“ noch? (stündlich)
--   3. muc_haltezeit_lernen()   – wie lange braucht die Wärmepumpe, bis sie auf einen geöffneten Kreis anspringt? (täglich)
--   4. muc_hin_und_her_tage()   – Befehle und Hin und Her je Tag (App)
--   5. Nacht-Kennzahlen         – muc_room_nights + Spitze über Untergrenze, Ventil offen obwohl warm, Zyklen;
--                                  muc_nacht_haus (Heizstrom je Nacht und Heizgradtag) – muc_nacht_pruefen() stündlich
--   6. KI: Regel 5 „Untergrenze 0,5 °C tiefer?“, Erfolgskontrolle „früh zu“, Nachtzeile im Rückblick (muc_ki_analyse neu)
--   7. Sofort-Hinweis „Ventil offen, obwohl der Raum warm ist“ (muc_ki_tick neu)
--   8. Rechte, Takt, Erstbefüllung

-- ---------------------------------------------------------------------------
-- 1) Spalten
-- ---------------------------------------------------------------------------
alter table public.muc_settings add column if not exists nacht_frueh_aus boolean not null default true;
alter table public.muc_settings add column if not exists nacht_spitze_c numeric(3,2) not null default 0.1
  check (nacht_spitze_c between 0 and 1);
alter table public.muc_settings add column if not exists nacht_frueh_aus_seit timestamptz;
alter table public.muc_settings add column if not exists halte_min_vorgabe integer
  check (halte_min_vorgabe is null or halte_min_vorgabe between 0 and 60);
alter table public.muc_settings add column if not exists halte_min_gelernt integer;
alter table public.muc_settings add column if not exists halte_min_basis integer;
alter table public.muc_settings add column if not exists halte_min_stand timestamptz;

comment on column public.muc_settings.nacht_frueh_aus is 'Ohne Sonne (Nacht, Abend, Wartetag) Ventil früh zu: Ist + gemessener Überlauf ≥ Untergrenze + nacht_spitze_c (Collector 0.13)';
comment on column public.muc_settings.nacht_spitze_c is 'Ohne Sonne höchstens Untergrenze + so viel °C (inkl. Überlauf nach Ventil zu)';
comment on column public.muc_settings.nacht_frueh_aus_seit is 'Seit wann „früh zu“ läuft – Bezug der Erfolgskontrolle in der KI';
comment on column public.muc_settings.halte_min_vorgabe is 'Haltezeit eigene Vorgabe in min (null = gelernter Wert, 0 = aus)';
comment on column public.muc_settings.halte_min_gelernt is 'Haltezeit gelernt (muc_haltezeit_lernen): Median „Kreis auf bei stehender WP → WP läuft“, 5–30 min';

update public.muc_settings set nacht_frueh_aus_seit = now() where id = 1 and nacht_frueh_aus_seit is null;

alter table public.muc_rooms add column if not exists ueberlauf_c numeric(3,2);
alter table public.muc_rooms add column if not exists ueberlauf_n integer;
alter table public.muc_rooms add column if not exists ueberlauf_stand timestamptz;
comment on column public.muc_rooms.ueberlauf_c is 'Gemessener Überlauf: höchste Temperatur nach „Ventil zu“ − Temperatur beim Zumachen (7 Tage, ohne Sonne), 0–1,5 °C';

-- ---------------------------------------------------------------------------
-- 2) Überlauf je Raum lernen (stündlich in muc_nacht_pruefen)
--    Jedes „Ventil auf → zu“ zwischen Abend ab und Morgen bis der letzten 7 Tage.
--    Überlauf = höchste Temperatur bis zum nächsten „Ventil auf“ (höchstens 120 min) − Temperatur beim Zumachen.
--    Gewichtet: neuere Abschaltungen zählen mehr. Ab 3 Abschaltungen gilt der Wert, sonst bleibt der Raum wie bisher.
-- ---------------------------------------------------------------------------
create or replace function public.muc_ueberlauf_lernen()
returns int
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  with s as (
    select coalesce(nullif(evening_start, ''), '17:00')::time e0, coalesce(nullif(morning_end, ''), '09:00')::time m1
      from muc_settings where id = 1
  ), v as (
    select rr.room_id, rr.ts, rr.temp, rr.valve, lag(rr.valve) over (partition by rr.room_id order by rr.ts) pv
      from muc_room_readings rr
     where rr.ts > now() - interval '7 days 3 hours' and rr.temp is not null
  ), c as (
    select v.room_id, v.ts, v.temp
      from v, s
     where v.valve = 0 and v.pv > 0 and v.ts > now() - interval '7 days' and v.ts < now() - interval '30 minutes'
       and ((v.ts at time zone 'Europe/Berlin')::time >= s.e0 or (v.ts at time zone 'Europe/Berlin')::time < s.m1)
  ), x as (
    select c.room_id, c.ts,
           greatest(0, coalesce((select max(r.temp) from muc_room_readings r
                                  where r.room_id = c.room_id and r.ts > c.ts and r.ts <= c.ts + interval '120 minutes'
                                    and r.ts < coalesce((select min(o.ts) from muc_room_readings o
                                                          where o.room_id = c.room_id and o.ts > c.ts
                                                            and o.ts <= c.ts + interval '120 minutes' and o.valve > 0),
                                                        c.ts + interval '121 minutes')), c.temp) - c.temp) u,
           greatest(0.5, 8 - extract(epoch from now() - c.ts) / 86400.0) w
      from c
  ), a as (
    select room_id, count(*)::int n, least(1.5, round(sum(u * w) / sum(w), 2)) ue from x group by room_id
  )
  update muc_rooms ro
     set ueberlauf_n = coalesce(a.n, 0),
         ueberlauf_c = case when coalesce(a.n, 0) >= 3 then a.ue end,
         ueberlauf_stand = now()
    from muc_rooms r2 left join a on a.room_id = r2.id
   where ro.id = r2.id;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- ---------------------------------------------------------------------------
-- 3) Haltezeit lernen (täglich 03:25)
--    München öffnet Ventile, die Wärmepumpe entscheidet selbst, wann sie anläuft (Vorlauf, Heizkurve).
--    Gemessen: Kreis geht auf, während die Wärmepumpe steht (Heizstrom < 300 W) → Minuten, bis sie läuft (> 800 W).
--    Median der letzten 14 Tage, aufgerundet, 5–30 min. Weniger als 20 Messungen: 15 min.
--    Wer einen Kreis schneller wieder schließt, gibt ihn ab, bevor die Wärmepumpe überhaupt darauf reagiert hat.
-- ---------------------------------------------------------------------------
create or replace function public.muc_haltezeit_lernen()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_base int; v_n int; v_med numeric; v_min int;
begin
  select coalesce(baseload_w, 350) into v_base from muc_settings where id = 1;
  create temp table if not exists _muc_hw (m timestamptz primary key, hw numeric) on commit drop;
  truncate _muc_hw;
  insert into _muc_hw
  select date_trunc('minute', ts), avg(greatest(consumption_w - coalesce(car_w, 0) - v_base, 0))
    from muc_energy_readings where ts > now() - interval '14 days 2 hours' group by 1;

  with v as (
    select rr.room_id, rr.ts, rr.valve, lag(rr.valve) over (partition by rr.room_id order by rr.ts) pv
      from muc_room_readings rr where rr.ts > now() - interval '14 days 1 hour'
  ), o as (
    select v.ts, (select h.hw from _muc_hw h where h.m <= v.ts order by h.m desc limit 1) hw0
      from v where v.valve > 0 and coalesce(v.pv, 0) = 0 and v.ts > now() - interval '14 days' and v.ts < now() - interval '90 minutes'
  ), x as (
    select o.ts, (select min(h.m) from _muc_hw h where h.m > o.ts and h.m <= o.ts + interval '90 minutes' and h.hw > 800) won
      from o where o.hw0 < 300
  )
  select count(*) filter (where won is not null),
         percentile_cont(0.5) within group (order by extract(epoch from won - ts) / 60.0) filter (where won is not null)
    into v_n, v_med from x;

  v_min := case when coalesce(v_n, 0) >= 20 then least(30, greatest(5, ceil(v_med)::int)) else 15 end;
  update muc_settings set halte_min_gelernt = v_min, halte_min_basis = coalesce(v_n, 0), halte_min_stand = now() where id = 1;
  return jsonb_build_object('halte_min', v_min, 'messungen', coalesce(v_n, 0), 'median_min', round(v_med, 1));
end $$;

-- ---------------------------------------------------------------------------
-- 4) Hin und Her je Tag: Befehl A → B → A innerhalb 15 min (wie Venediger hin_und_her_tage)
-- ---------------------------------------------------------------------------
create or replace function public.muc_hin_und_her_tage(p_tage int default 7)
returns table (tag date, befehle int, hin_und_her int, anteil numeric, frueh_zu int)
language sql stable security definer set search_path = public as $$
  with c as (
    select d.room_id, d.ts, d.target, d.mode,
           lag(d.target) over p v1, lag(d.target, 2) over p v2, lag(d.ts, 2) over p t2
      from muc_decisions d
     where d.kind = 'write' and not coalesce(d.dry_run, false)
       and d.ts > now() - make_interval(days => greatest(1, least(p_tage, 31)) + 1)
    window p as (partition by d.room_id order by d.ts)
  )
  select (ts at time zone 'Europe/Berlin')::date,
         count(*)::int,
         (count(*) filter (where abs(v2 - target) < 0.05 and abs(v1 - target) >= 0.25 and ts - t2 < interval '15 minutes'))::int,
         round(100.0 * count(*) filter (where abs(v2 - target) < 0.05 and abs(v1 - target) >= 0.25 and ts - t2 < interval '15 minutes')
               / greatest(count(*), 1), 1),
         (count(*) filter (where mode = 'FRUEH_AUS'))::int
    from c
   where ts > now() - make_interval(days => greatest(1, least(p_tage, 31)))
   group by 1 order by 1;
$$;

-- ---------------------------------------------------------------------------
-- 5) Nacht-Kennzahlen
--    Je Raum (Spalten in muc_room_nights): höchste Temperatur, Spitze über Untergrenze, Minuten Ventil offen,
--    obwohl der Raum ≥ 0,3 °C über seinem Sollwert lag, Anzahl „Ventil auf“.
--    Je Haus (muc_nacht_haus): Heizstrom der Nacht (Verbrauch − Auto − Grundlast), davon aus dem Netz,
--    Heizgradtage der Nacht (Σ max(0, 18 − außen) je Minute / 1440), kWh je Heizgradtag, Spitze Ø der Räume,
--    die geheizt haben, „früh zu“ (Befehle).
-- ---------------------------------------------------------------------------
alter table public.muc_room_nights add column if not exists t_max numeric;
alter table public.muc_room_nights add column if not exists peak_over_floor numeric;
alter table public.muc_room_nights add column if not exists valve_warm_min int;
alter table public.muc_room_nights add column if not exists cycles int;

create table if not exists public.muc_nacht_haus (
  night          date primary key,          -- Datum des Abends
  t0             timestamptz,
  t1             timestamptz,
  heat_kwh       numeric,
  heat_grid_kwh  numeric,
  outdoor_avg    numeric,
  hgt            numeric,                   -- Heizgradtage der Nacht (Basis 18 °C)
  kwh_je_hgt     numeric,
  rooms_heated   int,                       -- Räume mit > 30 min Ventil offen und Wärmepumpe an
  peak_avg       numeric,                   -- Ø Spitze über Untergrenze dieser Räume
  frueh_zu       int,                       -- Befehle „früh zu“
  frueh_aus_an   boolean,                   -- Nacht nach Beginn von „früh zu“
  computed_at    timestamptz
);

create or replace function public.muc_nacht_kennzahlen(p_night date)
returns int
language plpgsql security definer set search_path = public as $$
declare v_t0 timestamptz; v_t1 timestamptz; v_base int; v_since timestamptz; v_n int;
begin
  select muc_ki_at(p_night, night_start), muc_ki_at(p_night + 1, morning_start), coalesce(baseload_w, 350), nacht_frueh_aus_seit
    into v_t0, v_t1, v_base, v_since from muc_settings where id = 1;
  if v_t0 is null or v_t1 <= v_t0 or now() < v_t1 then return 0; end if;

  with r as (
    select rr.room_id, rr.ts, rr.temp, rr.setpoint, rr.valve,
           lag(rr.valve) over (partition by rr.room_id order by rr.ts) pv
      from muc_room_readings rr where rr.ts >= v_t0 and rr.ts < v_t1 and rr.temp is not null
  ), a as (
    select room_id, max(temp) t_max,
           count(*) filter (where valve > 0 and setpoint is not null and temp >= setpoint + 0.3)::int warm,
           count(*) filter (where valve > 0 and coalesce(pv, 0) = 0)::int cyc
      from r group by room_id
  )
  update muc_room_nights n
     set t_max = a.t_max, peak_over_floor = round(a.t_max - n.temp_night, 2), valve_warm_min = a.warm, cycles = a.cyc
    from a where n.night = p_night and n.room_id = a.room_id;
  get diagnostics v_n = row_count;

  insert into muc_nacht_haus as h (night, t0, t1, heat_kwh, heat_grid_kwh, outdoor_avg, hgt, kwh_je_hgt,
                                   rooms_heated, peak_avg, frueh_zu, frueh_aus_an, computed_at)
  select p_night, v_t0, v_t1, round(e.heat, 2), round(e.heat_grid, 2), round(e.out_avg, 1), round(e.hgt, 3),
         case when e.hgt >= 0.1 then round(e.heat / e.hgt, 2) end,
         (select count(*) from muc_room_nights n where n.night = p_night and n.heat_min > 30),
         (select round(avg(n.peak_over_floor), 2) from muc_room_nights n where n.night = p_night and n.heat_min > 30),
         (select count(*) from muc_decisions d where d.kind = 'write' and d.mode = 'FRUEH_AUS' and not coalesce(d.dry_run, false)
                                                and d.ts >= v_t0 and d.ts < v_t1),
         v_since is not null and v_t0 >= v_since,
         now()
    from (select sum(greatest(consumption_w - coalesce(car_w, 0) - v_base, 0)) / 60000.0 heat,
                 sum(least(greatest(consumption_w - coalesce(car_w, 0) - v_base, 0), greatest(grid_w, 0))) / 60000.0 heat_grid,
                 avg(outdoor_c) out_avg,
                 sum(greatest(0, 18 - outdoor_c)) / 1440.0 hgt
            from muc_energy_readings where ts >= v_t0 and ts < v_t1) e
  on conflict (night) do update set
    t0 = excluded.t0, t1 = excluded.t1, heat_kwh = excluded.heat_kwh, heat_grid_kwh = excluded.heat_grid_kwh,
    outdoor_avg = excluded.outdoor_avg, hgt = excluded.hgt, kwh_je_hgt = excluded.kwh_je_hgt,
    rooms_heated = excluded.rooms_heated, peak_avg = excluded.peak_avg, frueh_zu = excluded.frueh_zu,
    frueh_aus_an = excluded.frueh_aus_an, computed_at = excluded.computed_at;
  return v_n;
end $$;

-- Stündlich (Minute 7): letzte zwei Nächte (Raum + Haus) und den Überlauf neu rechnen
create or replace function public.muc_nacht_pruefen()
returns text
language plpgsql security definer set search_path = public as $$
declare d date; n int := 0; u int;
begin
  for d in select generate_series(muc_ki_today() - 2, muc_ki_today() - 1, interval '1 day')::date loop
    perform muc_room_night_calc(d);
    n := n + muc_nacht_kennzahlen(d);
  end loop;
  u := muc_ueberlauf_lernen();
  return format('Nächte: %s Raumzeilen · Überlauf: %s Räume', n, u);
end $$;

-- ---------------------------------------------------------------------------
-- 6) KI-Analyse neu: Regel 5 (Untergrenze 0,5 °C tiefer?), Nachtzeile, Erfolgskontrolle „früh zu“
--    Gleich wie migration-007 bis auf die mit „migration-016“ markierten Stellen.
-- ---------------------------------------------------------------------------
create or replace function public.muc_ki_analyse(p_day date default null)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_day   date := coalesce(p_day, muc_ki_today() - 1);
  v_run   date := v_day + 1;
  v_from  date := v_day - 6;               -- 7 Tage
  r record; x record;
  v_cnt int := 0; v_cfg int := 0; v_info int := 0; v_hint int; v_new numeric; v_cap numeric;
  v_sum text; v_stats jsonb; v_feed numeric; v_heat numeric; v_ds record; v_nights text; v_cold text; v_missing int; v_n_rooms int;
  -- ab migration-016: Nacht
  v_nh record; v_since timestamptz; v_night_h numeric; v_wa record; v_wb record; v_verdict text; v_wirk text;
begin
  -- a) Nächte der letzten 8 Tage (neu) rechnen
  perform muc_room_nights_rebuild(v_day - 7, v_day);

  -- b) Offene Vorschläge, deren Ausgangswert nicht mehr stimmt → veraltet
  update muc_ki_suggestions s set status = 'veraltet', decided_at = now(),
         note = 'Wert wurde inzwischen anders eingestellt'
    from muc_rooms ro
   where s.status = 'offen' and s.kind in ('vorschlag', 'ruecknahme') and ro.id = s.room_id
     and s.old_value is distinct from (case s.param when 'temp_night' then ro.temp_night else ro.temp_pv end);

  -- c) Tageswerte der letzten 7 Tage
  create temp table if not exists _muc_days (day date, room_id text, n int, cold_min int, warm_min int, pv_min int,
                                             pv_reached boolean, t_morning numeric, t_max numeric, valve_min int, feed numeric, heat numeric) on commit drop;
  truncate _muc_days;
  for x in select generate_series(v_from, v_day, interval '1 day')::date d loop
    select coalesce(ds.feed_kwh, sm.feed_kwh), coalesce(ds.heat_kwh, sm.heat_kwh) into v_feed, v_heat
      from (select 1) one
      left join muc_daily_stats ds on ds.day = x.d
      left join lateral (select * from muc_day_summary(x.d) limit 1) sm on ds.day is null;
    insert into _muc_days select x.d, t.*, v_feed, v_heat from muc_ki_room_day(x.d) t;
  end loop;

  -- d) Wirkungsberichte (3 Tage nach dem Übernehmen)
  for r in
    select s.*, ro.name, ro.temp_night cur_night, ro.temp_pv cur_pv
      from muc_ki_suggestions s join muc_rooms ro on ro.id = s.room_id
     where s.status in ('genehmigt', 'geaendert') and s.kind = 'vorschlag'
       and s.check_after is not null and s.check_after <= v_run and s.effect_at is null
  loop
    declare
      d0 date := (r.decided_at at time zone 'Europe/Berlin')::date;
      hb numeric; ha numeric; cb numeric; ca numeric; verdict text; worse boolean;
    begin
      select avg(heat_min) filter (where night between d0 - 3 and d0 - 1),
             avg(heat_min) filter (where night between d0 and d0 + 2)
        into hb, ha from muc_room_nights where room_id = r.room_id and n > 0;
      select avg(t.cold_min) into cb from generate_series(d0 - 3, d0 - 1, interval '1 day') g(d), muc_ki_room_day(g.d::date) t where t.room_id = r.room_id;
      select avg(t.cold_min) into ca from generate_series(d0 + 1, d0 + 3, interval '1 day') g(d), muc_ki_room_day(g.d::date) t where t.room_id = r.room_id;
      worse := coalesce(ca, 0) - coalesce(cb, 0) > 60;
      verdict := case
        when worse then 'schlechter: der Raum lag danach deutlich länger unter Soll'
        when ha is not null and hb is not null and ha < hb - 15 then 'wie erwartet: nachts weniger nachgeheizt'
        else 'keine klare Wirkung erkennbar (Wetter und Sonne waren anders)' end;
      update muc_ki_suggestions set effect_at = now(),
             effect_text = format('%s: %s. Nachts nachgeheizt vorher Ø %s min, nachher Ø %s min. Unter Soll tagsüber vorher Ø %s min, nachher Ø %s min.',
                                  r.name, verdict, muc_ki_num(hb, 0), muc_ki_num(ha, 0), muc_ki_num(cb, 0), muc_ki_num(ca, 0))
       where id = r.id;
      if worse and muc_ki_allowed('ruecknahme', r.room_id, 7)
         and (case r.param when 'temp_night' then r.cur_night else r.cur_pv end) = r.decided_value then
        insert into muc_ki_suggestions (day, kind, rule, room_id, param, old_value, new_value, title, what, why, effect, days, parent_id, evidence)
        values (v_run, 'ruecknahme', 'ruecknahme', r.room_id, r.param, r.decided_value, r.old_value,
                format('%s: Änderung zurücknehmen?', r.name),
                format('%s %s → %s °C (wie vorher)', case r.param when 'temp_night' then 'Absenk' else 'PV-Laden' end,
                       muc_ki_num(r.decided_value), muc_ki_num(r.old_value)),
                format('Seit der Änderung lag der Raum tagsüber im Schnitt %s min unter Soll, vorher %s min.', muc_ki_num(ca, 0), muc_ki_num(cb, 0)),
                'Der alte Wert war wärmer – zurück auf den bewährten Stand.', 3, r.id,
                jsonb_build_object('heat_before', hb, 'heat_after', ha, 'cold_before', cb, 'cold_after', ca));
        v_cnt := v_cnt + 1;
      end if;
    end;
  end loop;

  -- e) Regeln je Raum
  select nacht_frueh_aus_seit, extract(epoch from muc_ki_at(v_day + 1, morning_start) - muc_ki_at(v_day, night_start)) / 3600.0
    into v_since, v_night_h from muc_settings where id = 1;
  v_night_h := greatest(coalesce(v_night_h, 8), 1);
  for r in
    select ro.*, m.nights, m.drop_med, m.k_p75, m.heated7, m.heat_min7, m.nights7,
           (select count(*) from _muc_days d where d.room_id = ro.id and d.cold_min > 120 and d.heat >= 3) cold_days,
           (select round(avg(d.cold_min) filter (where d.cold_min > 120) / 60.0, 1) from _muc_days d where d.room_id = ro.id and d.heat >= 3) cold_h,
           (select count(*) from _muc_days d where d.room_id = ro.id and d.feed >= 2 and d.heat >= 3 and d.pv_reached) pv_full_days,
           (select string_agg(muc_ki_day(d.day), ', ' order by d.day) from _muc_days d where d.room_id = ro.id and d.feed >= 2 and d.heat >= 3 and d.pv_reached) pv_full_list,
           (select count(distinct d.day) from _muc_days d where d.feed >= 2 and d.heat >= 3) sunny_days,
           (select count(*) from muc_room_nights n where n.room_id = ro.id and n.night between v_from - 1 and v_day and n.heat_min > 30) night_heat_n,
           (select round(avg(n.heat_min) filter (where n.heat_min > 30)) from muc_room_nights n where n.room_id = ro.id and n.night between v_from - 1 and v_day) night_heat_avg,
           (select count(*) from muc_room_nights n where n.room_id = ro.id and n.night between v_from - 1 and v_day and n.n > 0) nights_seen,
           -- R5: Nächte mit Heizen (> 30 min), die morgens trotzdem auf der Untergrenze endeten (migration-016)
           (select count(*) from muc_room_nights n where n.room_id = ro.id and n.night between v_from - 1 and v_day
               and n.heat_min > 30 and n.t_end is not null and n.t_end <= ro.temp_night + 0.3) night_floor_n,
           (select round(avg(n.heat_min)) from muc_room_nights n where n.room_id = ro.id and n.night between v_from - 1 and v_day
               and n.heat_min > 30 and n.t_end is not null and n.t_end <= ro.temp_night + 0.3) night_floor_min,
           (select round(avg(n.peak_over_floor), 1) from muc_room_nights n where n.room_id = ro.id and n.night between v_from - 1 and v_day
               and n.heat_min > 30) night_peak
      from muc_rooms ro left join muc_room_model() m on m.room_id = ro.id
     where ro.enabled
     order by ro.sort
  loop
    -- R1 Einstellungsfehler: Absenk ≥ Normal → Absenk = Normal − 1 (Ulis Regel, 05.11.2026)
    if r.temp_night >= r.temp_normal and muc_ki_allowed('absenk_fehlt', r.id, 30) then
      v_new := greatest(r.temp_normal - 1, r.min_temp);
      insert into muc_ki_suggestions (day, kind, rule, room_id, param, old_value, new_value, title, what, why, effect, days, evidence)
      values (v_run, 'vorschlag', 'absenk_fehlt', r.id, 'temp_night', r.temp_night, v_new,
              case when r.temp_night > r.temp_normal then format('%s: Absenk liegt über Normal – vertauscht?', r.name)
                   else format('%s: nachts 1 °C absenken?', r.name) end,
              format('Absenk %s → %s °C (Normal bleibt %s °C)', muc_ki_num(r.temp_night), muc_ki_num(v_new), muc_ki_num(r.temp_normal)),
              case when r.temp_night > r.temp_normal then
                     format('Absenk (%s °C) ist höher als Normal (%s °C). Nachts wird der Raum damit wärmer gehalten als tagsüber. Ist eigentlich Normal zu niedrig, stell Normal selbst höher.',
                            muc_ki_num(r.temp_night), muc_ki_num(r.temp_normal))
                   when r.night_heat_n > 0 then
                     format('Absenk und Normal sind gleich (%s °C). Der Raum wird deshalb nachts schon nachgeheizt, wenn er wenige Zehntelgrad abkühlt – gemessen in %s von %s der letzten Nächte, im Schnitt %s min.',
                            muc_ki_num(r.temp_normal), r.night_heat_n, r.nights_seen, r.night_heat_avg)
                   else format('Absenk und Normal sind gleich (%s °C). Damit heizt die Wärmepumpe nachts nach, sobald der Raum wenige Zehntelgrad abkühlt. In den letzten Nächten kam das noch nicht vor – der Vorschlag folgt deiner Regel „Absenk = Normal − 1 °C“.',
                            muc_ki_num(r.temp_normal))
              end,
              case when r.nights >= 3 then
                     format('Gemessen kühlt der Raum ohne Heizen pro Nacht etwa %s °C ab. 1 °C Puffer reicht, damit die Wärmepumpe nachts meist aus bleibt und der Estrich die Nacht überbrückt. Morgens ist der Raum dafür bis zu 1 °C kühler, bis die Heizzeit beginnt.',
                            muc_ki_num(r.drop_med))
                   else 'Mit 1 °C Puffer überbrückt der Estrich die Nacht, die Wärmepumpe bleibt nachts meist aus. Morgens ist der Raum dafür bis zu 1 °C kühler, bis die Heizzeit beginnt.'
              end,
              r.nights_seen, jsonb_build_object('nights_heated', r.night_heat_n, 'nights_seen', r.nights_seen, 'heat_min_avg', r.night_heat_avg, 'drop_med', r.drop_med));
      v_cfg := v_cfg + 1;
      continue;
    end if;

    -- R5 Nacht (wie Venediger Regel 5, 17.11.2026): nachts geheizt, nur um die Untergrenze zu halten, und morgens
    --    trotzdem wieder auf der Untergrenze → Untergrenze 0,5 °C tiefer? Nicht unter Normal − 2. Uli genehmigt.
    if r.temp_night < r.temp_normal and r.night_floor_n >= 3 and v_cnt < 3
       and r.temp_night - 0.5 >= greatest(r.temp_normal - 2, r.min_temp, 5)
       and muc_ki_allowed('nacht_untergrenze', r.id, 7) then
      insert into muc_ki_suggestions (day, kind, rule, room_id, param, old_value, new_value, title, what, why, effect, days, evidence)
      values (v_run, 'vorschlag', 'nacht_untergrenze', r.id, 'temp_night', r.temp_night, r.temp_night - 0.5,
              format('%s: Untergrenze 0,5 °C tiefer?', r.name),
              format('Untergrenze %s → %s °C (Normal bleibt %s °C)', muc_ki_num(r.temp_night), muc_ki_num(r.temp_night - 0.5), muc_ki_num(r.temp_normal)),
              format('In %s der letzten %s Nächte hat die Wärmepumpe den Raum nachts geheizt (im Schnitt %s min), nur um die Untergrenze zu halten – morgens lag er trotzdem wieder auf der Untergrenze.%s',
                     r.night_floor_n, r.nights_seen, r.night_floor_min,
                     coalesce(format(' Spitze über der Untergrenze im Schnitt %s °C.', muc_ki_num(r.night_peak)), '')),
              case when r.nights >= 3 and r.drop_med > 0.05 then
                     format('Ohne Heizen kühlt der Raum gemessen etwa %s °C pro Nacht ab – 0,5 °C tiefer heißt grob %s h länger ohne Nachheizen. Morgens ist er dafür bis zu 0,5 °C kühler, bis die Heizzeit beginnt. Grundsatz: nachts nur die Untergrenze halten, den Estrich laden wir mit Sonne.',
                            muc_ki_num(r.drop_med), muc_ki_num(least(v_night_h, 0.5 * v_night_h / r.drop_med), 0))
                   else 'Nachts weniger Netzstrom für die Wärmepumpe. Morgens ist der Raum dafür bis zu 0,5 °C kühler, bis die Heizzeit beginnt. Grundsatz: nachts nur die Untergrenze halten, den Estrich laden wir mit Sonne.'
              end,
              r.night_floor_n, jsonb_build_object('nights_floor', r.night_floor_n, 'nights_seen', r.nights_seen,
                                                  'heat_min_avg', r.night_floor_min, 'peak', r.night_peak, 'drop_med', r.drop_med));
      v_cnt := v_cnt + 1;
      continue;
    end if;

    -- R3 Estrich laden: an ≥ 3 Sonnentagen PV-Wert erreicht, trotzdem ≥ 2 kWh eingespeist → PV-Laden + 0,5
    if r.pv_prio > 0 and r.pv_full_days >= 3 and v_cnt < 3 then
      v_cap := least(r.temp_normal + 2, r.max_temp, 26);
      if r.temp_pv + 0.5 <= v_cap and muc_ki_allowed('estrich_mehr', r.id, 7) then
        insert into muc_ki_suggestions (day, kind, rule, room_id, param, old_value, new_value, title, what, why, effect, days, evidence)
        values (v_run, 'vorschlag', 'estrich_mehr', r.id, 'temp_pv', r.temp_pv, r.temp_pv + 0.5,
                format('%s: mit Sonne etwas mehr laden?', r.name),
                format('PV-Laden %s → %s °C', muc_ki_num(r.temp_pv), muc_ki_num(r.temp_pv + 0.5)),
                format('An %s Sonnentagen (%s) hat der Raum seinen PV-Wert erreicht, und trotzdem gingen jeweils mindestens 2 kWh ins Netz.', r.pv_full_days, r.pv_full_list),
                'Mehr Sonnenwärme im Estrich, die abends und nachts nachwirkt – weniger Netzstrom für die Heizung. Der Raum wird an Sonnentagen bis zu 0,5 °C wärmer.',
                r.pv_full_days, jsonb_build_object('days', r.pv_full_list));
        v_cnt := v_cnt + 1;
        continue;
      end if;
    end if;

    -- R2 Nacht reicht nicht: an ≥ 3 Nächten > 30 min nachgeheizt (obwohl Absenk < Normal)
    if r.temp_night < r.temp_normal and r.night_heat_n >= 3 then
      if r.pv_prio > 0 and r.sunny_days >= 2 and v_cnt < 3 and r.temp_pv + 0.5 <= least(r.temp_normal + 2, r.max_temp, 26)
         and muc_ki_allowed('nacht_nachgeheizt', r.id, 7) and muc_ki_allowed('estrich_mehr', r.id, 7) then
        insert into muc_ki_suggestions (day, kind, rule, room_id, param, old_value, new_value, title, what, why, effect, days, evidence)
        values (v_run, 'vorschlag', 'nacht_nachgeheizt', r.id, 'temp_pv', r.temp_pv, r.temp_pv + 0.5,
                format('%s: tagsüber mehr Wärme speichern?', r.name),
                format('PV-Laden %s → %s °C', muc_ki_num(r.temp_pv), muc_ki_num(r.temp_pv + 0.5)),
                format('In %s der letzten %s Nächte wurde der Raum nachgeheizt (im Schnitt %s min). Der Estrich reicht nicht über die Nacht.',
                       r.night_heat_n, r.nights_seen, r.night_heat_avg),
                'An Sonnentagen mehr Wärme in den Estrich – nachts weniger Netzstrom. An trüben Tagen ändert sich nichts.',
                r.night_heat_n, jsonb_build_object('nights_heated', r.night_heat_n, 'heat_min_avg', r.night_heat_avg));
        v_cnt := v_cnt + 1;
      elsif muc_ki_allowed('nacht_nachgeheizt_info', r.id, 7) then
        insert into muc_ki_suggestions (day, kind, rule, room_id, title, why, days, evidence, status)
        values (v_run, 'info', 'nacht_nachgeheizt_info', r.id,
                format('%s wird nachts nachgeheizt', r.name),
                format('In %s der letzten %s Nächte (im Schnitt %s min). Ohne Sonne lässt sich der Estrich tagsüber nicht vorladen – das ist dann normal. Bleibt es so, Absenk prüfen.',
                       r.night_heat_n, r.nights_seen, r.night_heat_avg),
                r.night_heat_n, jsonb_build_object('nights_heated', r.night_heat_n), 'erledigt');
        v_info := v_info + 1;
      end if;
    end if;

    -- R4 Beobachtung: an ≥ 3 Tagen > 2 h unter Soll, obwohl der Raum warm sein sollte
    if r.cold_days >= 3 and muc_ki_allowed('zu_kalt', r.id, 7) then
      insert into muc_ki_suggestions (day, kind, rule, room_id, title, why, days, evidence, status)
      values (v_run, 'info', 'zu_kalt', r.id,
              format('%s erreicht seinen Sollwert nicht', r.name),
              format('An %s der letzten 7 Tage lag der Raum während seiner Heizzeit mehr als 2 h unter Soll (im Schnitt %s h). Mögliche Ursachen: Wärmepumpe lieferte nicht, Ventil oder Heizkreis. Einen Wert ändert die KI dafür nicht.',
                     r.cold_days, muc_ki_num(r.cold_h)),
              r.cold_days, jsonb_build_object('cold_days', r.cold_days, 'cold_h', r.cold_h), 'erledigt');
      v_info := v_info + 1;
    end if;
  end loop;

  -- f) Rückblick auf gestern
  select * into v_ds from muc_daily_stats where day = v_day;
  if not found then select * into v_ds from muc_day_summary(v_day) limit 1; end if;
  select string_agg(format('%s %s min', ro.name, n.heat_min), ', ' order by n.heat_min desc)
    into v_nights
    from (select * from muc_room_nights where night = v_day and heat_min > 30 order by heat_min desc limit 3) n
    join muc_rooms ro on ro.id = n.room_id;
  select string_agg(format('%s %s h', ro.name, muc_ki_num(d.cold_min / 60.0)), ', ' order by d.cold_min desc)
    into v_cold
    from (select * from _muc_days where day = v_day and cold_min > 60 order by cold_min desc limit 3) d
    join muc_rooms ro on ro.id = d.room_id;
  select count(*) into v_hint from muc_ki_suggestions where kind = 'hinweis' and status = 'offen';
  select count(*) into v_n_rooms from muc_rooms where enabled;
  select v_n_rooms - count(*) into v_missing from _muc_days where day = v_day and n >= 576;

  v_sum := format('%s: außen Ø %s °C, Sonne %s kWh, davon %s kWh ins Netz. Wärmepumpe ca. %s kWh, davon %s kWh aus dem Netz.',
                  muc_ki_day(v_day), muc_ki_num(v_ds.outdoor_avg), muc_ki_num(v_ds.pv_kwh), muc_ki_num(v_ds.feed_kwh),
                  muc_ki_num(v_ds.heat_kwh), muc_ki_num(v_ds.heat_grid_kwh))
        || case when v_cold is not null then ' Unter Soll: ' || v_cold || '.' else ' Alle Räume lagen in ihrer Heizzeit im Rahmen.' end
        || case when v_nights is not null then ' Letzte Nacht nachgeheizt: ' || v_nights || '.' else ' Letzte Nacht wurde kein Raum nachgeheizt.' end
        || case when coalesce(v_ds.heat_kwh, 0) < 3 and coalesce(v_ds.outdoor_avg, 0) < 15 then ' Die Wärmepumpe hat praktisch nicht geheizt.' else '' end
        || case when v_missing > 0 then format(' Für %s von %s Räumen fehlen Messwerte – die Aussagen dazu sind unvollständig.', v_missing, v_n_rooms) else '' end;

  -- g) Nacht (migration-016): Rückblick und Erfolgskontrolle „früh zu“
  select * into v_nh from muc_nacht_haus where night = v_day;
  if found and v_nh.heat_kwh is not null then
    v_sum := v_sum || format(' Nacht: Wärmepumpe ca. %s kWh (%s kWh aus dem Netz)%s%s.',
                             muc_ki_num(v_nh.heat_kwh), muc_ki_num(v_nh.heat_grid_kwh),
                             case when coalesce(v_nh.rooms_heated, 0) > 0
                                  then format(', %s Räume nachgeheizt, Spitze über der Untergrenze Ø %s °C', v_nh.rooms_heated, muc_ki_num(v_nh.peak_avg))
                                  else ', kein Raum nachgeheizt' end,
                             case when coalesce(v_nh.frueh_zu, 0) > 0 then format(', %s× früh zu', v_nh.frueh_zu) else '' end);
  end if;
  if v_since is not null then
    select count(*) n, avg(peak_avg) p, avg(kwh_je_hgt) k into v_wa
      from muc_nacht_haus where frueh_aus_an and night <= v_day and heat_kwh is not null;
    select count(*) n, avg(peak_avg) p, avg(kwh_je_hgt) k into v_wb
      from muc_nacht_haus where not frueh_aus_an and heat_kwh is not null
       and night >= (v_since at time zone 'Europe/Berlin')::date - 8 and night < (v_since at time zone 'Europe/Berlin')::date;
    if v_wa.n > 0 and v_wa.n < 3 then
      v_wirk := format('„Früh zu“ seit %s: %s %s gemessen, Urteil nach 3 Nächten.', to_char(v_since at time zone 'Europe/Berlin', 'DD.MM.'),
                       v_wa.n, case when v_wa.n = 1 then 'Nacht' else 'Nächte' end);
    elsif v_wa.n >= 3 and v_wb.n >= 3 then
      v_verdict := case
        when v_wa.k > v_wb.k * 1.10 then 'schlechter'
        when v_wa.p <= v_wb.p - 0.15 and v_wa.k <= v_wb.k * 1.05 then 'wirkt'
        else 'keine klare Wirkung' end;
      v_wirk := format('„Früh zu“ %s: Spitze über der Untergrenze Ø %s °C (vorher %s °C), Heizstrom nachts %s kWh je Heizgradtag (vorher %s) – %s Nächte gegen %s Nächte davor.',
                       v_verdict, muc_ki_num(v_wa.p, 2), muc_ki_num(v_wb.p, 2), muc_ki_num(v_wa.k), muc_ki_num(v_wb.k), v_wa.n, v_wb.n)
                || case when v_verdict = 'schlechter' then ' Abschalten: Einstellungen › Nacht und Haltezeit › „Ohne Sonne früh zu“.' else '' end;
      if muc_ki_allowed('nacht_frueh_aus_wirkung', null, 7) then
        insert into muc_ki_suggestions (day, kind, rule, title, why, days, evidence, status)
        values (v_run, 'info', 'nacht_frueh_aus_wirkung', format('Erfolgskontrolle „früh zu“: %s', v_verdict), v_wirk, v_wa.n,
                jsonb_build_object('nachher', to_jsonb(v_wa), 'vorher', to_jsonb(v_wb)), 'erledigt');
      end if;
    end if;
    if v_wirk is not null then v_sum := v_sum || ' ' || v_wirk; end if;
  end if;

  v_stats := jsonb_build_object('outdoor_avg', v_ds.outdoor_avg, 'pv_kwh', v_ds.pv_kwh, 'feed_kwh', v_ds.feed_kwh,
                                'heat_kwh', v_ds.heat_kwh, 'heat_grid_kwh', v_ds.heat_grid_kwh,
                                'suggestions', v_cnt + v_cfg, 'infos', v_info, 'hints_open', v_hint, 'rooms_missing', v_missing,
                                'night_heat_kwh', v_nh.heat_kwh, 'night_heat_grid_kwh', v_nh.heat_grid_kwh, 'night_peak', v_nh.peak_avg,
                                'night_frueh_zu', v_nh.frueh_zu, 'frueh_aus_wirkung', v_wirk);

  insert into muc_ki_runs (day, summary, stats, result, created_at)
  values (v_run, v_sum, v_stats, format('%s Vorschläge, %s Infos', v_cnt + v_cfg, v_info), now())
  on conflict (day) do update set summary = excluded.summary, stats = excluded.stats, result = excluded.result, created_at = now();

  return v_sum;
end $$;


-- ---------------------------------------------------------------------------
-- 7) Sofort-Hinweis: Ventil offen, obwohl der Raum warm ist (migration-016)
--    Befund 24.11.2026: EG Wohnzimmer hat seit 06.11. rund um die Uhr ein offenes Ventil – auch bei 0,5–1 °C über dem
--    Sollwert. Der Kreis heizt dann nachts den Estrich und belegt einen der Kreise der Netzgrenze.
--    Bedingung: in den letzten 2 h ≥ 90 % der Messungen Ventil offen UND im Schnitt ≥ 0,5 °C über dem Sollwert.
-- ---------------------------------------------------------------------------
create or replace function public.muc_ki_hints_ventil()
returns int
language plpgsql security definer set search_path = public as $$
declare v_list text; v_n int;
begin
  select string_agg(format('%s (%s °C bei Soll %s °C)', ro.name, muc_ki_num(q.t), muc_ki_num(q.sp)), ', ' order by ro.sort), count(*)
    into v_list, v_n
    from (select rr.room_id, avg(rr.temp) t, avg(rr.setpoint) sp
            from muc_room_readings rr where rr.ts > now() - interval '2 hours' and rr.temp is not null and rr.setpoint is not null
           group by rr.room_id
          having count(*) >= 90 and avg((rr.valve > 0)::int) >= 0.9 and avg(rr.temp - rr.setpoint) >= 0.5) q
    join muc_rooms ro on ro.id = q.room_id
   where ro.enabled;
  perform muc_ki_hint('ventil_offen_warm', 'Ventil bleibt offen, obwohl der Raum warm ist',
    format('Seit mindestens 2 Stunden ist das Ventil offen, obwohl der Raum über seinem Sollwert liegt: %s. Loxone schließt es nicht – der Kreis heizt weiter (auch nachts) und belegt einen Kreis der Netzgrenze.', v_list),
    'In Loxone Config prüfen: Raumregler dieses Raums (Betriebsart, Fühler, Ventilausgang), Stellantrieb am Heizkreisverteiler.',
    coalesce(v_n, 0) > 0, 'Ventile schließen wieder');
  return coalesce(v_n, 0);
end $$;

create or replace function public.muc_ki_tick()
returns text
language plpgsql security definer set search_path = public as $$
declare v_hints int; v_pred int; v_res text := null; v_today date := muc_ki_today(); v_me timestamptz;
begin
  perform muc_ki_hints_ventil();
  v_hints := muc_ki_hints_check();
  v_pred := muc_ki_store_predictions();
  select muc_ki_at(v_today, morning_end) into v_me from muc_settings where id = 1;
  if now() >= v_me and not exists (select 1 from muc_ki_runs where day = v_today) then
    perform muc_nacht_pruefen();   -- Nacht-Kennzahlen frisch, bevor die Analyse sie liest
    v_res := muc_ki_analyse(v_today - 1);
  end if;
  return format('Hinweise offen: %s · Vorhersagen: %s%s', v_hints, v_pred, coalesce(' · Analyse: ' || v_res, ''));
end $$;

-- ---------------------------------------------------------------------------
-- 8) Rechte, Takt, Erstbefüllung
-- ---------------------------------------------------------------------------
alter table public.muc_nacht_haus enable row level security;
drop policy if exists "muc auth read" on public.muc_nacht_haus;
create policy "muc auth read" on public.muc_nacht_haus for select to authenticated using (true);
grant select on public.muc_nacht_haus to authenticated;
grant all on public.muc_nacht_haus to service_role;

do $$
declare f text;
begin
  foreach f in array array[
    'muc_ueberlauf_lernen()', 'muc_haltezeit_lernen()', 'muc_nacht_kennzahlen(date)', 'muc_nacht_pruefen()',
    'muc_ki_hints_ventil()', 'muc_ki_tick()', 'muc_ki_analyse(date)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
  execute 'revoke all on function public.muc_hin_und_her_tage(int) from public, anon';
  execute 'grant execute on function public.muc_hin_und_her_tage(int) to authenticated, service_role';
end $$;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'muc-nacht-pruefen') then perform cron.unschedule('muc-nacht-pruefen'); end if;
  perform cron.schedule('muc-nacht-pruefen', '7 * * * *', 'select public.muc_nacht_pruefen()');
  if exists (select 1 from cron.job where jobname = 'muc-haltezeit-lernen') then perform cron.unschedule('muc-haltezeit-lernen'); end if;
  perform cron.schedule('muc-haltezeit-lernen', '25 2 * * *', 'select public.muc_haltezeit_lernen()');   -- 03:25 Berlin (Winterzeit)
end $$;

-- Nächte der letzten 14 Tage nachrechnen (Vergleichsbasis der Erfolgskontrolle), Überlauf und Haltezeit lernen
select public.muc_room_nights_rebuild(public.muc_ki_today() - 14, public.muc_ki_today() - 1);
select count(*) as naechte_haus from (
  select public.muc_nacht_kennzahlen(g::date) from generate_series(public.muc_ki_today() - 14, public.muc_ki_today() - 1, interval '1 day') g
) q;
select public.muc_ueberlauf_lernen() as ueberlauf_raeume;
select public.muc_haltezeit_lernen() as haltezeit;
select id, name, ueberlauf_c, ueberlauf_n from public.muc_rooms where enabled order by sort;
