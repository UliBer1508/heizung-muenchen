# Karte „Heizung jetzt“ in der Übersicht (10.11.2026)

## Anlass
Heizung Venediger hat seit dem 06.11.2026 die Karte „Heizung jetzt“. Uli wollte sie auch für München.

## Warum sie anders aussieht als in Venediger
Venediger heizt elektrisch direkt. Jeder Raum hat eine feste, gemessene Leistung, deshalb lassen sich dort „gemessen“ und „laut Thermostaten“ in Watt vergleichen.
München heizt mit einer Wärmepumpe über eine Wasser-Fußbodenheizung, mit einem Ventil je Raum. Ein offener Kreis hat keine eigene Leistung, und die Wärmepumpe wird noch nicht gemessen; die Strommessung ist im KONZEPT als Phase 2 vorgesehen.

## Inhalt der Karte
- **Wärmepumpe (geschätzt):** Verbrauch − Auto − Grundlast (`muc_settings.baseload_w`). Das ist dieselbe Formel wie in `muc_energy_rows` und im Analyse-Tab.
  - Aufgeteilt nach Sonne, Akku und Netz, mit denselben Anteilen wie in `muc_energy_rows`.
- **Kreise offen:** Räume mit `valve = 1` in der letzten Messung, verglichen mit `max_grid_circuits`.
- **Heizstrom heute:** `muc_day_kpis(heute)`, Feld `heat_kwh`. In der Fußzeile die Aufteilung nach Sonne, Akku und Netz.
- **Plausibilität:**
  - Kein Kreis offen, aber Wärmepumpe über 800 W: Hinweis auf Warmwasser oder einen anderen Verbraucher.
  - Kreise offen, aber Wärmepumpe unter 300 W: Die Wärmepumpe läuft gerade nicht, sie schaltet nach Vorlauftemperatur. Das ist normal.
- **Offene Räume mit „offen seit“:** die letzte Messung mit geschlossenem Ventil der letzten 24 h, auf etwa 1 min genau (Messung jede Minute).

## Dateien
- `frontend/src/HeatingNow.jsx` (neu)
- `frontend/src/Overview.jsx`: Karte unter Betriebsmodus und Energie
- `frontend/src/styles.css`: Klassen `.heatnow*`

## Nebenwirkungen
- Die Karte liest nur; der Collector, die Steuerung und SQL sind unverändert.
- Zusätzliche Abfragen alle 5 Minuten: ein RPC und je offenem Raum eine kleine Abfrage (höchstens so viele wie offene Kreise).
- Mit Live-Daten vom 10.11.2026 um 12:14 nachgerechnet:
  - Verbrauch 1701 W, Auto 0, Grundlast 350 W, also Wärmepumpe etwa 1,35 kW
  - 6 von 6 Kreisen offen
  - Heizstrom heute 19,9 kWh, davon 19,3 kWh aus dem Netz

## Einspielen
Mergen bzw. hochladen, Vercel deployt automatisch. Es ist kein SQL nötig.
