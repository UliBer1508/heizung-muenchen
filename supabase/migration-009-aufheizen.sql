-- Migration 009 – Aufheiz-Modell und „wie viele Räume gleichzeitig“ (Collector 0.8.0)
--
-- Der Collector misst jeden Heizlauf: Raum darf heizen → bis er fertig ist oder warten muss.
--   muc_heat_runs        ein Lauf je Zeile (Start-/Endtemperatur, Minuten, wie viele Räume gleichzeitig, Heizstrom)
--   muc_heat_rate        gelernte Aufheizrate je Raum in °C pro Stunde (letzte 10 gültige Läufe)
--   muc_rooms.heat_rate_seed   Startwert aus dem Verlauf (alle Ventile offen), bis 2 Läufe gemessen sind
--   muc_settings.seq_max_rooms so viele Räume heizen gleichzeitig (Start: 1 = einer nach dem anderen;
--                              0 = alle Räume der vordersten Prio)
-- Wiederholt ausführbar.

create table if not exists public.muc_heat_runs (
  id            bigint generated always as identity primary key,
  room_id       text not null references public.muc_rooms(id) on delete cascade,
  started_at    timestamptz not null,
  ended_at      timestamptz not null,
  minutes       integer not null,
  temp_start    numeric not null,
  temp_end      numeric not null,
  target        numeric,
  reached       boolean not null default false,
  rooms_heating numeric,        -- Ø Anzahl Räume, die gleichzeitig heizen durften
  heat_w        integer,        -- Ø geschätzter Heizstrom (Verbrauch − Auto − 400 W)
  outdoor_c     numeric,
  rate_c_per_h  numeric generated always as (round((temp_end - temp_start) / greatest(minutes, 1) * 60, 3)) stored
);
create index if not exists muc_heat_runs_room_idx on public.muc_heat_runs (room_id, ended_at desc);
alter table public.muc_heat_runs enable row level security;
drop policy if exists "muc auth read" on public.muc_heat_runs;
create policy "muc auth read" on public.muc_heat_runs for select to authenticated using (true);

alter table public.muc_rooms add column if not exists heat_rate_seed numeric;
alter table public.muc_settings add column if not exists seq_max_rooms integer not null default 1 check (seq_max_rooms between 0 and 20);

-- Gültig: mindestens 30 min, Wärmepumpe lief (Heizstrom > 800 W oder unbekannt).
-- Rate = Summe Anstieg / Summe Stunden der letzten 10 Läufe. Ab 2 Läufen gemessen, sonst Startwert.
create or replace view public.muc_heat_rate with (security_invoker = true) as
with ok as (
  select h.*, row_number() over (partition by room_id order by ended_at desc) as nr
  from public.muc_heat_runs h
  where minutes >= 30 and (heat_w is null or heat_w > 800)
), agg as (
  select room_id, count(*) as runs,
         round(sum(temp_end - temp_start) / nullif(sum(minutes) / 60.0, 0), 3) as rate,
         round(avg(rooms_heating), 1) as rooms_avg,
         max(ended_at) as last_run
  from ok where nr <= 10 group by room_id
)
select r.id as room_id, r.name,
       case when coalesce(a.runs, 0) >= 2 and a.rate > 0 then a.rate else r.heat_rate_seed end as rate_c_per_h,
       case when coalesce(a.runs, 0) >= 2 and a.rate > 0 then 'gemessen' else 'Startwert' end as source,
       coalesce(a.runs, 0) as runs, a.rooms_avg, a.last_run, r.heat_rate_seed
from public.muc_rooms r left join agg a on a.room_id = r.id;
grant select on public.muc_heat_rate to authenticated;

-- Startwerte aus den letzten 14 Tagen: Stunden mit offenem Ventil (≥ 80 %) und laufender Wärmepumpe.
-- (Damals waren meist alle Ventile offen – mit wenigen offenen Räumen wird es eher schneller.)
with e as (
  select date_trunc('hour', ts) h, avg(consumption_w - coalesce(car_w, 0)) - 400 as heiz_w
  from public.muc_energy_readings where ts > now() - interval '14 days' group by 1
), rr as (
  select room_id, date_trunc('hour', ts) h, avg(temp) t, avg(valve) v
  from public.muc_room_readings where ts > now() - interval '14 days' group by 1, 2
), d as (
  select rr.room_id, rr.v, e.heiz_w,
         lead(rr.t) over w - rr.t as dt, lead(rr.h) over w - rr.h as gap
  from rr join e using (h)
  window w as (partition by rr.room_id order by rr.h)
), seed as (
  select room_id, round(avg(dt)::numeric, 3) as rate
  from d where v >= 0.8 and heiz_w > 1500 and gap = interval '1 hour'
  group by room_id having count(*) >= 3
)
update public.muc_rooms r set heat_rate_seed = greatest(seed.rate, 0.02)
from seed where seed.room_id = r.id and r.heat_rate_seed is null;

select name, rate_c_per_h, source from public.muc_heat_rate order by rate_c_per_h desc nulls last;
