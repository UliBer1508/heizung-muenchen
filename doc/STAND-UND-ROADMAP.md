# Heizung München – Projektstand und Roadmap

Stand: 23.10.2026 · Collector-Version 0.4.0

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
- **Zehn Räume** eingerichtet (KG, DG, OG), je Raum: eindeutiger Fühlername, eindeutiger Ventilname,
  virtueller Eingang → ϑch, Validierung 5–26 °C, Standardwert = bisherige Komforttemperatur,
  „Standardwert bei Start“, nicht in der Visualisierung. Alle zehn liefern Temperatur, Sollwert und Ventil (geprüft 23.10.2026).
- **Noch nicht eingerichtet: Erdgeschoss** (siehe Abschnitt 7).

| Raum | ID (App) | Fühler | Virtueller Eingang | Ventil |
|---|---|---|---|---|
| KG Bad | `kg_bad` | `Temp KG Bad` | `API_Boost_Bad` | `Bad KG` |
| DG Bad | `dg_bad` | `Temp DG Bad` | `API_Soll_DG_Bad` | `Ventil DG Bad` (Q12) |
| DG Schlafzimmer | `dg_schlafen` | `Temp DG Schlafzimmer` | `API_Soll_DG_Schlafzimmer` | `Ventil DG Schlafzimmer` (Q10) |
| DG Wohnen/Essen/Küche | `dg_wohnen` | `Temp DG Wohnen` | `API_Soll_DG_Wohnen` | `Ventil DG Wohnen` (Q11) |
| OG Eltern Bad | `og_bad` | `TEMP OG Bad` | `API_Soll_OG_Bad` | `Ventil OG Bad` (Q6) |
| OG Luis Bad | `og_luis_bad` | `Temp OG Luis Bad` | `API_Soll_OG_Bad_Luis` | `Ventil OG Luis Bad` (Q4) |
| OG Büro (kleines Zimmer) | `og_buero` | `Temp OG Buero` | `API_Soll_OG_Buero` | `Ventil OG Buero` (Q8) |
| OG Luis Schlafzimmer | `og_luis_schlafen` | `Temp OG Luis Schlafzimmer` | `API_Soll_OG_Luis_Schlafzimmer` | `Ventil OG Luis Schlafzimmer` (Q5) |
| OG Eltern Schlafzimmer | `og_eltern_schlafen` | `Temp OG Eltern Schlafzimmer` | `API_Soll_OG_Eltern_Schlafzimmer` | `Ventil OG Eltern Schlafzimmer` (Q7) |
| OG Ankleidezimmer | `og_ankleide` | `Temp OG Ankleidezimmer` | `API_Soll_OG_Ankleidezimmer` | `Ventil OG Ankleidezimmer` (Q3) |

Die Ventile (außer KG Bad) liegen auf der Relay Extension 15 (Schaltschrank DG R02 P02).
Namen ohne Umlaute verwenden (z. B. „Buero“), sonst drohen 404-Fehler beim Webservice.

### 2.2 Collector (Mini-PC, Dienst `HeizungMuenchen`)

- Node.js ohne Zusatzpakete, läuft jede Minute:
  FENECON lesen → Loxone lesen → Modus bestimmen → Sollwerte setzen → Supabase.
- **Heizlogik läuft lokal** – das Haus funktioniert auch ohne Internet.
- **Seit 0.5.0: Heizplan je Raum** (ersetzt die alten Hausmodi NORMAL/PV-LADEN/ABEND-SCHUTZ):
  - **Tagesphasen** (in der App einstellbar): Nacht 22–6 · Morgen 6–9 · Tag 9–17 · Abend 17–22.
  - **Je Raum** Haken *Morgens / Tagsüber / Abends*: in dieser Phase auf **Normal**, sonst auf
    dem **Absenkwert** (`temp_night`). Nachts sind alle Räume abgesenkt, der Estrich gibt die Wärme ab.
    *Abends* nur, wenn der Akku ≥ „Abends heizen nur ab Akku“ (Standard 60 %) ist.
  - **PV-Stufen 1–3**: Stufe 1 ab 1,5 kW Überschuss → Räume mit PV-Prio 1 bekommen ihren PV-Wert.
    Ist trotz Heizung noch ≥ 1 kW übrig, kommt die nächste Stufe (Prio 2, dann Prio 3) dazu.
    Fällt der Rest unter 300 W, geht es eine Stufe zurück. Mindestdauer je Stufe 30 min.
    Prio „nie“ = Raum wird nie mit PV aufgeheizt.
  - **Batterie voll** (SoC ≥ 95 % und ≥ 3 kW Export): alle PV-Räume auf „Voll“.
  - Sollwert = höherer Wert aus Phase und PV-Stufe. Override hat immer Vorrang.
  - Vorbelegung (Migration 005): Kern = EG Küche/Essbereich, EG Büro, EG WC (morgens + tagsüber, Prio 1);
    abends Küche und Wohnzimmer; Schlafräume und Ankleide Prio 3; übrige Prio 2.
- Haltezeit, Hysterese, Sicherheitsgrenzen 5–26 °C (zusätzlich zu Loxone),
  ohne FENECON-Daten sicherer Normalbetrieb.
- Sollwert wird alle 2 h bestätigt (falls Loxone neu gestartet hat).
- Seit 0.2.0: Auto-Ladeleistung (evcc, nur lesend).
- **Seit 0.4.0: Wetter und PV-Prognose vom FEMS** (eine Datenquelle statt eigener Wetterdienst):
  alle 15 min per REST (App „REST/JSON lesend“, Gastpasswort `user`) die Kanäle
  `weather0/*` (App „Wetter“) und `predictor*/*` (Erzeugungs- und Verbrauchsprognose).
  Daraus kommt auch die Außentemperatur. Open-Meteo nur noch als Notlösung, wenn das FEMS keine Temperatur liefert.
- 21 automatische Tests (Logik, Modbus, Loxone, FEMS-REST, kompletter Durchlauf).

### 2.3 Datenbank (Supabase)

- Tabellen `muc_*` im bestehenden Venediger-Projekt (Gratis-Limit von zwei Projekten erreicht);
  Venediger-Tabellen werden nicht verändert, Rechte nur auf `muc_*`.
- Messwerte 90 Tage, Einstellungen, Räume, Entscheidungsprotokoll, Collector-Status.
- Auswertungsfunktionen: Tageskennzahlen, Tagesverlauf, Raumkennzahlen, Raumverlauf.
- `muc_forecast` (seit migration-004): Wetter und Prognose alle 15 min, dauerhaft – Grundlage, um die
  Treffsicherheit der FENECON-Prognose zu prüfen, bevor die Steuerung sie nutzt.

### 2.4 Web-App (Vercel, PWA)

- Login über Supabase, installierbar auf dem Handy (Startbildschirm), mobile Ansicht mit Tab-Leiste unten.
- **Übersicht:** Betriebsmodus mit Begründung, Energiewerte, **Wetter & PV-Prognose (FENECON)**,
  Raumkarten (Ist, Soll, Ventil), manuelles Übersteuern mit Ablaufzeit.
- **Analyse – Tag:** Netzbezug (davon nachts), PV, Autarkie, Batterie leer, Außentemperatur,
  geschätzter Heizstrom und dessen Herkunft (Sonne/Batterie/Netz), Tageskurven.
- **Analyse – Räume:** Ø Ist/Soll, Abweichung, Stunden zu kalt, Aufheiz-/Abkühlrate,
  Ventil-offen-Stunden nach Stromherkunft, Raumkurve mit Außentemperatur.
- **Analyse – Woche / Monat / Jahr:** dieselben vier Fragen (PV, Batterie, Wärmepumpe, Auto) als Balken je Tag bzw. Monat,
  Wärmepumpe mit Außentemperatur, Heizstrom nach Tageszeit, Räume mit Ventil-Stunden und Temperaturverlauf.
  Tageswerte werden nachts dauerhaft gespeichert (`muc_daily_stats`).
- **Protokoll:** jede Entscheidung mit Begründung.
- **Einstellungen:** Testmodus, Automatik, Zeiten, Schwellwerte, Grundlast, Temperaturen je Raum und Modus.

### 2.5 Aktuelle Raumtemperaturen (°C)

| Raum | Nacht / Abend-Schutz | Normal | PV-Laden | Batterie voll |
|---|---|---|---|---|
| KG Bad | 15 | 16 | 21 | 23 |
| DG Bad | 20 | 21 | 24 | 24,5 |
| DG Schlafzimmer | 19 | 21 | 22 | 22,5 |
| DG Wohnen/Essen/Küche | 20 | 21 | 23,5 | 24 |
| OG Eltern Bad | 21 | 22,5 | 24 | 24,5 |
| OG Luis Bad | 21 | 22,5 | 24 | 24,5 |
| OG Büro | 19,5 | 21 | 22,5 | 23 |
| OG Luis Schlafzimmer | 21 | 22,5 | 23,5 | 24 |
| OG Eltern Schlafzimmer | 17 | 18 | 19,5 | 20 |
| OG Ankleidezimmer | 18,5 | 20 | 21,5 | 22 |

Änderbar in der App unter *Einstellungen*. Maßgeblich ist immer der Wert in der Datenbank.

### 2.6 Weitere Ergebnisse

- Anfrage an FENECON zur SG-Ready-Ansteuerung (App „FEMS Power-to-Heat“, Relaisboard, Zähler)
  mit Belegen aus der Analyse formuliert.
- Modbus TCP an der Wärmepumpe freigeschaltet (Netzwerk `192.168.188.0/255.255.255.0`) –
  die Wärmepumpe hat aber noch **kein Netzwerkkabel**.

---

## 3. Offene Phasen

### Phase 2 – Analyse: Vergleich (nach 1–2 Wochen Daten)
- ✅ Erledigt: Tageswerte dauerhaft (`muc_daily_stats`), Zeiträume Woche/Monat/Jahr.
- Offen: Gegenüberstellung zweier Zeiträume (vor/nach einer Änderung), bezogen auf die Außentemperatur
  (z. B. Heizstrom je Heizgradtag).
- Optional: Import historischer FEMS-Exporte (Monat/Jahr), damit die Jahresansicht vor dem 22.10.2026 Werte zeigt.

### Phase 3 – Wärmepumpe direkt per Modbus (nach LAN-Anschluss)
- Voraussetzung: Netzwerkkabel (oder FRITZ!Repeater mit LAN-Buchse) an der Wärmepumpe.
- Lesen: elektrische Leistung, Betriebszustand, Vorlauf, Warmwasser, Außentemperatur
  → **echter Heizstrom statt Schätzung**, eigene Karte „Wärmepumpe“ in der App.
- Steuern bei Überschuss: Warmwasser anheben (z. B. 48 → 55 °C), Heizleistung/Sollwert erhöhen –
  zusammen mit den Raumventilen. Erst lesend testen, dann schreibend.
- Priorität zwischen Heizung und E-Auto festlegen (Einstellung in der App).
- Entscheiden: SG-Ready über FENECON **oder** Modbus über den Collector – nur ein System steuert die Wärmepumpe.

### Phase 4 – Weitere Räume
- ✅ Alle 15 beheizten Räume erledigt: KG Bad, DG (3), OG (6), EG (5: Büro, Eingang, Küche/Essbereich, Wohnzimmer, WC) – 27.10.2026.
- Vorgehen für weitere Räume siehe Abschnitt 7.
- Je Raum dieselben drei Loxone-Schritte und eine Zeile in `muc_rooms`. Kein Code nötig.
- Vorrang für Räume mit großer Estrichfläche (speichern am meisten PV-Wärme).
- Hinweis: Sobald die App ϑch steuert, wirkt die Komforttemperatur der Loxone-App für diesen Raum nicht mehr.

### Phase 5 – Vorausschauende Steuerung
- ✅ Schritt 1 (0.4.0): Wetter und PV-Prognose vom FEMS werden gespeichert und in der App angezeigt – **noch ohne Eingriff in die Steuerung**.
- Schritt 2 (nach 1–2 Wochen Daten): Treffsicherheit prüfen (Prognose „Ahead“ gegen gemessene PV bzw. „Realized“).
- Schritt 3: Steuerung nutzt die Prognose –
  morgens nicht aus Batterie/Netz heizen, wenn mittags viel Sonne kommt;
  vor kalten Nächten mit trübem Folgetag nachmittags mit PV vorheizen;
  an trüben Tagen früherer Abend-Schutz (Verbrauchsprognose `predictor2` hilft abzuschätzen, ob die Batterie bis morgens reicht).
- Verfügbare FEMS-Kanäle: Temperatur jetzt / in 4–24 h, Tages-Min/Max, Wetterlage (WMO-Schlüssel),
  Sonnenscheindauer heute, PV-Leistung in 1/3/6/12/24/36 h, Hausverbrauch in 1/3/6/12/24/36 h.
  Einschränkung: nur diese Zeitpunkte, keine Stundenkurve.
- Hinweis: Im FEMS ist die „netzdienliche Beladung“ (`ctrlGridOptimizedCharge0`) aktiv und nutzt dieselbe Prognose.
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
| 8 | **Loxone aufräumen**: unbenutzten virtuellen Eingang `API_SOLL_Bad` löschen; vorbereitete Automatikbeschattungen deaktivieren, solange keine Rollos verbaut sind | Loxone Config | verhindert Verwechslungen und ungewollte Schaltvorgänge |
| 9 | **Supabase-Schlüssel**: `service_role` nur in der `.env` auf dem Mini-PC; App nutzt `anon` + Login | – | ist so umgesetzt, bitte beibehalten |

Die Punkte 1 und 2 kann der Heizungsbauer beim Termin für das LAN-Kabel mit erledigen.

---

## 5. Betrieb – Kurzreferenz

| Aufgabe | Befehl / Ort |
|---|---|
| Update einspielen | `cd C:\Users\ulibe\heizung-muenchen` → `git pull` → `C:\nssm\nssm.exe restart HeizungMuenchen` |
| Protokoll ansehen | `Get-Content C:\Users\ulibe\heizung-muenchen\collector\state\collector.log -Tail 20 -Encoding UTF8` |
| Dienststatus | `C:\nssm\nssm.exe status HeizungMuenchen` |
| Hardware testen | `cd collector` → `npm run test:fenecon` / `npm run test:loxone` / `npm run test:wetter` |
| Alle FEMS-Kanäle ansehen | `curl.exe -s -u x:user "http://192.168.188.59/rest/channel/.*/.*" -o fems-kanaele.json` |
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
- Der Loxone-Raumregler schaltet das Ventil nicht exakt am Sollwert ab, sondern mit Nachlauf/Toleranz
  (beobachtet: Ventil offen bei 0,2 K über Soll). Für die PV-Anhebung unkritisch.
- Die GitHub-Verbindung von Claude kann nur lesen; Updates werden als ZIP geliefert und per
  „Upload files“ hochgeladen.

---

## 7. Neuen Raum hinzufügen (z. B. Erdgeschoss)

**In Loxone Config** (Seite des Raums):

1. **Fühler** am Eingang ϑc des Raumreglers anklicken → Bezeichnung `Temp <Etage> <Raum>` (eindeutig, ohne Umlaute).
2. **Ventil** am Ausgang H anklicken → Bezeichnung `Ventil <Etage> <Raum>`.
   Hängt an H nichts: im Baum unter *Digitale Ausgänge / Relay 15* den passenden Ausgang suchen und mit H verbinden.
3. **Virtueller Eingang** anlegen (*Peripherie → Virtuelle Eingänge → Virtueller Eingang*):
   - Bezeichnung `API_Soll_<Etage>_<Raum>`
   - „Als Digitaleingang verwenden“ **aus**, „In Visualisierung verwenden“ **aus**
   - Validierung: Minimal 5, Maximal 26, Standardwert = bisherige Komforttemperatur, „Standardwert bei Start“ ✔
4. Eingang auf die Seite ziehen, Linie auf den Raumregler ziehen → **ϑch** wählen
   (dabei den bisherigen ϑch-Wert ablesen = Normaltemperatur).
5. **In den Miniserver speichern.**

**In Supabase** (SQL Editor) – Namen exakt wie in Loxone:

```sql
insert into muc_rooms (id, name, sort, enabled, loxone_temp_name, loxone_setpoint_name, loxone_valve_name,
                       temp_night, temp_normal, temp_pv, temp_full)
values ('eg_xxx', 'EG Raumname', 60, true, 'Temp EG Raumname', 'API_Soll_EG_Raumname', 'Ventil EG Raumname',
        19.5, 21, 22.5, 23)
on conflict (id) do update set
  name = excluded.name, enabled = excluded.enabled,
  loxone_temp_name = excluded.loxone_temp_name, loxone_setpoint_name = excluded.loxone_setpoint_name,
  loxone_valve_name = excluded.loxone_valve_name,
  temp_night = excluded.temp_night, temp_normal = excluded.temp_normal,
  temp_pv = excluded.temp_pv, temp_full = excluded.temp_full;
```

**Kontrolle** (nach einer Minute):

```sql
select r.name, rr.ts, rr.temp, rr.setpoint, rr.valve
from muc_rooms r
left join lateral (select ts, temp, setpoint, valve from muc_room_readings
                   where room_id = r.id order by ts desc limit 1) rr on true
order by r.sort;
```

Leere Spalte = Name in Loxone stimmt nicht (`temp` → Fühler, `setpoint` → virtueller Eingang, `valve` → Ventil).
Alternativ zeigt die App oben „Letzter Fehler … 404“ mit dem betroffenen Namen.
