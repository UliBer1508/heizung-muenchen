-- Heizung München – Datenbank-Schema
-- Einmalig im Supabase SQL-Editor des NEUEN Projekts ausführen.
-- Kann gefahrlos erneut ausgeführt werden (IF NOT EXISTS / ON CONFLICT).

-- ---------------------------------------------------------------------------
-- Einstellungen (genau eine Zeile, id = 1)
-- ---------------------------------------------------------------------------
create table if not exists public.settings (
  id               int primary key default 1 check (id = 1),
  timezone         text    not null default 'Europe/Berlin',
  automation_enabled boolean not null default true,
  dry_run          boolean not null default true,   -- Testmodus: nur protokollieren, nichts schreiben
  night_start      text    not null default '20:00',
  night_end        text    not null default '09:00',
  evening_start    text    not null default '16:00',
  surplus_on_w     int     not null default 1500,   -- PV-Laden ein ab diesem Überschuss
  surplus_off_w    int     not null default 300,    -- PV-Laden aus unter diesem Überschuss
  pv_min_soc       int     not null default 60,     -- Batterieladung zählt erst ab diesem SoC als Überschuss
  reserve_soc      int     not null default 40,     -- Abendreserve
  full_soc         int     not null default 95,     -- "Batterie voll"
  full_export_w    int     not null default 3000,
  hold_minutes     int     not null default 30,     -- Mindestdauer eines Modus
  average_minutes  int     not null default 5,      -- Glättung der FENECON-Werte
  updated_at       timestamptz not null default now()
);
insert into public.settings (id) values (1) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Räume
-- ---------------------------------------------------------------------------
create table if not exists public.rooms (
  id                   text primary key,             -- z. B. 'kg_bad'
  name                 text not null,
  enabled              boolean not null default true,
  sort                 int not null default 100,
  loxone_temp_name     text,                          -- eindeutige Bezeichnung des Temperaturfühlers
  loxone_setpoint_name text not null,                 -- virtueller Eingang → ϑch des Raumreglers
  loxone_valve_name    text,                          -- Ventilausgang (nur lesen)
  temp_night           numeric(4,1) not null default 19,
  temp_normal          numeric(4,1) not null default 21,
  temp_pv              numeric(4,1) not null default 23,
  temp_full            numeric(4,1) not null default 24,
  min_temp             numeric(4,1) not null default 5,
  max_temp             numeric(4,1) not null default 26,
  override_temp        numeric(4,1),
  override_until       timestamptz,
  updated_at           timestamptz not null default now()
);

insert into public.rooms (id, name, sort, loxone_temp_name, loxone_setpoint_name, loxone_valve_name)
values ('kg_bad', 'KG Bad', 10, 'Temp KG Bad', 'API_Boost_Bad', 'Bad KG')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Messwerte & Protokoll
-- ---------------------------------------------------------------------------
create table if not exists public.energy_readings (
  id            bigint generated always as identity primary key,
  ts            timestamptz not null default now(),
  pv_w          int,
  grid_w        int,          -- + Bezug, − Einspeisung
  battery_w     int,          -- + Entladen, − Laden
  consumption_w int,
  soc           int,
  surplus_w     int,
  house_mode    text
);
create index if not exists energy_readings_ts on public.energy_readings (ts desc);

create table if not exists public.room_readings (
  id        bigint generated always as identity primary key,
  ts        timestamptz not null default now(),
  room_id   text not null references public.rooms(id) on delete cascade,
  temp      numeric(5,2),
  setpoint  numeric(4,1),
  valve     smallint,
  target    numeric(4,1),
  mode      text
);
create index if not exists room_readings_room_ts on public.room_readings (room_id, ts desc);

create table if not exists public.decisions (
  id       bigint generated always as identity primary key,
  ts       timestamptz not null default now(),
  kind     text not null,      -- 'mode' | 'write' | 'error'
  room_id  text references public.rooms(id) on delete set null,
  mode     text,
  target   numeric(4,1),
  reason   text,
  dry_run  boolean
);
create index if not exists decisions_ts on public.decisions (ts desc);

create table if not exists public.collector_status (
  id           int primary key default 1 check (id = 1),
  last_seen    timestamptz,
  version      text,
  house_mode   text,
  mode_since   timestamptz,
  mode_reason  text,
  pending_mode text,
  dry_run      boolean,
  fenecon_ok   boolean,
  loxone_ok    boolean,
  last_error   text
);
insert into public.collector_status (id) values (1) on conflict (id) do nothing;

-- updated_at automatisch pflegen
create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists settings_touch on public.settings;
create trigger settings_touch before update on public.settings for each row execute function public.touch_updated_at();
drop trigger if exists rooms_touch on public.rooms;
create trigger rooms_touch before update on public.rooms for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Zugriff: Die App (angemeldete Benutzer) darf lesen und Einstellungen/Räume ändern.
-- Der Collector nutzt den service_role-Key und umgeht RLS.
-- Anonyme Zugriffe sind gesperrt.
-- ---------------------------------------------------------------------------
alter table public.settings         enable row level security;
alter table public.rooms            enable row level security;
alter table public.energy_readings  enable row level security;
alter table public.room_readings    enable row level security;
alter table public.decisions        enable row level security;
alter table public.collector_status enable row level security;

do $$
declare t text;
begin
  foreach t in array array['settings','rooms','energy_readings','room_readings','decisions','collector_status'] loop
    execute format('drop policy if exists "auth read" on public.%I', t);
    execute format('create policy "auth read" on public.%I for select to authenticated using (true)', t);
  end loop;
end $$;

drop policy if exists "auth update" on public.settings;
create policy "auth update" on public.settings for update to authenticated using (true) with check (true);
drop policy if exists "auth update" on public.rooms;
create policy "auth update" on public.rooms for update to authenticated using (true) with check (true);

grant select on all tables in schema public to authenticated;
grant update on public.settings, public.rooms to authenticated;
grant all on all tables in schema public to service_role;

-- ---------------------------------------------------------------------------
-- Verlauf für die App: zu Zeitblöcken verdichtet (max. ~300 Punkte),
-- damit auch 7 Tage unter dem Supabase-Zeilenlimit bleiben.
-- ---------------------------------------------------------------------------
create or replace function public.history(p_hours int, p_room text)
returns table (
  bucket timestamptz, pv_w int, grid_w int, battery_w int, soc int, surplus_w int,
  temp numeric, setpoint numeric, target numeric, valve numeric
)
language sql stable security invoker set search_path = public as $$
  with params as (
    select now() - make_interval(hours => p_hours) as since,
           make_interval(mins => greatest(2, (p_hours * 60) / 300)) as step
  ),
  e as (
    select date_bin(p.step, r.ts, p.since) b,
           avg(pv_w)::int pv_w, avg(grid_w)::int grid_w, avg(battery_w)::int battery_w,
           avg(soc)::int soc, avg(surplus_w)::int surplus_w
    from energy_readings r, params p where r.ts >= p.since group by 1
  ),
  rr as (
    select date_bin(p.step, r.ts, p.since) b,
           round(avg(temp), 2) temp, round(avg(setpoint), 1) setpoint,
           round(avg(target), 1) target, round(avg(valve), 2) valve
    from room_readings r, params p where r.ts >= p.since and r.room_id = p_room group by 1
  )
  select coalesce(e.b, rr.b), e.pv_w, e.grid_w, e.battery_w, e.soc, e.surplus_w,
         rr.temp, rr.setpoint, rr.target, rr.valve
  from e full outer join rr on rr.b = e.b
  order by 1;
$$;
grant execute on function public.history(int, text) to authenticated;
