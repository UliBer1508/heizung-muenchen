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
