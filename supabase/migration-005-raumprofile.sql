-- Heizung München – Migration 005: Tagesphasen, PV-Stufen und Raumprofile (Collector 0.5)
--
-- Neu je Raum:
--   heat_morning  Morgens (Aufstehen bis Morgen-Ende) auf Normal heizen
--   heat_day      Tagsüber auch ohne Sonne auf Normal halten
--   heat_evening  Abends auf Normal halten, wenn der Akku ≥ reserve_soc ist
--   pv_prio       0 = nie mit PV aufheizen, 1 = zuerst, 2 = danach, 3 = zuletzt
-- Neu im Haus:
--   morning_start / morning_end   Morgenfenster
--   stage_up_w                    nächste PV-Stufe, wenn trotz Heizung noch so viel übrig ist
--
-- Die Vorbelegung unten wird NUR beim ersten Ausführen gesetzt. Danach stellst du
-- alles in der App unter „Einstellungen“ ein; ein erneutes Ausführen überschreibt nichts.

do $$
begin
  -- ---------------------------------------------------------------- Räume
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'muc_rooms' and column_name = 'pv_prio') then
    alter table public.muc_rooms
      add column heat_morning boolean not null default false,
      add column heat_day     boolean not null default false,
      add column heat_evening boolean not null default false,
      add column pv_prio      smallint not null default 2 check (pv_prio between 0 and 3);

    -- Kernräume: morgens und tagsüber warm, zuerst mit PV
    update public.muc_rooms set heat_morning = true, heat_day = true, pv_prio = 1
     where name in ('EG Küche/Essbereich', 'EG Büro', 'EG WC');
    update public.muc_rooms set heat_evening = true
     where name in ('EG Küche/Essbereich', 'EG Wohnzimmer');
    update public.muc_rooms set pv_prio = 1 where name = 'EG Wohnzimmer';
    -- Schlafräume und Ankleide: nur mit viel Sonne
    update public.muc_rooms set pv_prio = 3
     where name ilike '%schlaf%' or name ilike '%ankleide%';
    -- alle übrigen (Bäder, DG Wohnen, OG Büro, EG Eingang …): Prio 2, sonst nur Absenkwert
  end if;

  -- ---------------------------------------------------------------- Haus
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'muc_settings' and column_name = 'morning_start') then
    alter table public.muc_settings
      add column morning_start text not null default '06:00',
      add column morning_end   text not null default '09:00',
      add column stage_up_w    int  not null default 1000;
    update public.muc_settings
       set night_start = '22:00', evening_start = '17:00', reserve_soc = 60
     where id = 1;
  end if;
end $$;

-- Kontrolle
select name, heat_morning as morgens, heat_day as tags, heat_evening as abends, pv_prio
  from public.muc_rooms order by sort;
