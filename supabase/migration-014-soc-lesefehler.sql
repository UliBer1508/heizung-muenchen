-- migration-014 (12.11.2026): Lesefehler Ladestand bereinigen
-- Am 05.11.2026 12:38–12:40 lieferte das FEMS bei einem Aussetzer 65535 (0xFFFF = „unbekannt“) als Ladestand.
-- Ab Collector 0.11.1 wird ein Ladestand außerhalb 0–100 % als null gespeichert. Hier die vorhandenen Fehlwerte
-- auf null setzen und den betroffenen Tag neu speichern (muc_daily_stats.soc_max war 65535).
-- Am 12.11.2026 ausgeführt.

update public.muc_energy_readings set soc = null where soc < 0 or soc > 100;

select public.muc_store_day(d)
from (select distinct (ts at time zone 'Europe/Berlin')::date as d
      from public.muc_energy_readings where ts between '2026-11-05' and '2026-11-06') x;

-- Prüfen
select day, soc_min, soc_max from public.muc_daily_stats where soc_max > 100 or soc_min < 0;
