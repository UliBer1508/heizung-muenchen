# Alexa-Skill „Heizung München“

Alexa spricht **nicht direkt mit Loxone**, sondern mit der Supabase Edge Function `alexa-heizung`.
Die Function schreibt in dieselben Felder wie die App (`override_temp` / `override_until` in `muc_rooms`,
`automation_enabled` in `muc_settings`). Der Collector setzt das beim nächsten Durchlauf in Loxone um.
Damit kann die Automatik einen Sprachbefehl nicht überschreiben, und jeder Befehl steht im Protokoll
(Filter **Alexa**).

Es gelten dieselben Regeln wie in der App:
- Grenzen je Raum (`min_temp` / `max_temp`, höchstens 5–26 °C)
- **Testmodus an** → es wird nichts geschaltet (Alexa sagt das dazu)
- **Automatik aus** → der Collector schreibt nichts nach Loxone (Alexa sagt das dazu)

## Was der Skill kann

| Du sagst … | Alexa macht |
|---|---|
| „Alexa, frag Heizung München, wie hoch ist der Eigenverbrauch?“ | PV jetzt, Akku, Netz; heute: PV-Summe, Eigenverbrauchsquote, Autarkie, Heizstrom aus dem Netz |
| „Alexa, frag Heizung München, wie warm ist es im Bad im Keller?“ | Ist-Temperatur, Soll, Raummodus, Ventil |
| „Alexa, frag Heizung München nach dem Status“ | Hausmodus, manuell gestellte Räume, Warnung bei Collector-Ausfall / Testmodus |
| „Alexa, sag Heizung München, stelle das Wohnzimmer für drei Stunden auf 22 Grad“ | Übersteuerung mit Ablaufzeit |
| „Alexa, sag Heizung München, mach das Bad im Dachgeschoss warm“ | Übersteuerung auf die PV-Temperatur des Raums, 2 Stunden |
| „Alexa, sag Heizung München, Wohnzimmer wieder automatisch“ | Übersteuerung beenden |
| „Alexa, sag Heizung München, alle Räume wieder automatisch“ | alle Übersteuerungen beenden |
| „Alexa, sag Heizung München, Automatik aus“ / „… an“ | Automatik schalten |

Ohne Dauer gelten **2 Stunden**, höchstens **12 Stunden**.

**Räume** werden aus `muc_rooms` erkannt, neue Räume funktionieren also automatisch. Geschoss geht als
Wort oder Kürzel: Keller/KG, Erdgeschoss/EG, Obergeschoss/OG, Dachgeschoss/DG. Bei Mehrdeutigkeit fragt Alexa
nach („Meinst du KG Bad oder DG Bad?“), und es reicht die kurze Antwort („Keller“).

## Einrichtung

### 1. Edge Function anlegen (Supabase-Dashboard, Venediger-Projekt)

1. **Edge Functions → Deploy a new function → Via Editor**
2. Name: `alexa-heizung`
3. Inhalt von `supabase/functions/alexa-heizung/index.ts` einfügen → **Deploy**
4. In der Function unter **Details/Settings**: **„Enforce JWT verification“ ausschalten**
   (Alexa schickt keinen Supabase-Token; geschützt wird über die Skill-ID).
5. URL notieren: `https://<projekt-ref>.supabase.co/functions/v1/alexa-heizung`

Alternativ mit der CLI: `supabase functions deploy alexa-heizung --no-verify-jwt`

`SUPABASE_URL` und `SUPABASE_SERVICE_ROLE_KEY` stellt Supabase der Function automatisch bereit.

### 2. Skill anlegen (Alexa Developer Console)

Mit **demselben Amazon-Konto**, an dem die Echo-Geräte hängen: <https://developer.amazon.com/alexa/console/ask>

1. **Create Skill** → Name „Heizung München“, Sprache **German (DE)**
2. Typ **Other → Custom**, Hosting **Provision your own**, Vorlage **Start from Scratch**
3. **Build → Interaction Model → JSON Editor**: Inhalt von `alexa/interaction-model-de-DE.json` einfügen
   → **Save** → **Build skill** (dauert ca. 1 Minute)
4. **Build → Endpoint**: **HTTPS**, Default Region = URL aus Schritt 1.5,
   Zertifikat: *„My development endpoint is a sub-domain of a domain that has a wildcard certificate from a
   certificate authority“* → **Save**
5. Oben links die **Skill-ID** kopieren (`amzn1.ask.skill.…`)

### 3. Skill-ID hinterlegen

Supabase → **Edge Functions → Secrets** → `ALEXA_SKILL_ID` = Skill-ID aus 2.5.
Ohne diesen Wert lehnt die Function **alle** Anfragen ab.

### 4. Testen

1. Developer Console → **Test** → „Skill testing is enabled in“ auf **Development** stellen
2. Im Textfeld tippen: `frag heizung münchen wie hoch ist der eigenverbrauch`
3. Danach geht es auf jedem Echo im Konto. Der Skill bleibt privat (Entwicklungsmodus), es ist
   **keine Veröffentlichung** nötig.

Erst mit **Testmodus an** ausprobieren: Die Befehle landen im Protokoll, geschaltet wird nichts.

### 5. Optional: nur dein Alexa-Konto zulassen

Nach dem ersten „Alexa, öffne Heizung München“ steht in den Function-Logs
(Edge Functions → alexa-heizung → Logs) die Zeile `Alexa-Benutzer: amzn1.ask.account.…`.
Diesen Wert als Secret `ALEXA_USER_IDS` hinterlegen (mehrere durch Komma).

## Fehlersuche

| Symptom | Ursache |
|---|---|
| Alexa: „Beim Antworten des Skills ist ein Problem aufgetreten“ | Function-Logs ansehen. `abgelehnt: falsche Skill-ID` → Secret prüfen. 401 → JWT-Prüfung ist noch an. |
| „Ich komme gerade nicht an die Heizungsdaten“ | Datenbankfehler, steht in den Function-Logs |
| Raum wird nicht erkannt | Raumnamen in `muc_rooms` prüfen; Synonyme ergänzen im Slot-Typ `RAUM` des Interaction Models oder in `SYNONYMS` in der Function |
| Befehl kommt an, aber Loxone ändert nichts | Testmodus oder Automatik aus (sagt Alexa dazu); Collector läuft? |

## Sicherheit

- Die Function prüft **Skill-ID** und **Zeitstempel** (max. 150 s alt), optional die **Benutzer-ID**.
  Die volle Signaturprüfung von Amazon-Zertifikaten ist nur für veröffentlichte Skills Pflicht und hier nicht eingebaut.
- Die Function nutzt den service_role-Key nur serverseitig; er verlässt Supabase nicht.
- Alexa kann nur, was die Function anbietet: Übersteuerungen, Automatik, Abfragen. Kein Testmodus-Schalter,
  keine Einstellungen, keine Raumprofile.
