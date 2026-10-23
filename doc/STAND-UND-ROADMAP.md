# Heizung München – Projektstand und Roadmap

Stand: 23.10.2026 · Collector-Version 0.2.0

Dieses Dokument fasst zusammen, was bisher umgesetzt wurde, welche Phasen noch offen sind
und was darüber hinaus empfehlenswert ist. Technische Details stehen in
[`KONZEPT.md`](KONZEPT.md), die Schritt-für-Schritt-Anleitung in [`INBETRIEBNAHME.md`](INBETRIEBNAHME.md).

---

## 1. Ausgangslage

| Komponente | Details |
|---|---|
| PV + Speicher | FENECON FEMS (fems55197), 10 kWp, 10 kWh, Modbus/TCP lesend `192.168.188.59:502` |
| Hausautomation | Loxone Miniserver „Mittermaier“, `192.168.188.128` |
| Heizung | Weishaupt Biblock WBB 12-B-RMD-AI (2023), Wasser-Fußbodenheizung, ein Ventil pro Raum, Warmwasserspeicher |
| E-Auto | Tesla Wall Connector über evcc (PV-Modus), evcc läuft auf dem Mini-PC |
| Server | Windows-Mini-PC „minipc-weidmannstrasse“, Dienste über NSSM (`C:\nssm\nssm.exe`) |

**Problem (Analyse der FEMS-Exporte 22./23.10.2026):**

- 22.10.: 43 kWh PV, 50 kWh Verbrauch, **15 kWh Netzbezug – davon 13,5 kWh zwischen 0 und 9 Uhr**.
- Der Speicher ist abends (95 % um 17 Uhr) bis Mitternacht weitgehend leer; danach heizt die
  Wärmepumpe mit 1–3 kW aus dem Netz, am stärksten ab ca. 04:15 Uhr.
- Warmwasser wird um ca. 17 Uhr nach Sonnenuntergang aus dem Speicher bereitet.
- Mittags wird der PV-Überschuss kaum für Wärme genutzt; bei Wolken entlädt das E-Auto den Speicher.
- Ursache: Die Wärmepumpe arbeitet nach ihrem eigenen Zeitprogramm (Normal 06:00–22:00,
  Absenkung nur 2 K), ohne Bezug zu PV und Speicher.

---

## 2. Bisher umgesetzt

### 2.1 Loxone

- FENECON-Werte (SoC, Netz, PV, Batterie) per Modbus in Loxone eingebunden (Seite „PV-Überschuss“).
- Getestet: Software kann über einen virtuellen Eingang die Komforttemperatur (ϑch) eines
  Raumreglers setzen – Loxone öffnet/schließt dann das Ventil selbst.
- Vier Räume eingerichtet, je Raum: eindeutiger Fühlername, eindeutiger Ventilname,
  virtueller Eingang → ϑch, Validierung 5–26 °C, Standardwert = Normaltemperatur, „Standardwert bei Start“.

| Raum | Fühler | Virtueller Eingang | Ventil |
|---|---|---|---|
| KG Bad | `Temp KG Bad` | `API_Boost_Bad` | `Bad KG` |
| DG Bad | `Temp DG Bad` | `API_Soll_DG_Bad` | `Ventil DG Bad` |
| DG Schlafzimmer | `Temp DG Schlafzimmer` | `API_Soll_DG_Schlafzimmer` | `Ventil DG Schlafzimmer` |
| DG Wohnen/Essen/Küche | `Temp DG Wohnen` | `API_Soll_DG_Wohnen` | `Ventil DG Wohnen` |

### 2.2 Collector (Mini-PC, Dienst `HeizungMuenchen`)

- Node.js ohne Zusatzpakete, läuft jede Minute:
  FENECON lesen → Loxone lesen → Modus bestimmen → Sollwerte setzen → Supabase.
- **Heizlogik läuft lokal** – das Haus funktioniert auch ohne Internet.
- Betriebsmodi: NACHT (20–9 Uhr) · NORMAL · PV-LADEN (Überschuss ≥ 1,5 kW) ·
  BATTERIE VOLL (SoC ≥ 95 % und ≥ 3 kW) · ABEND-SCHUTZ (ab 16 Uhr, SoC < 40 %) · Manuell (Override).
- Haltezeit 30 min, Hysterese, Sicherheitsgrenzen 5–26 °C (zusätzlich zu Loxone),
  ohne FENECON-Daten sicherer Normalbetrieb.
- Sollwert wird alle 2 h bestätigt (falls Loxone neu gestartet hat).
- Seit 0.2.0: Außentemperatur (Open-Meteo) und Auto-Ladeleistung (evcc, nur lesend).
- 16 automatische Tests (Logik, Modbus, Loxone, kompletter Durchlauf).

### 2.3 Datenbank (Supabase)

- Tabellen `muc_*` im bestehenden Venediger-Projekt (Gratis-Limit von zwei Projekten erreicht);
  Venediger-Tabellen werden nicht verändert, Rechte nur auf `muc_*`.
- Messwerte 90 Tage, Einstellungen, Räume, Entscheidungsprotokoll, Collector-Status.
- Auswertungsfunktionen: Tageskennzahlen, Tagesverlauf, Raumkennzahlen, Raumverlauf.

### 2.4 Web-App (Vercel, PWA)

- Login über Supabase, installierbar auf dem Handy (Startbildschirm), mobile Ansicht mit Tab-Leiste unten.
- **Übersicht:** Betriebsmodus mit Begründung, Energiewerte, Raumkarten (Ist, Soll, Ventil),
  manuelles Übersteuern mit Ablaufzeit.
- **Analyse – Tag:** Netzbezug (davon nachts), PV, Autarkie, Batterie leer, Außentemperatur,
  geschätzter Heizstrom und dessen Herkunft (Sonne/Batterie/Netz), Tageskurven.
- **Analyse – Räume:** Ø Ist/Soll, Abweichung, Stunden zu kalt, Aufheiz-/Abkühlrate,
  Ventil-offen-Stunden nach Stromherkunft, Raumkurve mit Außentemperatur.
- **Protokoll:** jede Entscheidung mit Begründung.
- **Einstellungen:** Testmodus, Automatik, Zeiten, Schwellwerte, Grundlast, Temperaturen je Raum und Modus.

### 2.5 Aktuelle Raumtemperaturen (°C)

| Raum | Nacht | Normal | PV-Laden | Batterie voll |
|---|---|---|---|---|
| KG Bad | 15 | 16 | 21 | 23 |
| DG Bad | 21 | 22,5 | 24 | 24,5 |
| DG Schlafzimmer | 19,5 | 21 | 22 | 22,5 |
| DG Wohnen/Essen/Küche | 20 | 22 | 23,5 | 24 |

### 2.6 Weitere Ergebnisse

- Anfrage an FENECON zur SG-Ready-Ansteuerung (App „FEMS Power-to-Heat“, Relaisboard, Zähler)
  mit Belegen aus der Analyse formuliert.
- Modbus TCP an der Wärmepumpe freigeschaltet (Netzwerk `192.168.188.0/255.255.255.0`) –
  die Wärmepumpe hat aber noch **kein Netzwerkkabel**.

---

## 3. Offene Phasen

### Phase 2 – Analyse: Vergleich (nach 1–2 Wochen Daten)
- Tabelle `muc_daily_stats`: nächtlich berechnete Tageswerte, dauerhaft gespeichert
  (Rohdaten werden nach 90 Tagen gelöscht).
- Bereich **Vergleich**: Wochentabelle (Außentemperatur, PV, Netzbezug nachts, Heizen aus PV in %)
  und Gegenüberstellung zweier Zeiträume (vor/nach einer Änderung), bezogen auf die Außentemperatur.

### Phase 3 – Wärmepumpe direkt per Modbus (nach LAN-Anschluss)
- Voraussetzung: Netzwerkkabel (oder FRITZ!Repeater mit LAN-Buchse) an der Wärmepumpe.
- Lesen: elektrische Leistung, Betriebszustand, Vorlauf, Warmwasser, Außentemperatur
  → **echter Heizstrom statt Schätzung**, eigene Karte „Wärmepumpe“ in der App.
- Steuern bei Überschuss: Warmwasser anheben (z. B. 48 → 55 °C), Heizleistung/Sollwert erhöhen –
  zusammen mit den Raumventilen. Erst lesend testen, dann schreibend.
- Priorität zwischen Heizung und E-Auto festlegen (Einstellung in der App).
- Entscheiden: SG-Ready über FENECON **oder** Modbus über den Collector – nur ein System steuert die Wärmepumpe.

### Phase 4 – Weitere Räume
- Je Raum dieselben drei Loxone-Schritte und eine Zeile in `muc_rooms`. Kein Code nötig.
- Vorrang für Räume mit großer Estrichfläche (speichern am meisten PV-Wärme).
- Hinweis: Sobald die App ϑch steuert, wirkt die Komforttemperatur der Loxone-App für diesen Raum nicht mehr.

### Phase 5 – Vorausschauende Steuerung
- PV-Prognose (Forecast.Solar) und Wetter: nachts tiefer absenken, wenn morgen Sonne kommt;
  mittags vorladen, wenn der Nachmittag bewölkt wird.
- Automatische Empfehlungen aus den Raumkennzahlen (z. B. „DG Bad hält Wärme 5 h – PV-Temperatur +0,5 °C“),
  optional KI-Tagesplan wie in Venediger.

---

## 4. Empfehlungen (unabhängig von der Software)

Nach Wirkung sortiert:

| # | Maßnahme | Wo | Wirkung / Begründung |
|---|---|---|---|
| 1 | **Warmwasser auf 11–15 Uhr** (Normal 48 °C nur mittags, sonst Absenk 43 °C) | Weishaupt-Zeitprogramm | ca. 2–3 kWh/Tag vom Abend-Speicher auf Mittags-PV |
| 2 | **Heizzeitprogramm umstellen**, z. B. Komfort 11–16, Normal 16–21, Absenk 21–11 Uhr (statt Normal 06–22) | Weishaupt-Zeitprogramm | Estrich mittags mit PV laden, weniger Netzbezug nachts/morgens |
| 3 | **LAN-Kabel an die Wärmepumpe** | Heizungsbauer/Elektriker | Voraussetzung für Phase 3 (Messung und Steuerung) |
| 4 | **E-Auto darf den Hausspeicher nicht entladen** | evcc (Einstellungen zur Hausbatterie) | spart die tägliche Entladung bei Wolken, Speicher bleibt für den Abend |
| 5 | **Zirkulationspumpe** nur 06:00–07:30 und 18:00–21:00 | Weishaupt bzw. Loxone | weniger Wärmeverlust rund um die Uhr |
| 6 | **Eigener Loxone-Benutzer `api`** mit Rechten nur auf die nötigen Bausteine; bisheriges Passwort ändern (war im Chat sichtbar) | Loxone Config + `.env` | Sicherheit |
| 7 | **Zwischenzähler an der Wärmepumpe** (falls Modbus-Messung nicht reicht) | Elektriker / FENECON | unabhängige, genaue Messung des Heizstroms |
| 8 | **Supabase-Schlüssel**: `service_role` nur in der `.env` auf dem Mini-PC; App nutzt `anon` + Login | – | ist so umgesetzt, bitte beibehalten |

Die Punkte 1 und 2 kann der Heizungsbauer beim Termin für das LAN-Kabel mit erledigen.

---

## 5. Betrieb – Kurzreferenz

| Aufgabe | Befehl / Ort |
|---|---|
| Update einspielen | `cd C:\Users\ulibe\heizung-muenchen` → `git pull` → `C:\nssm\nssm.exe restart HeizungMuenchen` |
| Protokoll ansehen | `Get-Content C:\Users\ulibe\heizung-muenchen\collector\state\collector.log -Tail 20 -Encoding UTF8` |
| Dienststatus | `C:\nssm\nssm.exe status HeizungMuenchen` |
| Hardware testen | `cd collector` → `npm run test:fenecon` / `npm run test:loxone` |
| Sofort nichts mehr schalten | App → Einstellungen → Automatik **Aus** (oder `FORCE_DRY_RUN=1` in `.env` + Neustart) |
| Datenbank-Änderungen | Supabase → SQL Editor → Datei aus `supabase/` ausführen |
| Web-App | Vercel baut nach jedem Commit automatisch neu |

**Notfall:** Collector stoppen (`nssm stop HeizungMuenchen`) – Loxone behält den letzten Wert,
nach einem Miniserver-Neustart gilt der Standardwert des virtuellen Eingangs. Ganz zurück:
in Loxone die Verbindung „virtueller Eingang → ϑch“ löschen.

---

## 6. Bekannte Einschränkungen

- Heizstrom ist bis Phase 3 eine **Schätzung** (Verbrauch − Auto − Grundlast).
- Aufheiz-/Abkühlraten sind Tendenzen; Sonneneinstrahlung und Nutzung beeinflussen sie.
- Ohne Ansteuerung der Wärmepumpe wirkt die PV-Anhebung nur, wenn die Wärmepumpe ohnehin heizt –
  die Raumventile bestimmen, *wohin* die Wärme geht, nicht *wann* sie erzeugt wird.
- Die GitHub-Verbindung von Claude kann nur lesen; Updates werden als ZIP geliefert und per
  „Upload files“ hochgeladen.
