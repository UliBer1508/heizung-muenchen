-- Migration 010 – Heiz-Reihenfolge wie in Venediger (Collector 0.9.0)
--
-- Venediger: rooms.priority, je Raum eindeutig (P1, P2, P3 …), Tauschen per ▲▼.
-- München jetzt gleich: muc_rooms.priority (ersetzt heat_rank aus Migration 008).
-- Die Automatik heizt zuerst P1, dann P2 … – höchstens muc_settings.seq_max_rooms Räume gleichzeitig.
-- Wiederholt ausführbar.

alter table public.muc_rooms add column if not exists priority smallint check (priority is null or priority between 1 and 99);

-- Startreihenfolge: Küche/Essbereich, EG Büro, EG WC zuerst … Schlafzimmer zuletzt (nur wenn noch leer)
do $$
begin
  if not exists (select 1 from public.muc_rooms where priority is not null) then
    with wunsch(name, pos) as (values
      ('EG Küche/Essbereich', 1), ('EG Büro', 2), ('EG WC', 3), ('EG Wohnzimmer', 4), ('EG Eingang', 5),
      ('OG Eltern Bad', 6), ('OG Luis Bad', 7), ('DG Bad', 8), ('DG Wohnen/Essen/Küche', 9),
      ('OG Büro', 10), ('OG Ankleidezimmer', 11), ('KG Bad', 12),
      ('OG Eltern Schlafzimmer', 13), ('OG Luis Schlafzimmer', 14), ('DG Schlafzimmer', 15)
    ), alle as (
      select r.id, row_number() over (order by coalesce(w.pos, 100), r.sort) as p
      from public.muc_rooms r left join wunsch w on w.name = r.name
    )
    update public.muc_rooms r set priority = least(alle.p, 99) from alle where alle.id = r.id;
  end if;
end $$;

-- eindeutig wie in Venediger (NULL erlaubt, damit zwei Räume getauscht werden können)
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'muc_rooms_priority_key') then
    alter table public.muc_rooms add constraint muc_rooms_priority_key unique (priority);
  end if;
end $$;

alter table public.muc_rooms drop column if exists heat_rank;
alter table public.muc_settings alter column seq_max_rooms set default 1;
update public.muc_settings set seq_max_rooms = 1 where seq_max_rooms = 0;

select priority, name, enabled from public.muc_rooms order by priority;
