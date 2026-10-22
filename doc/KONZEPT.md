# Konzept – PV-gesteuerte Fußbodenheizung München

Stand: 22.10.2026 · Version 0.1 (Pilot: nur **KG Bad**)

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
                    Supabase (Messwerte, Einstellungen, Protokoll)
                           ▲
                    Web-App (React, Vercel): Übersicht, Verlauf, Protokoll, Einstellungen
```

Unterschied zu Venediger: Die Logik läuft **im Collector**, nicht als Edge Function.
Das Haus funktioniert auch ohne Internet, und es gibt kein „im Repo, aber nicht deployt“.
Supabase dient nur als Speicher und als Brücke zur App.

## Betriebsmodi

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

| Tabelle | Inhalt |
|---|---|
| `settings` | eine Zeile: Zeiten, Schwellwerte, Testmodus |
| `rooms` | Räume mit Loxone-Bezeichnungen, Temperaturen je Modus, Override |
| `energy_readings` | FENECON-Werte jede Minute (90 Tage) |
| `room_readings` | Ist, Soll, Ventil, Ziel je Raum jede Minute (90 Tage) |
| `decisions` | Moduswechsel, geschriebene Sollwerte, Fehler |
| `collector_status` | Lebenszeichen und aktueller Modus |
| `history()` | verdichteter Verlauf für die Grafiken |

## Ausbau (nach erfolgreichem Pilot)

1. Weitere Räume: je Raum ein virtueller Eingang auf ϑch + eine Zeile in `rooms`.
   Kein Code nötig.
2. Raumauswahl nach Priorität/Estrichfläche bei knappem Überschuss.
3. PV-Prognose (Forecast.Solar) → nachts tiefer absenken, wenn morgen Sonne kommt.
4. Wärmepumpe: SG-Ready-Kontakt oder Modbus (WP muss ins Netz) → Warmwasser-Boost.
5. Strommessung an der WP → echte Bewertung „Heizung aus PV in %“.
6. Abstimmung mit evcc, damit Auto und Heizung nicht um denselben Überschuss streiten.
