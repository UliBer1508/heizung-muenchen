# Auto-Steuerung München (12.11.2026)

**Uli, 12.11.2026:**
- „Ich will eine Auto-Steuerung auch in München.“
- „Ich möchte wie in Venediger die Analyse, wie sie ist, und zusätzlich die Auto-Steuerung.“
- „In Venediger haben wir Steuerung und Planung in diesem Teil.“ → „ok umsetzen.“
- Grundregel (doc/KONZEPT.md): aus Venediger übernehmen, nicht neu entwickeln; alles liegt im München-Repo und wird
  von hier deployt; Venediger wird nicht geändert.

## Was es ist

Neuer erster Tab **Auto-Steuerung** (Startseite), Aufbau wie in Venediger:

1. **Verlauf und Wirkung:** Tag/Woche/Monat/Jahr, Vergleich Vorperiode/Vorjahr/aus, acht Kacheln, Leistungsgrafik
   mit KI-Marken ▼n, Batterie, Netzkosten mit Planer, Haus unter Ziel, Wirkung je KI-Vorschlag (3 Tage vorher → nachher).
2. **Steuerung:** Modus Aus / Schatten / Steuern (Steuern noch gesperrt, wie in Venediger), Regler
   *Sparsamer ↔ wärmer*, *Netzgrenze ohne Sonne*, *Sicherheit unter Untergrenze*, Hinweise zu einzelnen Räumen, offene KI-Vorschläge.
3. **Plan:** 24-h-Plan des Planers (PV-Vorhersage, Wärmepumpe, Netz, Batterie), „Jetzt: Planer und heutige Steuerung“,
   Zeitleiste je Raum, Gegenrechnung der Vortage, Raummodell.

Die **Analyse bleibt unverändert**.

**Schattenbetrieb:** Der Planer rechnet alle 15 min und schreibt auf, was er anders gemacht hätte. An Loxone ändert
er nichts – die Sollwerte setzt weiter der Collector (Tagesmodi, Priorität, Netzgrenze). „Steuern“ kommt erst nach
Ulis Freigabe, wenn die Gegenrechnung zeigt, dass der Plan besser ist.

## Woher die Teile kommen

| München | aus Venediger (Commit bf8d3a7) | geändert |
|---|---|---|
| `supabase/functions/heizplaner-muenchen/modell.ts` | `supabase/functions/heizplaner/modell.ts` | **nichts** (Kopie mit Herkunft im Kopf) |
| `supabase/functions/heizplaner-muenchen/index.ts` | `supabase/functions/heizplaner/index.ts` | Stellen mit „MÜNCHEN:“ (siehe unten) |
| `supabase/migration-014-auto-steuerung.sql` | `SQL/25_heizplaner.sql`, `SQL/35_energie_verlauf.sql` | `muc_*`-Tabellen, Heizung = Wärmepumpe |
| `frontend/src/auto/AutoSteuerung.jsx` | `src/components/ki/AutoSteuerung.tsx` | Netzgrenze in Kreisen statt Watt |
| `frontend/src/auto/VerlaufAnsicht.jsx`, `Verlauf.jsx`, `zeit.js` | `VerlaufAnsicht.tsx`, `VerlaufView.tsx`, `verlaufZeit.ts` | Verbrauch = WP · Auto · Haus, „unter Ziel“ |
| `frontend/src/auto/Plan.jsx` | `PlanerView.tsx`, `RaumModellView.tsx` | Raummodell ohne Vorausschau, mit „Strom je Kreis“ |
| `frontend/src/auto/teile.jsx` | `planerTeile.tsx` | Klassen der Münchner App |
| `.github/workflows/deploy-functions.yml` | `.github/workflows/deploy-functions.yml` | nur München-Funktionen, Alexa ohne JWT |

Die Ansichten sind in JSX mit den Klassen der Münchner App umgesetzt (Venediger: TypeScript + Tailwind). Aufbau,
Inhalte, Texte und Farben sind gleich.

## Unterschiede, die die Heizart verlangt

- **Heizen = Ventil offen.** Die Leistung je Raum ist der Strom der Wärmepumpe je offenem Kreis, gemessen aus den
  Heizläufen (`muc_heat_runs`: Heizstrom ÷ gleichzeitig offene Kreise, letzte 30 Tage). Bis 2 Läufe da sind: 400 W.
- **Leistungsgrenze ohne Sonne** = Netzgrenze (`max_grid_circuits`) × mittlere Leistung je Kreis. Der Regler in der
  Auto-Steuerung ist dieselbe Einstellung wie unter Einstellungen – er gilt auch sofort für den Collector.
- **Ziel je Raum nach Profil:** morgens bzw. tagsüber angehakt → Normal, sonst Untergrenze; Abend und Nacht
  Untergrenze. Höchstwert = PV-Wert (Räume ohne PV-Laden: Normal + 0,5 °C). Gewicht nach Prio 1–4.
- **Wetter** (Strahlung direkt/diffus, Außentemperatur) holt die Edge Function bei Open-Meteo für München
  (48,14 / 11,58), Ortszeit Europe/Berlin. Das PV-Modell lernt daraus je Stunde wie in Venediger.
- **Batterie** aus den Einstellungen (10 kWh), 5000 W Lade-/Entladeleistung.
- **Angestoßen vom Collector** (0.12, `collector/src/planer.js`), weil München keinen Scheduler in der Cloud hat:
  alle 15 min `planen`, täglich ab 03:00 `lernen` je Raum, `pv_lernen`, `vergleich` (gestern). `PLANER=off` in der
  `.env` schaltet das ab. Der Collector wartet nicht auf den Planer.
- **Verlauf:** Wärmepumpe (mit Warmwasser) = Verbrauch − Auto − Grundlast, wie in der Analyse. Auto ist gemessen
  (evcc). „Netz bei leerer Batterie“ = Ladestand ≤ 5 % (wie die Analyse). „Haus unter Ziel“ = Raum-Stunden 08–22 Uhr
  mehr als 0,3 °C unter dem Ziel des Raums (heutige Raumeinstellungen).

## Daten (migration-014)

- `muc_energie_stunde` / `muc_energie_tag` werden **nie gelöscht** (Rohdaten nur 90 Tage). Cron `muc-energie-verlauf`
  stündlich um :09, reines SQL. Beim Ausführen ab dem ältesten Messwert nachgetragen.
- Kosten mit dem an dem Tag gültigen Preis aus `muc_prices` (Einstellungen › Strompreis); ohne Preis „–“.
- Planer: `muc_heizmodell`, `muc_heizplan` (3 Tage), `muc_heizplan_vergleich`, Einstellungen `muc_settings.planer_*`,
  Eingaben `muc_heizplaner_daten()`.

## Noch nicht drin

- **Steuern** (gesperrt wie in Venediger).
- **Warmwasser und Auto als eigene Last im Plan** und das Zeitprogramm der Wärmepumpe: Der Plan rechnet bisher mit
  der Grundlast. Kommt, sobald die Wärmepumpe im LAN ist (Phase 3).

## Geprüft (12.11.2026, ohne echte Daten)

- Collector-Tests (`npm test`, 40 grün, davon 4 neu für den Planer-Anstoß).
- migration-014 in einer leeren Postgres-16-Datenbank mit allen Migrationen davor, zweimal hintereinander, mit 5 Tagen
  erfundener Messwerte: Stunden, Tage, Kosten, „unter Ziel“ und `muc_heizplaner_daten` stimmen.
- Planer-Funktion mit diesen Daten lokal gerechnet: lernen, pv_lernen, planen, vergleich laufen durch.
- App gebaut und die Auto-Steuerung mit diesen Daten angesehen (Desktop hell, Handy dunkel).
