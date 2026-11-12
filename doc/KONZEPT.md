# Konzept – PV-gesteuerte Fußbodenheizung München

Stand: 27.10.2026 · Version 0.6 (alle 15 Räume). Ursprünglich Pilot 0.1 mit KG Bad – Projektstand und Roadmap in [`STAND-UND-ROADMAP.md`](STAND-UND-ROADMAP.md).

## Grundregel: Venediger übernehmen, nicht neu entwickeln (Uli, 12.11.2026)

München steuert nach demselben Prinzip wie Heizung Venediger: Solltemperatur je Raum, Estrich als Speicher,
bei PV-Überschuss aufheizen bzw. überheizen, ohne PV so wenig Netzstrom wie möglich. Unterschied ist nur der
Aktor (Loxone-Ventil + Wärmepumpe statt elektrischer Bodenheizung) – für Planer und Auswertung ist das ein
Parameter je Raum (Strom je Stunde Heizen), kein anderes Konzept.

- Alles, was Venediger schon hat, wird **übernommen** (Logik, Planer `heizplaner`/`modell.ts`, Ansichten wie
  Auto-Steuerung, Verlauf und Wirkung, KI-Vorschläge) – nicht für München neu geschrieben.
- **Jedes System läuft eigenständig:** Alles für München liegt im Repo `heizung-muenchen` und wird von hier deployt
  (eigene Edge Functions, eigene `muc_*`-Tabellen). Venediger wird dafür nicht geändert.
- Braucht München eine Datei aus Venediger (z. B. `supabase/functions/heizplaner/modell.ts`), wird sie **ins
  München-Repo kopiert**, mit Herkunft (Repo, Pfad, Commit) im Dateikopf. Geändert wird die Kopie nur, wo München
  es wirklich braucht.
- Nur was es in München wirklich anders gibt (Wärmepumpe mit eigenem Zeitprogramm, Warmwasser, evcc), wird ergänzt.
- Bestehende Münchner Teile bleiben, wie sie sind, wenn Uli es so will: Die **Analyse bleibt unverändert**, die
  Auto-Steuerung kommt als eigener Menüpunkt dazu (Uli, 12.11.2026). Erste Übernahme nach dieser Regel:
  [`AUTO-STEUERUNG-2026-11-12.md`](AUTO-STEUERUNG-2026-11-12.md).

## Ziel

PV-Überschuss und Batterie der FENECON-Anlage (10 kWp, 10 kWh) so nutzen, dass die
Wärmepumpe möglichst mit eigenem Strom heizt und weniger Netzstrom bezogen wird.
Der Estrich der Fußbodenheizung dient als Wärmespeicher.

## Anlage

| Komponente | Details | Schnittstelle |
|---|---|---|
| PV + Speicher | FENECON FEMS, 10 kWp, 10 kWh | Modbus TCP lesend, `192.168.188.59:502` |
| Hausautomation | Loxone Miniserver „Mittermaier“ | HTTP-Webservice, `192.168.188.128` |
| Heizung | Weishaupt Biblock WBB 12 (Wärmepumpe) + Wasser-FBH, ein Ventil pro Raum | (Phase 2: SG-Ready/Modbus) |
| E-Auto | Tesla Wall Connector über evcc | eigener PV-Modus |

## Prinzip

- Die App setzt pro Raum **nur die Komforttemperatur (ϑch)** des Loxone-Raumreglers,
  über einen virtuellen Eingang (z. B. `API_Boost_Bad`).
- **Loxone bleibt der Regler**: Hysterese, Ventil, Frostschutz, Fensterkontakt.
- Fällt App oder Mini-PC aus, gilt der Standardwert des virtuellen Eingangs (21 °C) –
  das Haus heizt normal weiter.
- Grenzen 5–26 °C doppelt abgesichert: in Loxone (Validierung) und im Collector.

Getestet am 22.10.2026: `/jdev/sps/io/API_Boost_Bad/19` → Ventil zu,
`/24` → Ventil auf.

## Architektur

```
FENECON (Modbus) ─┐
                  ├─► Collector (Node.js, Mini-PC, NSSM-Dienst) ──► Loxone: Sollwert je Raum
Loxone (HTTP)  ───┘        │  Heizlogik läuft LOKAL
                           ▼
                    Supabase (Venediger-Projekt, muc_-Tabellen)
                           ▲
                    Web-App (React, Vercel): Übersicht, Verlauf, Protokoll, Einstellungen
```

Unterschied zu Venediger: Die Logik läuft **im Collector**, nicht als Edge Function.
Das Haus funktioniert auch ohne Internet, und es gibt kein „im Repo, aber nicht deployt“.
Supabase dient nur als Speicher und als Brücke zur App.

> **Ab Collector 0.11 (09.11.2026):** Heizen mit und ohne PV-Überschuss, Tagesmodi wie in Venediger – siehe
> [`KONZEPT-TAGESMODI-2026-11-09.md`](KONZEPT-TAGESMODI-2026-11-09.md).

## Steuerung 0.5–0.10: Tagesphasen, PV-Stufen, Raumprofile (abgelöst durch 0.11)

Die Betriebsmodi unten waren die Logik bis 0.4. Seit 0.5 gilt (Details in `collector/src/logic.js`):

- **Tagesphasen** (in der App einstellbar): Nacht (*Nacht ab* bis *Morgen ab*) · Morgen · Tag · Abend (*Abend ab*).
- **Raumprofil:** je Raum *morgens / tagsüber / abends heizen* → in dieser Phase **Normal**, sonst **Absenkwert**.
  Nachts alle Räume abgesenkt, der Estrich gibt die Wärme ab. Abends nur, wenn der Akku ≥ *Abends heizen nur ab Akku*.
- **PV-Stufen 1–3:** ab *Stufe 1 ein* (1,5 kW) heizen Räume mit PV-Prio 1 auf ihren PV-Wert; bleibt trotzdem ≥ *Nächste Stufe*
  (1 kW) übrig, kommt Prio 2, dann Prio 3 dazu; unter *Stufe zurück* (300 W) eine Stufe runter; Haltezeit je Stufe.
- **Batterie voll** (SoC ≥ 95 % und ≥ 3 kW Einspeisung): alle PV-Räume auf *Voll*.
- Sollwert = höherer Wert aus Phase und PV-Stufe. Override hat immer Vorrang.
- **Tagesprotokoll (0.6):** einmal am Morgen Prognose + Einstellungen speichern – Grundlage der vorausschauenden Steuerung.

## Betriebsmodi (bis 0.4, zur Einordnung älterer Protokolleinträge)

Jede Minute misst der Collector, glättet über 5 Minuten und bestimmt den Modus:

| Modus | Bedingung | Sollwert KG Bad (Start) |
|---|---|---|
| **NACHT** | 20:00–09:00 | 19 °C |
| **NORMAL** | Tag, kein Überschuss | 21 °C |
| **PV_LADEN** | Überschuss ≥ 1500 W (aus unter 300 W) | 23 °C |
| **BATTERIE_VOLL** | SoC ≥ 95 % und Überschuss ≥ 3000 W | 24 °C |
| **ABEND_SCHUTZ** | ab 16:00 und SoC < 40 % | 19 °C |
| **OVERRIDE** | manuell aus der App, mit Ablaufzeit | frei (5–26 °C) |

**Überschuss** = Einspeisung + Batterieladeleistung, wobei die Ladeleistung erst ab
SoC ≥ 60 % zählt. Darunter gehört die Sonne zuerst der Batterie (Abendreserve).
Das entspricht der Venediger-Regel „Komfort nur aus echtem Überschuss“.

**Haltezeit:** Ein Modus bleibt mindestens 30 Minuten (Fußbodenheizung ist träge,
Wärmepumpe soll nicht takten). Ausnahme: Wechsel in/aus NACHT sofort.

**Ohne FENECON-Daten** gilt NORMAL – nie Boost aus Versehen.

Alle Werte sind in der App unter *Einstellungen* änderbar.

## Sicherheit

- **Testmodus ist ab Werk an**: Die App entscheidet und protokolliert, schreibt aber
  nichts. Erst nach Prüfung im Protokoll ausschalten.
- Zusätzlich `FORCE_DRY_RUN=1` in der `.env` des Collectors – sperrt das Schreiben hart.
- Loxone-Zugriff über eigenen Benutzer `api` mit Rechten nur auf die nötigen Bausteine.
- Der Supabase-`service_role`-Key liegt nur auf dem Mini-PC. Die App nutzt den
  `anon`-Key plus Anmeldung; anonyme Zugriffe sind per RLS gesperrt.

## Datenmodell (Supabase)

München läuft im **Venediger-Supabase-Projekt** mit (Gratis-Limit von zwei Projekten erreicht).
Alle Objekte tragen das Präfix `muc_`; Venediger-Tabellen bleiben unverändert.
Rechte (RLS, Grants) werden nur auf die `muc_`-Tabellen vergeben.

| Tabelle | Inhalt |
|---|---|
| `muc_settings` | eine Zeile: Zeiten, Schwellwerte, Testmodus |
| `muc_rooms` | Räume mit Loxone-Bezeichnungen, Temperaturen je Modus, Override |
| `muc_energy_readings` | FENECON-Werte jede Minute (90 Tage) |
| `muc_room_readings` | Ist, Soll, Ventil, Ziel je Raum jede Minute (90 Tage) |
| `muc_decisions` | Moduswechsel, geschriebene Sollwerte, Fehler |
| `muc_collector_status` | Lebenszeichen und aktueller Modus |
| `muc_history()` | verdichteter Verlauf für die Grafiken |
| `muc_daily_stats`, `muc_room_daily_stats` | Tageswerte dauerhaft (migration-003) |
| `muc_forecast` | Wetter und PV-/Verbrauchsprognose vom FEMS alle 15 min (migration-004) |
| `muc_day_context` | Tagesprotokoll: Prognose am Morgen, Einstellungen, Heizplan (migration-006) |
| `muc_day_patterns` | Tagesprotokoll + Tagesergebnis – Grundlage für Muster und KI-Plan (migration-006) |

## Ausbau (nach erfolgreichem Pilot)

1. ✅ Weitere Räume: je Raum ein virtueller Eingang auf ϑch + eine Zeile in `muc_rooms` (alle 15 erledigt).
   Kein Code nötig.
2. Raumauswahl nach Priorität/Estrichfläche bei knappem Überschuss.
3. ✅ PV-Prognose vom FEMS (statt Forecast.Solar) wird gespeichert und bewertet; Nutzung in der Steuerung → Phase 5.
4. Wärmepumpe: SG-Ready-Kontakt oder Modbus (WP muss ins Netz) → Warmwasser-Boost.
5. Strommessung an der WP → echte Bewertung „Heizung aus PV in %“.
6. Abstimmung mit evcc, damit Auto und Heizung nicht um denselben Überschuss streiten.
