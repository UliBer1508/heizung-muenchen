-- Heizung München – Migration 003: Analyse über Woche, Monat, Jahr
-- Voraussetzung: migration-002-analyse.sql. Im Supabase SQL-Editor ausführen,
-- kann gefahrlos mehrfach ausgeführt werden. Ändert nur muc_-Objekte.
--
-- Idee: Die Rohdaten (jede Minute) werden nach 90 Tagen gelöscht. Deshalb berechnet
-- der Collector jede Nacht die Tageswerte des Vortags und speichert sie dauerhaft.
-- Für den laufenden Tag (und fehlende Tage innerhalb der 90 Tage) wird live gerechnet.

-- ---------------------------------------------------------------------------
-- Tageswerte aus den Rohdaten (eine Zeile) – Energiefluss wie in der Tagesansicht
-- ---------------------------------------------------------------------------
create or replace function public.muc_day_summary(p_date date)
returns table (
  day date, data_hours numeric, car_measured boolean,
  pv_kwh numeric, use_kwh numeric, grid_in_kwh numeric, feed_kwh numeric, bat_in_kwh numeric, bat_out_kwh numeric,
  pv_house_kwh numeric, pv_heat_kwh numeric, pv_car_kwh numeric, pv_bat_kwh numeric,
  bat_house_kwh numeric, bat_heat_kwh numeric, bat_car_kwh numeric,
  heat_kwh numeric, heat_sun_kwh numeric, heat_bat_kwh numeric, heat_grid_kwh numeric,
  car_kwh numeric, car_sun_kwh numeric, car_bat_kwh numeric, car_grid_kwh numeric,
  house_kwh numeric, house_grid_kwh numeric,
  heat_p1_kwh numeric, heat_p2_kwh numeric, heat_p3_kwh numeric, heat_p4_kwh numeric, heat_p5_kwh numeric,
  heat_grid_p1_kwh numeric, heat_grid_p2_kwh numeric, heat_grid_p3_kwh numeric, heat_grid_p4_kwh numeric, heat_grid_p5_kwh numeric,
  soc_min int, soc_max int, bat_empty_h numeric, outdoor_min numeric, outdoor_avg numeric, outdoor_max numeric
)
language sql stable security invoker set search_path = public as $$
  with r0 as (
    select x.*, extract(hour from x.ts at time zone 'Europe/Berlin') as hr,
           least(coalesce(x.car_w, 0), coalesce(x.consumption_w, 0))::numeric as car
    from muc_energy_rows(p_date) x
  ),
  r as (
    select r0.*,
           least(r0.heat_w, greatest(0, coalesce(r0.consumption_w, 0) - r0.car)) as heat,
           least(r0.bat_in_w, coalesce(r0.pv_w, 0))::numeric as pv_bat
    from r0
  ),
  f as (
    select r.*, greatest(0, coalesce(r.consumption_w, 0) - r.car - r.heat) as house,
           case when hr < 6 then 1 when hr < 9 then 2 when hr < 16 then 3 when hr < 20 then 4 else 5 end as p
    from r
  )
  select
    p_date,
    round(sum(dt_h), 2),
    bool_or(car_w is not null),
    round(sum(pv_w * dt_h) / 1000, 2),
    round(sum(consumption_w * dt_h) / 1000, 2),
    round(sum(grid_in_w * dt_h) / 1000, 2),
    round(sum(grid_out_w * dt_h) / 1000, 2),
    round(sum(bat_in_w * dt_h) / 1000, 2),
    round(sum(bat_out_w * dt_h) / 1000, 2),
    round(sum(house * f_pv * dt_h) / 1000, 2),
    round(sum(heat * f_pv * dt_h) / 1000, 2),
    round(sum(car * f_pv * dt_h) / 1000, 2),
    round(sum(pv_bat * dt_h) / 1000, 2),
    round(sum(house * f_bat * dt_h) / 1000, 2),
    round(sum(heat * f_bat * dt_h) / 1000, 2),
    round(sum(car * f_bat * dt_h) / 1000, 2),
    round(sum(heat * dt_h) / 1000, 2),
    round(sum(heat * f_pv * dt_h) / 1000, 2),
    round(sum(heat * f_bat * dt_h) / 1000, 2),
    round(sum(heat * f_grid * dt_h) / 1000, 2),
    round(sum(car * dt_h) / 1000, 2),
    round(sum(car * f_pv * dt_h) / 1000, 2),
    round(sum(car * f_bat * dt_h) / 1000, 2),
    round(sum(car * f_grid * dt_h) / 1000, 2),
    round(sum(house * dt_h) / 1000, 2),
    round(sum(house * f_grid * dt_h) / 1000, 2),
    round(coalesce(sum(heat * dt_h) filter (where p = 1), 0) / 1000, 2),
    round(coalesce(sum(heat * dt_h) filter (where p = 2), 0) / 1000, 2),
    round(coalesce(sum(heat * dt_h) filter (where p = 3), 0) / 1000, 2),
    round(coalesce(sum(heat * dt_h) filter (where p = 4), 0) / 1000, 2),
    round(coalesce(sum(heat * dt_h) filter (where p = 5), 0) / 1000, 2),
    round(coalesce(sum(heat * f_grid * dt_h) filter (where p = 1), 0) / 1000, 2),
    round(coalesce(sum(heat * f_grid * dt_h) filter (where p = 2), 0) / 1000, 2),
    round(coalesce(sum(heat * f_grid * dt_h) filter (where p = 3), 0) / 1000, 2),
    round(coalesce(sum(heat * f_grid * dt_h) filter (where p = 4), 0) / 1000, 2),
    round(coalesce(sum(heat * f_grid * dt_h) filter (where p = 5), 0) / 1000, 2),
    min(soc), max(soc),
    round(coalesce(sum(dt_h) filter (where soc <= 5), 0), 2),
    min(outdoor_c), round(avg(outdoor_c), 1), max(outdoor_c)
  from f;
$$;

-- ---------------------------------------------------------------------------
-- Dauerhafte Tabellen (Struktur aus den Funktionen abgeleitet)
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.muc_daily_stats') is null then
    execute 'create table public.muc_daily_stats as select *, now() as computed_at from public.muc_day_summary(''1900-01-01'') with no data';
    execute 'alter table public.muc_daily_stats add primary key (day)';
  end if;
  if to_regclass('public.muc_room_daily_stats') is null then
    execute 'create table public.muc_room_daily_stats as select ''1900-01-01''::date as day, s.* from public.muc_room_day_stats(''1900-01-01'') s with no data';
    execute 'alter table public.muc_room_daily_stats add primary key (day, room_id)';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Einen Tag speichern (Collector, nachts für den Vortag)
-- ---------------------------------------------------------------------------
create or replace function public.muc_store_day(p_date date)
returns boolean
language plpgsql security invoker set search_path = public as $$
declare ok boolean;
begin
  delete from muc_daily_stats where day = p_date;
  insert into muc_daily_stats select s.*, now() from muc_day_summary(p_date) s where s.data_hours > 0;
  get diagnostics ok = row_count;
  delete from muc_room_daily_stats where day = p_date;
  insert into muc_room_daily_stats select p_date, s.* from muc_room_day_stats(p_date) s where s.data_hours > 0;
  return ok;
end $$;

-- Alle fehlenden abgeschlossenen Tage nachtragen (beim Start und jede Nacht)
create or replace function public.muc_store_missing_days()
returns int
language plpgsql security invoker set search_path = public as $$
declare
  today date := (now() at time zone 'Europe/Berlin')::date;
  first_day date;
  d date;
  n int := 0;
begin
  select (min(ts) at time zone 'Europe/Berlin')::date into first_day from muc_energy_readings;
  if first_day is null then return 0; end if;
  d := greatest(first_day, today - 120);
  while d < today loop
    if not exists (select 1 from muc_daily_stats where day = d) then
      if muc_store_day(d) then n := n + 1; end if;
    end if;
    d := d + 1;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- Zeitraum abfragen: gespeicherte Tage + live berechnete (heute, fehlende)
-- ---------------------------------------------------------------------------
create or replace function public.muc_range_days(p_from date, p_to date)
returns setof public.muc_daily_stats
language sql stable security invoker set search_path = public as $$
  with today as (select (now() at time zone 'Europe/Berlin')::date as d)
  select s.* from muc_daily_stats s, today
  where s.day between p_from and p_to and s.day < today.d
  union all
  select x.*, now()
  from generate_series(p_from, p_to, interval '1 day') g(d)
  cross join today
  cross join lateral muc_day_summary(g.d::date) x
  where g.d::date >= today.d - 95
    and (g.d::date >= today.d or not exists (select 1 from muc_daily_stats s2 where s2.day = g.d::date))
    and x.data_hours > 0
  order by 1;
$$;

create or replace function public.muc_range_rooms(p_from date, p_to date)
returns setof public.muc_room_daily_stats
language sql stable security invoker set search_path = public as $$
  with today as (select (now() at time zone 'Europe/Berlin')::date as d)
  select s.* from muc_room_daily_stats s, today
  where s.day between p_from and p_to and s.day < today.d
  union all
  select g.d::date, x.*
  from generate_series(p_from, p_to, interval '1 day') g(d)
  cross join today
  cross join lateral muc_room_day_stats(g.d::date) x
  where g.d::date >= today.d - 95
    and (g.d::date >= today.d or not exists (select 1 from muc_room_daily_stats s2 where s2.day = g.d::date))
    and x.data_hours > 0
  order by 1, 2;
$$;

-- ---------------------------------------------------------------------------
-- Rechte
-- ---------------------------------------------------------------------------
alter table public.muc_daily_stats enable row level security;
alter table public.muc_room_daily_stats enable row level security;
drop policy if exists "muc auth read" on public.muc_daily_stats;
create policy "muc auth read" on public.muc_daily_stats for select to authenticated using (true);
drop policy if exists "muc auth read" on public.muc_room_daily_stats;
create policy "muc auth read" on public.muc_room_daily_stats for select to authenticated using (true);
revoke all on public.muc_daily_stats, public.muc_room_daily_stats from anon;
grant select on public.muc_daily_stats, public.muc_room_daily_stats to authenticated;
grant all on public.muc_daily_stats, public.muc_room_daily_stats to service_role;

do $$
declare f text;
begin
  foreach f in array array['muc_day_summary(date)', 'muc_range_days(date, date)', 'muc_range_rooms(date, date)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
  foreach f in array array['muc_store_day(date)', 'muc_store_missing_days()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

-- Sofort alle bisher vorhandenen Tage speichern
select public.muc_store_missing_days() as gespeicherte_tage;
