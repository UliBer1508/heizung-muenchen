-- Migration 008 – Heiz-Reihenfolge (Collector 0.7.0)
--
-- Wie in Venediger: Räume werden nacheinander geheizt.
--   muc_rooms.heat_rank        1 = zuerst; gleicher Rang = gemeinsam; leer = ganz hinten
--   muc_settings.sequence_enabled   Schalter (Aus = alle Räume heizen gleichzeitig wie bis 0.6)
--   muc_settings.seq_on_delta       Raum gilt als fertig ab Soll − 0,3 °C
--   muc_settings.seq_off_delta      … und wieder als offen unter Soll − 0,8 °C
--   muc_settings.seq_max_minutes    kommt ein Rang so lange nicht ans Ziel, darf zusätzlich der nächste
--   muc_collector_status.sequence_info   welcher Rang gerade dran ist (Anzeige in der App)
--
-- Räume mit späterem Rang bekommen ihren Absenkwert, bis alle Räume davor ihren Sollwert erreicht haben.
-- Wiederholt ausführbar.

alter table public.muc_rooms add column if not exists heat_rank smallint check (heat_rank is null or heat_rank between 1 and 99);

alter table public.muc_settings add column if not exists sequence_enabled boolean not null default true;
alter table public.muc_settings add column if not exists seq_on_delta numeric not null default 0.3 check (seq_on_delta between 0 and 2);
alter table public.muc_settings add column if not exists seq_off_delta numeric not null default 0.8 check (seq_off_delta between 0 and 3);
alter table public.muc_settings add column if not exists seq_max_minutes integer not null default 180 check (seq_max_minutes between 0 and 1440);

alter table public.muc_collector_status add column if not exists sequence_info text;

-- Startreihenfolge (nur wenn noch keine gesetzt ist): zuerst Küche/Essbereich, EG Büro, EG WC,
-- dann übriges EG, Bäder, Wohnräume oben, Nebenräume, Schlafzimmer zuletzt. In der App änderbar.
do $$
begin
  if not exists (select 1 from public.muc_rooms where heat_rank is not null) then
    with wunsch(name, pos) as (values
      ('EG Küche/Essbereich', 1), ('EG Büro', 2), ('EG WC', 3), ('EG Wohnzimmer', 4), ('EG Eingang', 5),
      ('OG Eltern Bad', 6), ('OG Luis Bad', 7), ('DG Bad', 8), ('DG Wohnen/Essen/Küche', 9),
      ('OG Büro', 10), ('OG Ankleidezimmer', 11), ('KG Bad', 12),
      ('OG Eltern Schlafzimmer', 13), ('OG Luis Schlafzimmer', 14), ('DG Schlafzimmer', 15)
    ), alle as (
      select r.id, row_number() over (order by coalesce(w.pos, 100), r.sort) as rang
      from public.muc_rooms r left join wunsch w on w.name = r.name
    )
    update public.muc_rooms r set heat_rank = least(alle.rang, 99) from alle where alle.id = r.id;
  end if;
end $$;

select name, enabled, heat_rank, pv_prio from public.muc_rooms order by heat_rank, sort;
