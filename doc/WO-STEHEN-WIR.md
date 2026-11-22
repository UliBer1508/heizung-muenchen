# Auto-Steuerung › „Wo stehen wir?“ und Heizstrom Woche/Monat/Jahr (22.11.2026)

**SQL:** `supabase/migration-015-wo-stehen-wir.sql` · **App:** `frontend/src/auto/WoStehenWir.jsx` (Auto-Steuerung, Abschnitt 1),
`frontend/src/HeatingNow.jsx` (Übersicht, Kachel Heizstrom)
**Vorbild:** Venediger `src/components/ki/OptimierungView.tsx`, SQL 44/48/49/50, `doc/FIX-WO-STEHEN-WIR-AKTUELL-2026-11-22.md` (Commit 0e1c6c6)

**Uli, 22.11.2026:** „Hier haben wir doch das gleiche Problem wie in Venediger: Von wann sind die Daten und sind diese aktuell,
warum gibt es nicht Woche, Monat, Jahr?“ → „umsetzen wie beschrieben“.

## Befund (22.11.2026, 14:46)

| Was | Stand | Bewertung |
|---|---|---|
| Live-Werte (`muc_energy_readings`, `muc_room_readings`) | 14:46 | aktuell, jede Minute |
| Heizstrom heute (`muc_day_kpis`) | bei jedem Laden | aktuell, aber nur „heute“ |
| Stundenwerte (`muc_energie_stunde`) | 14:00, Cron :09 | aktuell |
| Tageswerte (`muc_daily_stats`) | 22.10.–21.11. (31 Tage) | vollständig bis gestern |
| Strompreis (`muc_prices`) | **leer** | deshalb keine Euro-Beträge |

Die Daten waren aktuell. Es fehlte die Sicht über Woche, Monat und Jahr in der Übersicht und der Abschnitt
„Wo stehen wir?“, den Venediger am 15.11. bekommen hat (nach der Übernahme der Auto-Steuerung am 12.11.).

## Was gebaut wurde

**Übersicht › Heizung jetzt:** Die Kachel „Heizstrom“ hat **Heute · Woche · Monat · Jahr**. Tage bis gestern kommen aus den
gespeicherten Tageswerten (`muc_heizstrom_seit`), heute live. Darunter: seit wann, wie viele Tage, Aufteilung Sonne/Akku/Netz.

**Auto-Steuerung › 1 Wo stehen wir?** (die bisherigen Abschnitte sind jetzt 2 Verlauf und Wirkung, 3 Steuerung, 4 Plan)
- Zeitraum **Woche · Monat · Jahr** mit ◀ ▶. Start: die Woche von gestern; ein laufender Zeitraum zählt bis gestern.
- Kopfzeile mit Zeitraum, Tagen, „läuft noch“, **Stand … Uhr** (letzte Berechnung) und Abdeckung der Vorperiode.
- Strom: Verbrauch, Sonne selbst genutzt, aus dem Netz, davon Heizung – mit Strompreis in Euro (wie Venediger).
- Ampeln: Sonnenstrom genutzt · kWh je Heizgradtag · Räume nachts über Untergrenze · wer steuert.
- Jede Zahl mit Vergleich zu Vorwoche/Vormonat/Vorjahr **je Tag**; kein Vergleich, wenn die Vorperiode keine Daten hat.
- „Wohin wollen wir?“: Ziel kWh je Heizgradtag – **ohne Vorgabe**, Uli legt es selbst fest (`muc_settings.ziel_kwh_je_hgt`).
- Verlauf je Woche (letzte 8) bzw. je Monat (Jahr), darunter Netzstrom je Tag.
- KI-Vorschläge: Zahl offener Vorschläge, zuletzt übernommene mit Wirkung, Knopf zum Tab KI.
- Neu laden alle 10 min und beim Zurückkehren in die App.

## Unterschiede zu Venediger (nur wo München es verlangt)

- **Heizstrom geschätzt** (Verbrauch − Auto − Grundlast), bis die Wärmepumpe am LAN hängt. Venediger misst über die Thermostate.
- **Euro** aus `muc_prices` je Tag gerechnet (Einstellungen › Strompreis). Ohne Preis zeigt die Anzeige kWh.
- **„Min“ = Untergrenze** (`muc_rooms.temp_night`); nachts = `night_start`…`night_end`. Neue Tagesspalte
  `muc_energie_tag.raum_h_unter_min`, stündlich für heute und gestern (`muc_energie_verlauf_tick`), Nachtrag für alle Tage
  mit Raumwerten (Raumwerte werden nach 90 Tagen gelöscht, die Tageszahl bleibt).
- Kein Abgleich mit einer Stromrechnung und keine KI-Gegenrechnung (in München zeigt „Plan“ die Gegenrechnung des Planers).

## Erste Werte (KW 47, 16.–21.11.2026)

Verbrauch 250 kWh, Netz 201 kWh, davon Heizung 126 kWh (geschätzt), Sonne selbst genutzt 52 kWh (96 %),
**2,8 kWh je Heizgradtag** (Vorwoche 2,4). Räume nachts unter Untergrenze: Ø 46 Raum-Stunden je Nacht – am 21.11. vor allem
OG Eltern Schlafzimmer (bis 19,0 °C bei Untergrenze 21), OG Ankleidezimmer (17,3 / 20), OG Eltern Bad (20,5 / 21).

## Betrieb

- Prüfen: `select muc_wo_stehen_wir(current_date - 1, 7);` · `select muc_wo_stehen_wir_verlauf('woche', current_date - 1, 8);`
  · `select muc_heizstrom_seit(date_trunc('month', current_date)::date);`
- Strompreis eintragen: App › Einstellungen › Strompreis (gilt ab dem eingetragenen Datum, sofort für alle Tage).
