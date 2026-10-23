-- Heizung München – Migration 002: Analyse (Phase 1)
-- Im Supabase SQL-Editor ausführen. Kann gefahrlos mehrfach ausgeführt werden.
-- Ändert nur muc_-Objekte, Venediger bleibt unberührt.

-- ---------------------------------------------------------------------------
-- Neue Messwerte und Einstellung
-- ---------------------------------------------------------------------------
alter table public.muc_energy_readings add column if not exists car_w     int;          -- Auto-Ladeleistung (evcc)
alter table public.muc_energy_readings add column if not exists outdoor_c numeric(4,1); -- Außentemperatur (Open-Meteo)
alter table public.muc_settings        add column if not exists baseload_w int not null default 350; -- Grundlast Haus ohne Heizung/Auto

-- ---------------------------------------------------------------------------
-- Hilfsfunktion: Tagesgrenzen in Ortszeit
-- ---------------------------------------------------------------------------
create or replace function public.muc_day_bounds(p_date date, out t0 timestamptz, out t1 timestamptz)
language sql immutable set search_path = public as $$
  select (p_date::timestamp at time zone 'Europe/Berlin'),
         ((p_date + 1)::timestamp at time zone 'Europe/Berlin');
$$;

-- ---------------------------------------------------------------------------
-- Energie je Messung inkl. Dauer, Heizschätzung und Herkunft (Basis für alles)
--   heat_w  = Verbrauch − Auto − Grundlast  (Schätzung, solange die WP nicht gemessen wird)
--   Herkunft je Messung anteilig: Netz, Batterie, PV-direkt
-- ---------------------------------------------------------------------------
create or replace function public.muc_energy_rows(p_date date)
returns table (
  ts timestamptz, dt_h numeric, pv_w int, consumption_w int, car_w int, heat_w numeric,
  grid_in_w int, grid_out_w int, bat_in_w int, bat_out_w int, soc int, outdoor_c numeric,
  house_mode text, f_pv numeric, f_bat numeric, f_grid numeric
)
language sql stable security invoker set search_path = public as $$
  with b as (select * from muc_day_bounds(p_date)),
  s as (select coalesce(baseload_w, 350) as base from muc_settings where id = 1),
  r as (
    select e.*,
           least(extract(epoch from coalesce(lead(e.ts) over (order by e.ts), b.t1) - e.ts), 300) / 3600.0 as dt_h
    from muc_energy_readings e, b
    where e.ts >= b.t0 and e.ts < b.t1
  )
  select r.ts, r.dt_h::numeric, r.pv_w, r.consumption_w, r.car_w,
         greatest(0, coalesce(r.consumption_w, 0) - coalesce(r.car_w, 0) - (select base from s))::numeric as heat_w,
         greatest(r.grid_w, 0), greatest(-r.grid_w, 0),
         greatest(-r.battery_w, 0), greatest(r.battery_w, 0),
         r.soc, r.outdoor_c, r.house_mode,
         case when coalesce(r.consumption_w, 0) > 0
              then greatest(0, 1 - (greatest(r.grid_w, 0) + greatest(r.battery_w, 0))::numeric / r.consumption_w) else 0 end,
         case when coalesce(r.consumption_w, 0) > 0
              then least(1, greatest(r.battery_w, 0)::numeric / r.consumption_w) else 0 end,
         case when coalesce(r.consumption_w, 0) > 0
              then least(1, greatest(r.grid_w, 0)::numeric / r.consumption_w) else 0 end
  from r
  where r.dt_h > 0;
$$;

-- ---------------------------------------------------------------------------
-- Tageskennzahlen (eine Zeile)
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
  with s as (select night_start, night_end, coalesce(baseload_w, 350) base from muc_settings where id = 1),
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
-- Tagesverlauf Energie in 15-Minuten-Blöcken
-- ---------------------------------------------------------------------------
create or replace function public.muc_day_energy(p_date date)
returns table (
  bucket timestamptz, pv_w int, consumption_w int, car_w int, heat_w int,
  grid_in_w int, grid_out_w int, bat_in_w int, bat_out_w int, soc int, outdoor_c numeric, house_mode text
)
language sql stable security invoker set search_path = public as $$
  select date_bin('15 minutes', ts, (select t0 from muc_day_bounds(p_date))) b,
         (sum(pv_w * dt_h) / sum(dt_h))::int,
         (sum(consumption_w * dt_h) / sum(dt_h))::int,
         (sum(coalesce(car_w, 0) * dt_h) / sum(dt_h))::int,
         (sum(heat_w * dt_h) / sum(dt_h))::int,
         (sum(grid_in_w * dt_h) / sum(dt_h))::int,
         (sum(grid_out_w * dt_h) / sum(dt_h))::int,
         (sum(bat_in_w * dt_h) / sum(dt_h))::int,
         (sum(bat_out_w * dt_h) / sum(dt_h))::int,
         round(avg(soc))::int,
         round(avg(outdoor_c), 1),
         mode() within group (order by house_mode)
  from muc_energy_rows(p_date)
  group by 1 order by 1;
$$;

-- ---------------------------------------------------------------------------
-- Raumkennzahlen je Tag
--   Herkunft der Wärme: Für jede Minute mit offenem Ventil wird geprüft, woher der
--   Hausstrom gerade kam (Netz > 100 W → Netz, sonst Batterie > 100 W → Batterie, sonst PV).
--   Aufheiz-/Abkühlrate: mittlere Temperaturänderung (K/h) in 15-Min-Blöcken mit
--   überwiegend offenem bzw. geschlossenem Ventil – Fußbodenheizung reagiert träge,
--   die Werte zeigen eine Tendenz, keine exakte Physik.
-- ---------------------------------------------------------------------------
create or replace function public.muc_room_day_stats(p_date date)
returns table (
  room_id text, name text, data_hours numeric,
  temp_avg numeric, temp_min numeric, temp_max numeric, setpoint_avg numeric, dev_avg numeric,
  cold_h numeric, warm_h numeric,
  valve_h numeric, valve_pv_h numeric, valve_bat_h numeric, valve_grid_h numeric, valve_switches int,
  heat_rate_kph numeric, cool_rate_kph numeric
)
language sql stable security invoker set search_path = public as $$
  with b as (select * from muc_day_bounds(p_date)),
  rr as (
    select r.*,
           least(extract(epoch from coalesce(lead(r.ts) over (partition by r.room_id order by r.ts), b.t1) - r.ts), 300) / 3600.0 as dt_h,
           lag(r.valve) over (partition by r.room_id order by r.ts) as prev_valve,
           e.grid_w, e.battery_w
    from muc_room_readings r
    cross join b
    left join lateral (
      select en.grid_w, en.battery_w from muc_energy_readings en
      where en.ts between r.ts - interval '90 seconds' and r.ts + interval '90 seconds'
      order by abs(extract(epoch from en.ts - r.ts)) limit 1
    ) e on true
    where r.ts >= b.t0 and r.ts < b.t1
  ),
  q as (
    select room_id, date_bin('15 minutes', ts, (select t0 from b)) bk,
           avg(temp) t, avg(valve) v
    from rr group by 1, 2
  ),
  slopes as (
    select room_id, v,
           (lead(t) over (partition by room_id order by bk) - t)
             / nullif(extract(epoch from lead(bk) over (partition by room_id order by bk) - bk) / 3600.0, 0) as k_per_h,
           extract(epoch from lead(bk) over (partition by room_id order by bk) - bk) as gap
    from q
  ),
  rates as (
    select room_id,
           round(avg(k_per_h) filter (where v >= 0.75 and gap = 900)::numeric, 2) heat_rate,
           round(avg(k_per_h) filter (where v <= 0.25 and gap = 900)::numeric, 2) cool_rate
    from slopes group by room_id
  ),
  agg as (
    select room_id,
           round(sum(dt_h)::numeric, 1) data_hours,
           round(avg(temp), 1) temp_avg, min(temp) temp_min, max(temp) temp_max,
           round(avg(setpoint), 1) setpoint_avg,
           round(avg(temp - setpoint), 1) dev_avg,
           round(sum(dt_h) filter (where temp < setpoint - 0.5)::numeric, 1) cold_h,
           round(sum(dt_h) filter (where temp > setpoint + 1.0)::numeric, 1) warm_h,
           round(sum(dt_h) filter (where valve = 1)::numeric, 1) valve_h,
           round(sum(dt_h) filter (where valve = 1 and coalesce(grid_w, 0) <= 100 and coalesce(battery_w, 0) <= 100)::numeric, 1) valve_pv_h,
           round(sum(dt_h) filter (where valve = 1 and coalesce(grid_w, 0) <= 100 and battery_w > 100)::numeric, 1) valve_bat_h,
           round(sum(dt_h) filter (where valve = 1 and grid_w > 100)::numeric, 1) valve_grid_h,
           count(*) filter (where valve = 1 and prev_valve = 0)::int valve_switches
    from rr group by room_id
  )
  select ro.id, ro.name, a.data_hours, a.temp_avg, a.temp_min, a.temp_max, a.setpoint_avg, a.dev_avg,
         coalesce(a.cold_h, 0), coalesce(a.warm_h, 0),
         coalesce(a.valve_h, 0), coalesce(a.valve_pv_h, 0), coalesce(a.valve_bat_h, 0), coalesce(a.valve_grid_h, 0),
         coalesce(a.valve_switches, 0), rt.heat_rate, rt.cool_rate
  from muc_rooms ro
  left join agg a on a.room_id = ro.id
  left join rates rt on rt.room_id = ro.id
  where ro.enabled or a.room_id is not null
  order by ro.sort;
$$;

-- ---------------------------------------------------------------------------
-- Raumverlauf eines Tages in 15-Minuten-Blöcken
-- ---------------------------------------------------------------------------
create or replace function public.muc_room_day_series(p_date date, p_room text)
returns table (bucket timestamptz, temp numeric, setpoint numeric, target numeric, valve numeric)
language sql stable security invoker set search_path = public as $$
  select date_bin('15 minutes', r.ts, b.t0),
         round(avg(r.temp), 2), round(avg(r.setpoint), 1), round(avg(r.target), 1), round(avg(r.valve), 2)
  from muc_room_readings r, muc_day_bounds(p_date) b
  where r.ts >= b.t0 and r.ts < b.t1 and r.room_id = p_room
  group by 1 order by 1;
$$;

-- ---------------------------------------------------------------------------
-- Rechte: nur angemeldete Benutzer
-- ---------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'muc_day_bounds(date)', 'muc_energy_rows(date)', 'muc_day_kpis(date)', 'muc_day_energy(date)',
    'muc_room_day_stats(date)', 'muc_room_day_series(date, text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;

-- Schnellere Tagesabfragen
create index if not exists muc_room_readings_ts on public.muc_room_readings (ts);
