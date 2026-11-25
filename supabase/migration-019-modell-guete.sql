-- migration-019 · Vorhersage-Güte des Raummodells je Nacht (25.11.2026) – wie Venediger SQL 58
-- Uli: „Lernt das Modell dazu ist wichtig.“ Vor dem nächtlichen Neu-Lernen (heizplaner-muenchen aktion „lernen“, ~03:00)
-- sagt das Modell von gestern die seither gemessenen Stunden 12 h voraus (nie gesehen). Vergleich: „bleibt gleich“.
-- Angezeigt in Auto-Steuerung › Wo stehen wir? › „Lernt das Modell dazu?“. Ändert nichts an der Steuerung.
create table if not exists public.muc_heizmodell_guete (
  tag               date        not null,                  -- Tag der Prüfung (Münchner Zeit)
  room_id           text        not null references public.muc_rooms(id) on delete cascade,
  raum              text,
  fehler_12h        numeric,                               -- mittlere Abweichung nach 12 h (°C)
  gleich_12h        numeric,                               -- Vergleich „Temperatur bleibt gleich“ (°C)
  n                 integer,                               -- Fenster (je Stunde eins)
  fehler_12h_heizen numeric,                               -- nur Fenster, in denen geheizt wurde
  n_heizen          integer,
  modell_von        timestamptz,                           -- gelernt_at des geprüften Modells
  erstellt_at       timestamptz not null default now(),
  primary key (tag, room_id)
);

alter table public.muc_heizmodell_guete enable row level security;
drop policy if exists "muc auth read" on public.muc_heizmodell_guete;
create policy "muc auth read" on public.muc_heizmodell_guete for select to authenticated using (true);
grant select on public.muc_heizmodell_guete to authenticated;
-- Schreiben nur die Edge Function (service_role).

-- Prüfung: select * from muc_heizmodell_guete order by tag desc, raum;
