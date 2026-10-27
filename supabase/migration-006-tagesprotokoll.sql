-- Heizung München – Migration 006: Tagesprotokoll und Prognose-Treffsicherheit (Collector 0.6)
-- Voraussetzung: migration-002 bis -005. Im Supabase SQL-Editor ausführen,
-- kann gefahrlos mehrfach ausgeführt werden. Ändert nur muc_-Objekte, Venediger bleibt unberührt.
--
-- Stufe A der vorausschauenden Steuerung (Phase 5, Schritt 2) – noch OHNE Eingriff in die Steuerung:
--   1. Tagesprotokoll muc_day_context: Was hat das FEMS morgens vorhergesagt, welche Einstellungen
--      und welcher Heizplan galten an diesem Tag? Zusammen mit dem Tagesergebnis (muc_daily_stats)
--      ist das die Grundlage, um später Muster zu erkennen („an Tagen wie heute hat X am wenigsten
--      Netzstrom gebraucht“).
--   2. Treffsicherheit der PV-Prognose: Prognose „in N Stunden“ gegen die gemessene PV-Leistung.
--   3. Korrektur: Die Nacht endet seit 0.5 mit „Morgen ab“ (morning_start), nicht mehr mit night_end.

-- ---------------------------------------------------------------------------
-- 1) Tagesprotokoll
-- ---------------------------------------------------------------------------
create table if not exists public.muc_day_context (
  day               date primary key,
  captured_at       timestamptz not null default now(),
  source            text not null default 'live',  -- live = Collector morgens · nachgetragen = aus alten Prognosen
  late              boolean not null default false, -- erst > 1 h nach „Morgen ab“ erfasst (Collector war aus)
  collector_version text,
  -- Prognose zum Zeitpunkt der Erfassung (FEMS)
  fc_ts             timestamptz,
  fc_outdoor_c      numeric, fc_min_c numeric, fc_max_c numeric, fc_weather_code int,
  fc_pv_1h int, fc_pv_3h int, fc_pv_6h int, fc_pv_12h int,
  fc_load_1h int, fc_load_3h int, fc_load_6h int, fc_load_12h int,
  fc_temp_4h numeric, fc_temp_8h numeric, fc_temp_12h numeric, fc_temp_16h numeric, fc_temp_20h numeric, fc_temp_24h numeric,
  fc_code_4h int, fc_code_8h int, fc_code_12h int,
  fc_prev_noon_pv   int,    -- Prognose vom Vortag gegen 12 Uhr für heute Mittag (pv_24h)
  -- Was an diesem Tag galt
  settings          jsonb,  -- muc_settings (nur bei live erfasst)
  rooms             jsonb   -- Heizplan und Temperaturen je Raum (nur bei live erfasst)
);

-- Gemeinsamer Teil: Zeile für einen Tag aus der Prognose um p_at schreiben (nichts überschreiben)
create or replace function public.muc_put_day_context(
  p_day date, p_at timestamptz, p_source text, p_late boolean, p_version text, p_settings jsonb, p_rooms jsonb
) returns text
language plpgsql security invoker set search_path = public as $$
declare
  f muc_forecast%rowtype;
  v_prev int;
  v_noon timestamptz := ((p_day - 1) + time '12:00') at time zone 'Europe/Berlin';
begin
  if exists (select 1 from muc_day_context where day = p_day) then return 'vorhanden'; end if;

  -- Prognose, die zum Zeitpunkt p_at aktuell war (höchstens 45 min alt)
  select * into f from muc_forecast
   where ts <= p_at and ts > p_at - interval '45 minutes'
   order by ts desc limit 1;

  -- Prognose vom Vortag gegen 12 Uhr (11–13 Uhr) für 24 h später
  select pv_24h into v_prev from muc_forecast
   where ts >= v_noon - interval '1 hour' and ts < v_noon + interval '1 hour'
   order by abs(extract(epoch from ts - v_noon)) limit 1;

  if f.ts is null and v_prev is null and p_source <> 'live' then return 'keine Prognose'; end if;

  insert into muc_day_context (
    day, captured_at, source, late, collector_version,
    fc_ts, fc_outdoor_c, fc_min_c, fc_max_c, fc_weather_code,
    fc_pv_1h, fc_pv_3h, fc_pv_6h, fc_pv_12h,
    fc_load_1h, fc_load_3h, fc_load_6h, fc_load_12h,
    fc_temp_4h, fc_temp_8h, fc_temp_12h, fc_temp_16h, fc_temp_20h, fc_temp_24h,
    fc_code_4h, fc_code_8h, fc_code_12h,
    fc_prev_noon_pv, settings, rooms
  ) values (
    p_day, p_at, p_source, p_late, p_version,
    f.ts, f.outdoor_c, f.today_min_c, f.today_max_c, f.weather_code,
    f.pv_1h, f.pv_3h, f.pv_6h, f.pv_12h,
    f.load_1h, f.load_3h, f.load_6h, f.load_12h,
    f.temp_4h, f.temp_8h, f.temp_12h, f.temp_16h, f.temp_20h, f.temp_24h,
    f.code_4h, f.code_8h, f.code_12h,
    v_prev, p_settings, p_rooms
  ) on conflict (day) do nothing;

  return case when f.ts is null then 'ohne Prognose' else 'gespeichert' end;
end $$;

-- Collector: einmal am Tag, beim ersten Lauf nach „Morgen ab“
create or replace function public.muc_capture_day_context(p_version text default null)
returns text
language plpgsql security invoker set search_path = public as $$
declare
  v_now  timestamptz := now();
  v_day  date := (now() at time zone 'Europe/Berlin')::date;
  v_late boolean;
  v_settings jsonb;
  v_rooms jsonb;
begin
  select (v_now at time zone 'Europe/Berlin')::time > coalesce(morning_start, '06:00')::time + interval '1 hour',
         to_jsonb(s) - 'updated_at' - 'id'
    into v_late, v_settings
    from muc_settings s where id = 1;

  select jsonb_agg(jsonb_build_object(
           'id', id, 'heat_morning', heat_morning, 'heat_day', heat_day, 'heat_evening', heat_evening,
           'pv_prio', pv_prio, 'temp_night', temp_night, 'temp_normal', temp_normal,
           'temp_pv', temp_pv, 'temp_full', temp_full) order by sort)
    into v_rooms
    from muc_rooms where enabled;

  return muc_put_day_context(v_day, v_now, 'live', coalesce(v_late, false), p_version, v_settings, v_rooms);
end $$;

-- Vergangene Tage aus den gespeicherten Prognosen nachtragen (Einstellungen von damals sind unbekannt)
create or replace function public.muc_backfill_day_context()
returns int
language plpgsql security invoker set search_path = public as $$
declare
  today date := (now() at time zone 'Europe/Berlin')::date;
  d date;
  v_morning time;
  n int := 0;
begin
  select coalesce(morning_start, '06:00')::time into v_morning from muc_settings where id = 1;
  select (min(ts) at time zone 'Europe/Berlin')::date into d from muc_forecast;
  if d is null then return 0; end if;
  while d < today loop
    if muc_put_day_context(d, ((d + coalesce(v_morning, time '06:00')) at time zone 'Europe/Berlin') + interval '10 minutes',
                           'nachgetragen', false, null, null, null) = 'gespeichert' then
      n := n + 1;
    end if;
    d := d + 1;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- 2) Treffsicherheit der PV-Prognose
--    Für jede gespeicherte Prognose und jeden Vorhersagezeitraum (1/3/6/12/24/36 h):
--    vorhergesagte Leistung gegen die gemessene PV-Leistung (Mittel ±7,5 min um den Zielzeitpunkt).
--    Nachtstunden (Prognose und Messung unter 50 W) zählen nicht – sie würden die
--    Treffsicherheit schönrechnen.
-- ---------------------------------------------------------------------------
create or replace function public.muc_forecast_accuracy(p_from date, p_to date)
returns table (horizon_h int, n int, days int, fc_avg_w int, real_avg_w int, mae_w int, bias_w int, mae_pct numeric)
language sql stable security invoker set search_path = public as $$
  with f as (
    select fc.ts, h.h,
           case h.h when 1 then fc.pv_1h when 3 then fc.pv_3h when 6 then fc.pv_6h
                    when 12 then fc.pv_12h when 24 then fc.pv_24h else fc.pv_36h end as fc_w
    from muc_forecast fc
    cross join unnest(array[1, 3, 6, 12, 24, 36]) as h(h)
    where fc.ts >= (select t0 from muc_day_bounds(p_from))
      and fc.ts <  (select t1 from muc_day_bounds(p_to))
  ),
  m as (
    select f.h, f.fc_w, a.real_w, a.cnt,
           ((f.ts + make_interval(hours => f.h)) at time zone 'Europe/Berlin')::date as target_day
    from f
    cross join lateral (
      select avg(e.pv_w) as real_w, count(*) as cnt
      from muc_energy_readings e
      where e.ts >= f.ts + make_interval(hours => f.h) - interval '450 seconds'
        and e.ts <  f.ts + make_interval(hours => f.h) + interval '450 seconds'
    ) a
    where f.fc_w is not null
  )
  select h, count(*)::int, count(distinct target_day)::int,
         round(avg(fc_w))::int, round(avg(real_w))::int,
         round(avg(abs(fc_w - real_w)))::int, round(avg(fc_w - real_w))::int,
         round(100 * avg(abs(fc_w - real_w)) / nullif(avg(real_w), 0), 0)
  from m
  where cnt >= 5 and (fc_w > 50 or real_w > 50)
  group by h
  order by h;
$$;

-- Je Tag: Mittagsprognose (morgens bzw. vom Vortag) gegen gemessene Mittags-PV, dazu das Tagesergebnis
create or replace function public.muc_range_context(p_from date, p_to date)
returns table (
  day date, source text, late boolean, fc_ts timestamptz,
  fc_noon_w int, fc_prev_noon_w int, real_noon_w int,
  fc_min_c numeric, fc_max_c numeric, fc_weather_code int,
  pv_kwh numeric, grid_in_kwh numeric, heat_kwh numeric, heat_grid_kwh numeric,
  bat_empty_h numeric, outdoor_avg numeric
)
language sql stable security invoker set search_path = public as $$
  with d as (
    select g.d::date as day from generate_series(p_from, p_to, interval '1 day') g(d)
  )
  select d.day, c.source, c.late, c.fc_ts,
         -- fc_pv_6h ist die Prognose für „Erfassung + 6 h“ – nur bei Erfassung zwischen 05:30 und 06:30
         -- zielt sie auf ca. 12 Uhr; sonst (Collector war morgens aus) bleibt sie leer
         case when (c.fc_ts at time zone 'Europe/Berlin')::time between time '05:30' and time '06:30'
              then c.fc_pv_6h end,
         c.fc_prev_noon_pv,
         (select round(avg(e.pv_w))::int from muc_energy_readings e
           where e.ts >= ((d.day + time '11:45') at time zone 'Europe/Berlin')
             and e.ts <  ((d.day + time '12:15') at time zone 'Europe/Berlin')),
         c.fc_min_c, c.fc_max_c, c.fc_weather_code,
         s.pv_kwh, s.grid_in_kwh, s.heat_kwh, s.heat_grid_kwh, s.bat_empty_h, s.outdoor_avg
  from d
  left join muc_day_context c on c.day = d.day
  left join lateral (select * from muc_range_days(d.day, d.day)) s on true
  where c.day is not null or s.day is not null
  order by d.day;
$$;

-- Grundlage für Stufe B (Muster): Tagesprotokoll + Tagesergebnis in einer Zeile
create or replace view public.muc_day_patterns with (security_invoker = true) as
  select c.*, s.data_hours, s.pv_kwh, s.use_kwh, s.grid_in_kwh, s.feed_kwh, s.bat_out_kwh,
         s.heat_kwh, s.heat_sun_kwh, s.heat_bat_kwh, s.heat_grid_kwh,
         s.heat_p1_kwh, s.heat_p2_kwh, s.heat_p3_kwh, s.heat_p4_kwh, s.heat_p5_kwh,
         s.bat_empty_h, s.soc_min, s.soc_max, s.outdoor_min, s.outdoor_avg, s.outdoor_max,
         greatest(0, 18 - s.outdoor_avg) as heating_degree
  from muc_day_context c
  join muc_daily_stats s on s.day = c.day;

-- ---------------------------------------------------------------------------
-- 3) Korrektur Tageskennzahlen: Nacht = „Nacht ab“ bis „Morgen ab“ (seit 0.5)
-- ---------------------------------------------------------------------------
create or replace function public.muc_day_kpis(p_date date)
returns table (
  data_hours numeric, pv_kwh numeric, consumption_kwh numeric, car_kwh numeric, car_measured boolean,
  heat_kwh numeric, heat_pv_kwh numeric, heat_bat_kwh numeric, heat_grid_kwh numeric,
  grid_in_kwh numeric, grid_in_night_kwh numeric, grid_out_kwh numeric,
  bat_in_kwh numeric, bat_out_kwh numeric, autarky_pct numeric, self_use_pct numeric,
  soc_min int, soc_max int, bat_empty_h numeric, bat_empty_from timestamptz,
  outdoor_min numeric, outdoor_avg numeric, outdoor_max numeric, baseload_w int
)
language sql stable security invoker set search_path = public as $$
  with s as (
    select night_start, coalesce(morning_start, night_end) as night_end, coalesce(baseload_w, 350) base
    from muc_settings where id = 1
  ),
  r as (
    select x.*,
           (to_char(x.ts at time zone 'Europe/Berlin', 'HH24:MI') >= (select night_start from s)
            or to_char(x.ts at time zone 'Europe/Berlin', 'HH24:MI') < (select night_end from s)) as is_night
    from muc_energy_rows(p_date) x
  )
  select
    round(sum(dt_h), 1),
    round(sum(pv_w * dt_h) / 1000, 1),
    round(sum(consumption_w * dt_h) / 1000, 1),
    round(sum(coalesce(car_w, 0) * dt_h) / 1000, 1),
    bool_or(car_w is not null),
    round(sum(heat_w * dt_h) / 1000, 1),
    round(sum(heat_w * f_pv * dt_h) / 1000, 1),
    round(sum(heat_w * f_bat * dt_h) / 1000, 1),
    round(sum(heat_w * f_grid * dt_h) / 1000, 1),
    round(sum(grid_in_w * dt_h) / 1000, 1),
    round(sum(grid_in_w * dt_h) filter (where is_night) / 1000, 1),
    round(sum(grid_out_w * dt_h) / 1000, 1),
    round(sum(bat_in_w * dt_h) / 1000, 1),
    round(sum(bat_out_w * dt_h) / 1000, 1),
    round(100 * (1 - sum(grid_in_w * dt_h) / nullif(sum(consumption_w * dt_h), 0)), 0),
    round(100 * (1 - sum(grid_out_w * dt_h) / nullif(sum(pv_w * dt_h), 0)), 0),
    min(soc), max(soc),
    round(sum(dt_h) filter (where soc <= 5), 1),
    min(ts) filter (where soc <= 5),
    min(outdoor_c), round(avg(outdoor_c), 1), max(outdoor_c),
    (select base from s)
  from r;
$$;

-- ---------------------------------------------------------------------------
-- Rechte
-- ---------------------------------------------------------------------------
alter table public.muc_day_context enable row level security;
drop policy if exists "muc auth read" on public.muc_day_context;
create policy "muc auth read" on public.muc_day_context for select to authenticated using (true);
revoke all on public.muc_day_context from anon;
grant select on public.muc_day_context to authenticated;
grant all on public.muc_day_context to service_role;

revoke all on public.muc_day_patterns from anon;
grant select on public.muc_day_patterns to authenticated, service_role;

do $$
declare f text;
begin
  foreach f in array array['muc_forecast_accuracy(date, date)', 'muc_range_context(date, date)', 'muc_day_kpis(date)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
  foreach f in array array[
    'muc_put_day_context(date, timestamptz, text, boolean, text, jsonb, jsonb)',
    'muc_capture_day_context(text)', 'muc_backfill_day_context()'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

-- Vergangene Tage aus den vorhandenen Prognosen nachtragen
select public.muc_backfill_day_context() as nachgetragene_tage;
