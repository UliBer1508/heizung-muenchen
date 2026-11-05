-- Migration 011 – Prio-Gruppen statt eindeutiger Nummer (05.11.2026, Uli)
--
-- Jeder Raum bekommt Prio 1, 2, 3 oder 4; mehrere Räume dürfen dieselbe Prio haben.
-- Prio 1 wird zuerst geheizt, dann Prio 2 … Innerhalb einer Prio heizen höchstens
-- muc_settings.seq_max_rooms Räume gleichzeitig (0 = die ganze Prio), zuerst der, der am schnellsten fertig ist.
-- (Venediger hat weiterhin eindeutige Nummern P1–P12.)
-- Wiederholt ausführbar.

alter table public.muc_rooms drop constraint if exists muc_rooms_priority_key;
alter table public.muc_rooms drop constraint if exists muc_rooms_priority_check;

-- Startwerte nur beim ersten Mal (solange noch die alten Nummern über 4 stehen)
do $$
begin
  if exists (select 1 from public.muc_rooms where priority is null or priority > 4) then
    update public.muc_rooms set priority = case
      when name in ('OG Luis Bad', 'OG Luis Schlafzimmer', 'OG Eltern Bad', 'OG Eltern Schlafzimmer') then 1
      when name = 'KG Bad' then 4
      else 2 end;
  end if;
end $$;

alter table public.muc_rooms add constraint muc_rooms_priority_check check (priority between 1 and 4);

select priority as prio, string_agg(name, ', ' order by sort) as raeume from public.muc_rooms group by 1 order by 1;
