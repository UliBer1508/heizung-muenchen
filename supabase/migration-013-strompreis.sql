-- migration-013 (12.11.2026): Strompreis für die Netzkosten in Analyse › Woche/Monat/Jahr
-- Wie Heizung Venediger (energy_price_history): je Zeile ein Preis ab einem Datum; gilt bis zur nächsten Zeile.
-- Die Werte trägt Uli in der App unter Einstellungen › Strompreis ein (Rechnung München folgt).
-- Alle Beträge brutto (inkl. USt.):
--   grid_ct        Arbeitspreis je bezogener kWh (Energie + Netz + Abgaben)
--   feed_ct        Einspeisevergütung je kWh
--   base_eur_year  Grundpreis je Jahr (Grundgebühr + Messstelle), auf Tage verteilt
-- Nur muc_*-Tabellen, Venediger wird nicht berührt.

create table if not exists public.muc_prices (
  id            bigserial primary key,
  valid_from    date not null unique,
  grid_ct       numeric not null check (grid_ct >= 0 and grid_ct < 200),
  feed_ct       numeric not null default 0 check (feed_ct >= 0 and feed_ct < 100),
  base_eur_year numeric not null default 0 check (base_eur_year >= 0 and base_eur_year < 2000),
  note          text,
  created_at    timestamptz not null default now()
);

alter table public.muc_prices enable row level security;
drop policy if exists "muc auth read" on public.muc_prices;
drop policy if exists "muc auth write" on public.muc_prices;
create policy "muc auth read"  on public.muc_prices for select to authenticated using (true);
create policy "muc auth write" on public.muc_prices for all    to authenticated using (true) with check (true);
grant select, insert, update, delete on public.muc_prices to authenticated;
grant usage on sequence public.muc_prices_id_seq to authenticated;
grant all on public.muc_prices to service_role;

-- Prüfen
select count(*) as preise from public.muc_prices;
