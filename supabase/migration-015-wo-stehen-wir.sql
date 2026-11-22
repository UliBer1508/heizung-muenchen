-- Heizung München – Migration 015: Auto-Steuerung › „Wo stehen wir?“ mit Woche / Monat / Jahr (22.11.2026)
-- Doku: doc/WO-STEHEN-WIR.md
--
-- Uli (22.11.2026): „Hier haben wir doch das gleiche Problem wie in Venediger: Von wann sind die Daten, sind diese
-- aktuell, warum gibt es nicht Woche, Monat, Jahr?“ → „umsetzen wie beschrieben“.
--
-- ÜBERNOMMEN aus Heizung Venediger (smartfox-insight-ai-selfhosted, Commit 0e1c6c6):
--   SQL 44/48/49 optimierung_woche  → muc_wo_stehen_wir(p_bis, p_tage)
--   SQL 49      optimierung_verlauf → muc_wo_stehen_wir_verlauf(p_einheit, p_bis, p_anzahl)
--   SQL 50      Heizstrom nach Quelle (Netz/Sonne/Batterie) → aus muc_daily_stats (heat_grid/sun/bat_kwh)
-- Unterschiede zu Venediger (nur dort, wo München es verlangt):
--   - Heizstrom ist in München GESCHÄTZT (Verbrauch − Auto − Grundlast), bis die Wärmepumpe am LAN hängt.
--   - Kosten werden aus muc_prices (Einstellungen › Strompreis) je Tag gerechnet – nicht aus den gespeicherten
--     Spalten von muc_energie_tag, damit ein später eingetragener Preis sofort für alle Tage gilt.
--   - „Min“ heißt in München Untergrenze (muc_rooms.temp_night). Nachts = muc_settings.night_start … night_end.
--   - Kein Abgleich mit einer Stromrechnung (in München noch keine Rechnung hinterlegt).
--   - Ziel kWh je Heizgradtag: neue Spalte muc_settings.ziel_kwh_je_hgt, ohne Vorgabe – Uli setzt es selbst.
-- Kann gefahrlos mehrfach ausgeführt werden. Ändert nur muc_-Objekte.

-- 1 · Raum-Stunden nachts unter der Untergrenze (je Kalendertag, Nachtstunden des Tages) ---------------------------
alter table public.muc_energie_tag add column if not exists raum_h_unter_min numeric;
alter table public.muc_settings   add column if not exists ziel_kwh_je_hgt numeric;

create or replace function public.muc_raum_h_unter_min(p_tag date)
returns numeric
language sql stable security definer set search_path = public as $function$
  with b as (select * from muc_day_bounds(p_tag)),
  s as (select night_start ns, night_end ne from muc_settings where id = 1),
  r as (
    select rr.room_id, rr.temp, to_char(rr.ts at time zone 'Europe/Berlin', 'HH24:MI') hm,
           least(extract(epoch from lead(rr.ts) over (partition by rr.room_id order by rr.ts) - rr.ts), 300) dt
    from muc_room_readings rr, b
    where rr.ts >= b.t0 and rr.ts < b.t1 and rr.temp is not null
  )
  select case when count(*) = 0 then null else round(coalesce(sum(r.dt) filter (where
           (r.hm >= s.ns or r.hm < s.ne) and r.temp < m.temp_night - 0.3), 0) / 3600.0, 1) end
  from r join muc_rooms m on m.id = r.room_id and m.enabled, s
  where r.dt is not null;
$function$;

-- stündlicher Tick (Cron muc-energie-verlauf): zusätzlich heute und gestern unter Untergrenze
create or replace function public.muc_energie_verlauf_tick()
returns void
language plpgsql security definer set search_path = public as $function$
declare v_heute date := (now() at time zone 'Europe/Berlin')::date;
begin
  perform muc_energie_stunde_rechnen(now() - interval '3 hours', now());
  perform muc_energie_tag_rechnen(v_heute);
  perform muc_energie_tag_rechnen(v_heute - 1);
  update muc_energie_tag t set raum_h_unter_min = coalesce(muc_raum_h_unter_min(t.tag), t.raum_h_unter_min)
   where t.tag in (v_heute, v_heute - 1);
end $function$;

-- Nachtrag für alle Tage, für die es noch Raumwerte gibt
update public.muc_energie_tag t set raum_h_unter_min = coalesce(public.muc_raum_h_unter_min(t.tag), t.raum_h_unter_min);

-- 2 · Grundlage je Tag (volle Tage ≥ 20 h) ---------------------------------------------------------------------------
create or replace function public.muc_wo_stehen_wir_tage(p_von date, p_bis date)
returns table (tag date, pv numeric, verbrauch numeric, heizung numeric, heiz_netz numeric, heiz_sonne numeric, heiz_batt numeric,
               netz numeric, einsp numeric, netz_leer numeric, bezug_ct numeric, einspeise_ct numeric, grund_eur numeric,
               h_unter_min numeric, h_unter_normal numeric, aussen numeric, hgt numeric)
language sql stable security definer set search_path = public as $function$
  select e.tag, coalesce(e.pv_kwh, 0), coalesce(e.verbrauch_kwh, 0), coalesce(e.heizung_kwh, 0),
         d.heat_grid_kwh, d.heat_sun_kwh, d.heat_bat_kwh,
         coalesce(e.netz_kwh, 0), coalesce(e.einspeisung_kwh, 0), coalesce(e.netz_batt_leer_kwh, 0),
         p.grid_ct, p.feed_ct, round(p.base_eur_year / 365.0, 4),
         e.raum_h_unter_min, e.raum_h_unter_ziel,
         coalesce(e.aussen_avg, d.outdoor_avg), greatest(0, 18 - coalesce(e.aussen_avg, d.outdoor_avg))
  from muc_energie_tag e
  left join muc_daily_stats d on d.day = e.tag
  left join lateral (select grid_ct, feed_ct, base_eur_year from muc_prices where valid_from <= e.tag
                     order by valid_from desc limit 1) p on true
  where e.tag >= p_von and e.tag <= p_bis and coalesce(e.stunden, 24) >= 20;
$function$;

-- 3 · Kennzahlen für einen Zeitraum (bis p_bis inkl., p_tage Tage) ---------------------------------------------------
create or replace function public.muc_wo_stehen_wir(p_bis date default null, p_tage integer default 7)
returns jsonb
language sql stable security definer set search_path = public as $function$
with g as (
  select coalesce(p_bis, (now() at time zone 'Europe/Berlin')::date - 1) as bis,
         greatest(1, least(coalesce(p_tage, 7), 400)) as n
),
z as (select t.* from g, muc_wo_stehen_wir_tage(g.bis - g.n + 1, g.bis) t),
s as (
  select count(*) tage, min(tag) von, max(tag) bis,
         sum(pv) pv, sum(verbrauch) verbrauch, sum(heizung) heizung, sum(netz) netz, sum(einsp) einsp, sum(netz_leer) netz_leer,
         sum(heiz_netz) heiz_netz, sum(heiz_sonne) heiz_sonne, sum(heiz_batt) heiz_batt,
         count(bezug_ct) tage_preis,
         sum(netz * bezug_ct / 100.0) netz_eur, sum(einsp * einspeise_ct / 100.0) einsp_eur, sum(grund_eur) grund_eur,
         sum(verbrauch * bezug_ct / 100.0) ohne_pv_eur, sum(heiz_netz * bezug_ct / 100.0) heiz_netz_eur,
         sum(h_unter_min) h_unter_min, sum(h_unter_normal) h_unter_normal,
         count(h_unter_min) tage_min, count(h_unter_normal) tage_normal,
         sum(heizung) filter (where hgt > 0) heiz_hgt, sum(hgt) filter (where hgt > 0) hgt
  from z
)
select jsonb_build_object(
  'von', s.von, 'bis', s.bis, 'tage', s.tage, 'tage_min', s.tage_min, 'tage_normal', s.tage_normal,
  'tage_preis', s.tage_preis,
  'stand', (select max(berechnet_at) from muc_energie_tag),
  'summe', jsonb_build_object(
    'pv_kwh', round(s.pv, 1), 'verbrauch_kwh', round(s.verbrauch, 1), 'heizung_kwh', round(s.heizung, 1),
    'heizung_netz_kwh', round(s.heiz_netz, 1), 'heizung_pv_kwh', round(s.heiz_sonne, 1), 'heizung_batt_kwh', round(s.heiz_batt, 1),
    'rest_netz_kwh', round(greatest(0, s.netz - coalesce(s.heiz_netz, 0)), 1),
    'netz_kwh', round(s.netz, 1), 'einspeisung_kwh', round(s.einsp, 2), 'netz_leer_kwh', round(s.netz_leer, 1),
    'eigen_pct', case when s.pv > 0 then round(100 * (s.pv - s.einsp) / s.pv, 1) end,
    'netz_eur', round(s.netz_eur, 2), 'einspeise_eur', round(s.einsp_eur, 2), 'grund_eur', round(s.grund_eur, 2),
    'ohne_pv_eur', round(s.ohne_pv_eur, 2),
    'pv_ersparnis_eur', round(s.ohne_pv_eur - s.netz_eur + coalesce(s.einsp_eur, 0), 2),
    'heizung_netz_eur', round(s.heiz_netz_eur, 2),
    'kwh_je_hgt', round(s.heiz_hgt / nullif(s.hgt, 0), 2),
    'h_unter_min', round(s.h_unter_min, 1), 'h_unter_normal', round(s.h_unter_normal, 0)
  ),
  'tage_liste', coalesce((select jsonb_agg(jsonb_build_object(
      'tag', z.tag, 'heizung', round(z.heizung, 1), 'netz', round(z.netz, 1), 'aussen', round(z.aussen, 1),
      'kwh_je_hgt', case when z.hgt > 0 then round(z.heizung / z.hgt, 2) end,
      'h_unter_min', z.h_unter_min) order by z.tag) from z), '[]'::jsonb),
  'ziel', (select ziel_kwh_je_hgt from muc_settings where id = 1),
  'planer_modus', (select planer_modus from muc_settings where id = 1)
)
from s;
$function$;

-- 4 · Verlauf je Woche (Mo–So) oder Kalendermonat, die letzten p_anzahl bis p_bis ------------------------------------
create or replace function public.muc_wo_stehen_wir_verlauf(p_einheit text default 'woche', p_bis date default null, p_anzahl integer default 8)
returns jsonb
language sql stable security definer set search_path = public as $function$
with g as (
  select case when p_einheit = 'monat' then 'month' else 'week' end feld,
         coalesce(p_bis, (now() at time zone 'Europe/Berlin')::date - 1) bis,
         greatest(1, least(coalesce(p_anzahl, 8), 36)) n
),
gr as (select feld, bis, (date_trunc(feld, bis) - ((n - 1) || ' ' || feld)::interval)::date von from g),
z as (select date_trunc(gr.feld, t.tag)::date beginn, t.* from gr, muc_wo_stehen_wir_tage(gr.von, gr.bis) t)
select coalesce(jsonb_agg(jsonb_build_object(
    'von', beginn, 'bis', bis, 'tage', tage,
    'kwh_je_hgt', round(kwh_je_hgt, 2), 'heizung_kwh', round(heizung, 1),
    'netz_kwh', round(netz, 1), 'netz_kwh_je_tag', round(netz / tage, 1),
    'netz_eur_je_tag', round(netz_eur / nullif(tage_preis, 0), 2),
    'eigen_pct', case when pv > 0 then round(100 * (pv - einsp) / pv, 1) end,
    'h_min_je_nacht', round(h_min / nullif(tage_min, 0), 1)) order by beginn), '[]'::jsonb)
from (
  select beginn, max(tag) bis, count(*) tage,
         sum(heizung) filter (where hgt > 0) / nullif(sum(hgt) filter (where hgt > 0), 0) kwh_je_hgt,
         sum(heizung) heizung, sum(netz) netz, sum(netz * bezug_ct / 100.0) netz_eur, count(bezug_ct) tage_preis,
         sum(pv) pv, sum(einsp) einsp, sum(h_unter_min) h_min, count(h_unter_min) tage_min
  from z group by beginn
) x;
$function$;

-- 5 · Heizstrom für die Übersicht: Summe seit p_von (bis gestern aus den Tageswerten) -------------------------------
create or replace function public.muc_heizstrom_seit(p_von date)
returns jsonb
language sql stable security definer set search_path = public as $function$
  select jsonb_build_object('tage', count(*), 'von', min(day), 'bis', max(day),
           'heat_kwh', round(sum(heat_kwh), 1), 'heat_pv_kwh', round(sum(heat_sun_kwh), 1),
           'heat_bat_kwh', round(sum(heat_bat_kwh), 1), 'heat_grid_kwh', round(sum(heat_grid_kwh), 1))
  from muc_daily_stats
  where day >= p_von and day < (now() at time zone 'Europe/Berlin')::date;
$function$;

revoke all on function public.muc_wo_stehen_wir(date, integer) from public, anon;
revoke all on function public.muc_wo_stehen_wir_verlauf(text, date, integer) from public, anon;
revoke all on function public.muc_wo_stehen_wir_tage(date, date) from public, anon;
revoke all on function public.muc_heizstrom_seit(date) from public, anon;
revoke all on function public.muc_raum_h_unter_min(date) from public, anon;
grant execute on function public.muc_wo_stehen_wir(date, integer) to authenticated;
grant execute on function public.muc_wo_stehen_wir_verlauf(text, date, integer) to authenticated;
grant execute on function public.muc_heizstrom_seit(date) to authenticated;

-- Prüfen:
--   select muc_wo_stehen_wir(current_date - 1, 7);
--   select muc_wo_stehen_wir_verlauf('woche', current_date - 1, 8);
--   select muc_heizstrom_seit(date_trunc('month', current_date)::date);
