-- Heizung München – Migration 012: Tagesmodi wie in Venediger (Collector 0.11)
-- Konzept: doc/KONZEPT-TAGESMODI-2026-11-09.md
-- Im Supabase SQL-Editor ausführen, kann gefahrlos mehrfach ausgeführt werden. Ändert nur muc_-Objekte.
--
-- Modell a (Überschuss): so viele Räume, wie der Überschuss trägt (surplus_on_w, stage_up_w, surplus_off_w wie bisher).
-- Modell b (ohne Überschuss): höchstens max_grid_circuits Kreise gleichzeitig (Netzgrenze).
-- Wartetag: Ist heute noch mindestens wait_min_kwh Überschuss zu erwarten, halten die Räume nur ihre Untergrenze.
-- Untergrenze je Raum = muc_rooms.temp_night (bisher „Absenk“) – Ziel nachts, abends und am Wartetag.
-- Nicht mehr verwendet (Spalten bleiben): sequence_enabled, seq_max_rooms, seq_max_minutes, reserve_soc,
-- muc_rooms.heat_evening; muc_rooms.pv_prio nur noch 0 = „nie mit PV laden“.

alter table public.muc_settings add column if not exists max_grid_circuits integer not null default 6
  check (max_grid_circuits between 1 and 20);
alter table public.muc_settings add column if not exists wait_min_kwh numeric(4,1) not null default 5
  check (wait_min_kwh between 0 and 50);
alter table public.muc_settings add column if not exists battery_kwh numeric(4,1) not null default 10
  check (battery_kwh between 1 and 100);
alter table public.muc_settings add column if not exists wait_boost_min integer not null default 60
  check (wait_boost_min between 0 and 600);

comment on column public.muc_settings.max_grid_circuits is 'Netzgrenze: so viele Kreise heizen ohne PV-Überschuss gleichzeitig (Konzept 09.11.2026 §5)';
comment on column public.muc_settings.wait_min_kwh is 'Wartetag, wenn heute noch so viel Überschuss erwartet wird (kWh, 0 = nie warten)';
comment on column public.muc_settings.battery_kwh is 'Akku-Kapazität für die Wartetag-Rechnung (Akku bis voll)';
comment on column public.muc_settings.wait_boost_min is 'Wer so lange wartet, kommt zuerst dran (min)';
comment on column public.muc_rooms.temp_night is 'Untergrenze: Ziel nachts, abends und am Wartetag; darunter wird geheizt (bis 0.10 „Absenk“)';

alter table public.muc_collector_status add column if not exists day_mode text;

select 'migration-012 ausgeführt' as ergebnis;
