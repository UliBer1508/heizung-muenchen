-- Heizung München – Migration 004: Wetter und PV-Prognose von FENECON (FEMS)
-- Im Supabase SQL-Editor ausführen, kann gefahrlos mehrfach ausgeführt werden. Ändert nur muc_-Objekte.
--
-- Der Collector liest alle 15 Minuten per REST vom FEMS:
--   weather0   = App "Wetter" (Temperatur, Wetterlage nach WMO-Schlüssel, Sonnenscheindauer)
--   predictor* = Erzeugungsprognose (PV) und Verbrauchsprognose des FEMS
-- "ahead"    = erwartete Leistung in N Stunden
-- "realized" = was das FEMS vor N Stunden für jetzt vorhergesagt hat (zur Prüfung der Genauigkeit)

create table if not exists public.muc_forecast (
  ts timestamptz primary key default now(),
  source text not null default 'fems',
  outdoor_c numeric, today_min_c numeric, today_max_c numeric, sunshine_today_s int, weather_code int,
  temp_4h numeric, temp_8h numeric, temp_12h numeric, temp_16h numeric, temp_20h numeric, temp_24h numeric,
  code_4h int, code_8h int, code_12h int, code_16h int, code_20h int, code_24h int,
  pv_1h int, pv_3h int, pv_6h int, pv_12h int, pv_24h int, pv_36h int,
  pv_real_1h int, pv_real_3h int, pv_real_6h int, pv_real_12h int, pv_real_24h int, pv_real_36h int,
  load_1h int, load_3h int, load_6h int, load_12h int, load_24h int, load_36h int,
  raw jsonb
);

alter table public.muc_forecast enable row level security;
drop policy if exists "muc auth read" on public.muc_forecast;
create policy "muc auth read" on public.muc_forecast for select to authenticated using (true);
revoke all on public.muc_forecast from anon;
grant select on public.muc_forecast to authenticated;
grant all on public.muc_forecast to service_role;

-- Herkunft der Außentemperatur in den Messwerten (fems oder open-meteo als Notlösung)
alter table public.muc_energy_readings add column if not exists outdoor_source text;

select 'muc_forecast angelegt' as ergebnis;
