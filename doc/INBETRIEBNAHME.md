# Inbetriebnahme – Schritt für Schritt

Reihenfolge einhalten. Jeder Schritt hat einen Test, bevor es weitergeht.

---

## 1. Loxone vorbereiten (Loxone Config)

**1.1 Temperaturfühler eindeutig benennen**
Auf der Seite *KG Bad* hängt am Eingang ϑc des Raumreglers ein Fühler mit der Bezeichnung
„KG Bad“. Diesen Namen tragen auch Licht- und Raumregler – für die Abfrage muss er eindeutig sein.
→ Fühler anklicken → Bezeichnung **`Temp KG Bad`**.

**1.2 Virtueller Eingang `API_Boost_Bad`** (bereits angelegt, verbunden mit ϑch)
Validierung prüfen: Minimal **5**, Maximal **26**, Standardwert **21**, *Standardwert bei Start* ✔.

**1.3 Ventilausgang**
Der Ausgang am Raumregler (H → Q3) heißt „Bad KG“. Optional umbenennen in `Ventil KG Bad`
(dann später in der App/Datenbank ebenfalls ändern).

**1.4 Eigener Benutzer für die App**
*Benutzer und Berechtigungen* → neuer Benutzer **`api`** mit eigenem, starkem Passwort.
Rechte nur auf die Bausteine/Räume, die die App steuern soll.

In den Miniserver speichern.

**Test im Browser** (als Benutzer `api` anmelden):
```
http://192.168.188.128/jdev/sps/io/Temp%20KG%20Bad/state     → Raumtemperatur
http://192.168.188.128/jdev/sps/io/API_Boost_Bad/state       → aktueller App-Sollwert
http://192.168.188.128/jdev/sps/io/Bad%20KG/state            → Ventil 0/1
```

---

## 2. Supabase: Tabellen im Venediger-Projekt anlegen

München läuft im **bestehenden Venediger-Projekt** mit (Organisation „KI-Heizungssteuerung“,
Projekt `pflnniklvqbwjwrjswaz`), weil das Gratis-Limit von zwei Projekten erreicht ist.
Alle München-Tabellen beginnen mit **`muc_`** – Venediger wird nicht verändert.

1. Venediger-Projekt öffnen → *SQL Editor* → *New query*.
2. Inhalt von `supabase/schema.sql` einfügen → *Run*.
   Ergebnis: sechs `muc_`-Tabellen, KG Bad eingetragen, Testmodus an.
3. Anmeldung: Du nutzt **denselben Benutzer wie in der Venediger-App**. Nichts anzulegen.
4. *Project Settings → API*: notieren
   - Project URL
   - `anon public` Key (für die App)
   - `service_role` Key (nur für den Collector, geheim!)

Hinweis: Der `service_role`-Key gilt für das ganze Projekt, also auch für die Venediger-Tabellen.
Er bleibt deshalb ausschließlich in der `.env` auf dem Mini-PC.

---

## 3. Collector auf dem Windows-Mini-PC

**3.1 Voraussetzungen**
```powershell
node -v      # muss 20.6 oder neuer sein, sonst Node LTS installieren
git --version
```

**3.2 Holen und einrichten**
```powershell
cd C:\Users\ulibe
git clone https://github.com/UliBer1508/heizung-muenchen.git
cd heizung-muenchen\collector
copy .env.example .env
notepad .env
```
In der `.env` eintragen: `LOXONE_USER`, `LOXONE_PASSWORD`, `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`. Für den ersten Lauf **`FORCE_DRY_RUN=1`** setzen.

Der Collector braucht **keine** zusätzlichen Pakete (`npm install` ist nicht nötig).

**3.3 Tests**
```powershell
npm test               # Logik-Tests, ohne Hardware
npm run test:fenecon   # Werte mit der FENECON-App vergleichen (gleicher Moment)
npm run test:loxone    # liest Temp, Sollwert und Ventil vom KG Bad
npm run once           # ein kompletter Durchlauf, schreibt nach Supabase
```
Bei `test:fenecon` zeigt die Plausibilitätszeile *PV + Netz + Batterie − Verbrauch* –
sie sollte nahe 0 W liegen. Zeigt Funktionscode 3 Fehler, aber 4 funktioniert:
`FENECON_FUNCTION_CODE=4` in die `.env`.

**3.4 Als Dienst einrichten (NSSM, wie in Venediger)**
```powershell
nssm install HeizungMuenchen "C:\Program Files\nodejs\node.exe" "--env-file=.env src\index.js"
nssm set HeizungMuenchen AppDirectory C:\Users\ulibe\heizung-muenchen\collector
nssm set HeizungMuenchen AppStdout C:\Users\ulibe\heizung-muenchen\collector\state\collector.log
nssm set HeizungMuenchen AppStderr C:\Users\ulibe\heizung-muenchen\collector\state\collector.log
nssm set HeizungMuenchen AppRotateFiles 1
nssm set HeizungMuenchen AppRotateBytes 5000000
nssm set HeizungMuenchen Start SERVICE_AUTO_START
mkdir state
nssm start HeizungMuenchen
```
Update später: `git pull` → `nssm restart HeizungMuenchen`.

---

## 4. Web-App auf Vercel

1. vercel.com → *Add New → Project* → Repo **heizung-muenchen** importieren.
2. *Root Directory*: **`frontend`** · Framework: **Vite**.
3. *Environment Variables*: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (anon, nicht service_role!).
4. *Deploy* → mit deinem Venediger-App-Benutzer anmelden.

Lokal testen: `cd frontend` → `.env.local` aus `.env.example` → `npm install` → `npm run dev`.

---

## 5. Pilotbetrieb KG Bad

1. **Tag 1 – Testmodus.** App zeigt Modus, Messwerte und unter *Protokoll*, welche
   Sollwerte gesetzt *würden*. Prüfen: Wechselt der Modus bei Sonne auf PV-Laden? Nachts auf Nacht?
2. **Scharf schalten:** in der `.env` `FORCE_DRY_RUN=0`, Dienst neu starten, dann in der App
   *Einstellungen → Testmodus* ausschalten.
3. **Beobachten:** *Verlauf* zeigt Ist, Soll, Ventil und PV. Erwartung: Bei Überschuss steigt
   der Sollwert, das Ventil öffnet, der Netzbezug bleibt bei 0.
4. **Override testen:** Übersicht → KG Bad → 25 °C für 1 h → Ventil muss öffnen.
5. Läuft alles ein paar Tage stabil → weitere Räume (siehe KONZEPT.md, Ausbau).

## Notfall

- App sofort ohne Wirkung: *Einstellungen → Automatik aus* (oder Testmodus an).
- Collector stoppen: `nssm stop HeizungMuenchen` → Loxone behält den letzten Wert;
  nach einem Miniserver-Neustart gilt der Standardwert 21 °C.
- Ganz zurück: in Loxone die Verbindung `API_Boost_Bad → ϑch` löschen.

---

## 6. Update: Analyse (Phase 1)

1. Supabase → SQL Editor → Inhalt von `supabase/migration-002-analyse.sql` → *Run*
   (neue Spalten Auto-Ladeleistung und Außentemperatur, Einstellung Grundlast, Auswertungsfunktionen).
2. Mini-PC:
   ```powershell
   cd C:\Users\ulibe\heizung-muenchen
   git pull
   C:\nssm\nssm.exe restart HeizungMuenchen
   ```
   Der Collector holt ab jetzt die Außentemperatur (Open-Meteo) und die Auto-Ladeleistung von evcc
   (`http://localhost:7070`). Fällt eine Quelle aus, läuft die Heizungssteuerung normal weiter.
3. App: Reiter **Analyse** → *Tag* (Energie, Heizstrom-Herkunft) und *Räume* (Kennzahlen je Raum).

Hinweis: Der Heizstrom ist bis zur Messung an der Wärmepumpe eine Schätzung
(Verbrauch − Auto − Grundlast). Die Grundlast ist unter *Einstellungen → Analyse* einstellbar.

---

## 7. Update: Analyse über Woche, Monat, Jahr

1. Supabase → SQL Editor → Inhalt von `supabase/migration-003-zeitraeume.sql` → *Run*.
   Am Ende erscheint `gespeicherte_tage` = Anzahl der bereits nachgetragenen Tage.
2. Mini-PC: `git pull` → `C:\nssm\nssm.exe restart HeizungMuenchen` (Collector 0.3.0).
   Der Collector speichert ab jetzt nach jeder Mitternacht die Tageswerte dauerhaft
   (`muc_daily_stats`, `muc_room_daily_stats`). Die Minutenwerte werden weiterhin nach 90 Tagen gelöscht,
   die Tageswerte bleiben – damit sind Monats- und Jahresauswertungen möglich.
3. App: Analyse → **Tag / Woche / Monat / Jahr** und **Energie / Räume**.

---

## 8. Update: Wetter und PV-Prognose vom FEMS (Collector 0.4.0)

Voraussetzung im FEMS (App-Center, beide kostenlos): **REST/JSON lesend** und **Wetter** installiert.

1. Supabase → SQL Editor → Inhalt von `supabase/migration-004-prognose.sql` → *Run*
   (Ergebnis: „muc_forecast angelegt“).
2. Mini-PC:
   ```powershell
   cd C:\Users\ulibe\heizung-muenchen
   git pull
   cd collector
   npm run test:wetter
   C:\nssm\nssm.exe restart HeizungMuenchen
   ```
   `test:wetter` zeigt Temperatur, Wetterlage und PV-Prognose so, wie sie gespeichert werden.
   Die `.env` muss nicht geändert werden (Standard: FEMS-IP aus `FENECON_HOST`, Port 80, Passwort `user`).
   Nur falls das FEMS-Gastpasswort geändert wurde: `FEMS_REST_PASSWORD=...` in die `.env`.
3. App → Übersicht: Karte **Wetter & PV-Prognose · FENECON** (nach spätestens 15 Minuten).

Kontrolle in Supabase:
```sql
select ts, outdoor_c, weather_code, sunshine_today_s, pv_1h, pv_24h, load_1h
from muc_forecast order by ts desc limit 5;
```

---

## 9. Update: Heizplan je Raum (Collector 0.5.0)

1. Supabase → SQL Editor → Inhalt von `supabase/migration-005-raumprofile.sql` → *Run*
   (Ergebnis: Liste der Räume mit morgens / tags / abends / pv_prio).
2. Mini-PC: `git pull` → `C:\nssm\nssm.exe restart HeizungMuenchen`.
3. App → *Einstellungen → Heizplan*: je Raum Morgens / Tagsüber / Abends und PV-Priorität einstellen, speichern.

---

## 10. Update: Tagesprotokoll und Prognose-Treffsicherheit (Collector 0.6.0)

Stufe A der vorausschauenden Steuerung – **ändert nichts an der Heizungssteuerung**.

1. Supabase → SQL Editor → Inhalt von `supabase/migration-006-tagesprotokoll.sql` → *Run*.
   Am Ende erscheint `nachgetragene_tage` = Anzahl der Tage, die aus den gespeicherten Prognosen
   (seit 23.10.2026) nachgetragen wurden.
2. Mini-PC:
   ```powershell
   cd C:\Users\ulibe\heizung-muenchen
   git pull
   C:\nssm\nssm.exe restart HeizungMuenchen
   ```
   Im Log erscheint „Collector 0.6.0 startet“ und kurz danach „Tagesprotokoll …: gespeichert“.
   Startet der Collector erst nach dem Morgen (wie beim Update am Nachmittag), wird der Tag als *verspätet* markiert
   und fließt nicht in die Mittagsauswertung ein – ab dem nächsten Morgen läuft es regulär um „Morgen ab“.
3. App neu laden (**Strg + Umschalt + R**) → *Analyse → Prognose*.

Kontrolle in Supabase:
```sql
select day, source, late, fc_ts, fc_pv_6h, fc_prev_noon_pv from muc_day_context order by day desc limit 7;
select * from muc_forecast_accuracy(current_date - 14, current_date);
```

---

## 11. Update: Raum-Prioritäten (Collector 0.7.1)

Wie in Venediger: Räume werden **nach Priorität** geheizt statt alle Ventile gleichzeitig.
Jeder Raum hat **Prio 1, 2, 3 oder 4**. Prio 1 wird zuerst geheizt. Alle Räume mit höherer Prio sind in
**Warteposition**: Sie bekommen die Temperatur, die sie beim Beginn des Wartens hatten – das Ventil bleibt zu.
Haben alle Räume einer Prio ihren Sollwert bis auf 0,3 °C erreicht, kommt die nächste Prio dran.
Fertige Räume halten ihren Sollwert; fällt einer unter Soll − 0,8 °C, ist seine Prio wieder zuerst dran.
Kommt eine Prio 180 min nicht ans Ziel, darf zusätzlich die nächste (Schutz gegen ein klemmendes Ventil).
Nachts bleibt alles auf Absenk, manuelle Werte (auch Alexa) haben Vorrang.

1. Supabase: `supabase/migration-008-reihenfolge.sql` (am 05.11.2026 bereits ausgeführt).
2. Mini-PC:
   ```powershell
   cd C:\Users\ulibe\heizung-muenchen
   git pull
   C:\nssm\nssm.exe restart HeizungMuenchen
   ```
   Im Log erscheint „Collector 0.7.1 startet“ und z. B. „Prio 1 ist dran – EG Küche/Essbereich 18,2 von 22,0 °C“.
3. App: *Einstellungen → Raum-Prioritäten* – je Raum Prio 1–4 wählen, *Prioritäten speichern*.
   Dort auch der Schalter **Nach Priorität heizen** (Aus = alle Räume gleichzeitig wie bis 0.6).
   Wartende Räume zeigt die Übersicht als **Wartet**, Wechsel stehen im Protokoll unter **Priorität**.

Feineinstellung in Supabase (`muc_settings`): `seq_on_delta`, `seq_off_delta`, `seq_max_minutes` (0 = nie freigeben).

---

## 12. Update: Aufheiz-Modell, einer nach dem anderen (Collector 0.8.0)

- **Gleichzeitig heizen** (Einstellungen → Raum-Prioritäten): Start mit **1 Raum** – einer nach dem anderen.
  Innerhalb einer Prio kommt der Raum zuerst, der am schnellsten fertig ist. Ein Raum, der heizt, bleibt dran, bis er fertig ist.
  Später auf 2–3 Räume erhöhen oder „ganze Prio“.
- **Messung:** Jeder Heizlauf (Raum darf heizen → fertig oder wartet) landet in `muc_heat_runs`
  (Start-/Endtemperatur, Minuten, wie viele Räume gleichzeitig, Heizstrom, außen).
  `muc_heat_rate` liefert je Raum °C pro Stunde aus den letzten 10 Läufen; bis 2 Läufe gemessen sind, gilt der
  Startwert aus dem Verlauf (`muc_rooms.heat_rate_seed`, Ende Okt./Anfang Nov. 2026, damals alle Ventile offen).
- Die App zeigt je Raum „1 °C in ca. …“, die Übersicht „es heizt Küche 21,2 von 22 °C, fertig in ca. 3 h 10 min“.

1. Supabase: `supabase/migration-009-aufheizen.sql` (am 05.11.2026 bereits ausgeführt).
2. Mini-PC: `git pull` → `C:\nssm\nssm.exe restart HeizungMuenchen` → Log „Collector 0.8.0 startet“.

Kontrolle:
```sql
select * from muc_heat_rate order by rate_c_per_h desc;
select r.name, h.* from muc_heat_runs h join muc_rooms r on r.id = h.room_id order by ended_at desc limit 20;
```

---

## 13. Update: Heiz-Reihenfolge wie in Venediger (Collector 0.9.0)

Gleiche Bedienung wie in Venediger: Jeder Raum hat eine **eigene Priorität P1, P2, P3 …** (`muc_rooms.priority`,
eindeutig – ersetzt `heat_rank`). Einstellungen → **Heiz-Reihenfolge** → mit ▲▼ zwei benachbarte Räume tauschen.
Die Automatik heizt zuerst P1, dann P2 … – höchstens **Gleichzeitig heizen** Räume auf einmal (Start: 1).
Alles andere (Warteposition, Messung der Heizläufe, Restzeit) bleibt wie in Abschnitt 11/12.

1. Supabase: `supabase/migration-010-prioritaet.sql` (am 05.11.2026 bereits ausgeführt).
2. Mini-PC: `git pull` → `C:\nssm\nssm.exe restart HeizungMuenchen` → Log „Collector 0.9.0 startet“.
   **Wichtig:** Ein älterer Collector (0.7/0.8) kennt die Spalte `priority` nicht und heizt bis zum Update ohne Reihenfolge.

---

## 14. Update: Prio-Gruppen 1–4 (Collector 0.10.0)

Uli (05.11.2026): Nicht jeder Raum eine eigene Nummer, sondern **Prio 1, 2, 3, eventuell 4** – mehrere Räume je Prio.
Einstellungen → **Raum-Prioritäten**: je Raum Prio wählen, *Prioritäten speichern*.
Prio 1 wird zuerst geheizt, dann Prio 2 … Innerhalb einer Prio heizen höchstens **Gleichzeitig heizen** Räume
(1–4 oder „ganze Prio“), zuerst der Raum, der am schnellsten fertig ist. Warteposition, Messung und Restzeit wie in 11/12.
(Venediger behält die eindeutigen Nummern P1–P12.)

1. Supabase: `supabase/migration-011-prio-gruppen.sql` (am 05.11.2026 bereits ausgeführt).
   Startwerte: Prio 1 = OG Luis Bad, OG Luis Schlafzimmer, OG Eltern Bad, OG Eltern Schlafzimmer · Prio 4 = KG Bad · übrige Prio 2.
2. Mini-PC: `git pull` → `C:\nssm\nssm.exe restart HeizungMuenchen` → Log „Collector 0.10.0 startet“
   (nur Texte geändert – 0.9.0 rechnet mit den Gruppen bereits richtig).
