# Alexa-Skill „Meine Heizung“ – München und Venediger

**Stand:** 29.10.2026 · **Status:** eingerichtet und getestet (Alexa-Simulator), Skill im Entwicklungsmodus

Ein Alexa-Skill für **beide Häuser**. Beide liegen im selben Supabase-Projekt `pflnniklvqbwjwrjswaz`
(„KI-Heizungssteuerung“): München in den `muc_`-Tabellen, Venediger in `rooms`, `energy_readings`,
`presence_periods` usw. Eine einzige Edge Function bedient beide.

| | |
|---|---|
| Skill | „Meine Heizung“, Custom, German (DE), Aufrufname **„meine heizung“**, Status *In Dev* |
| Amazon-Konto | Alexa Developer Console mit `uli.berresheim@hotmail.de` (dasselbe Konto wie die Echos) |
| Endpunkt | `https://pflnniklvqbwjwrjswaz.supabase.co/functions/v1/alexa-heizung` (HTTPS, Wildcard-Zertifikat) |
| Edge Function | `alexa-heizung`, Code: `supabase/functions/alexa-heizung/index.ts`, **JWT-Prüfung aus** |
| Sprachmodell | `alexa/interaction-model-de-DE.json` (16 Intents, Slot-Typen `RAUM`, `HAUS`, `SCHALTER`) |
| Secrets | `ALEXA_SKILL_ID` (Pflicht), `ALEXA_USER_IDS` und `ALEXA_VEN_DEVICES` (optional) |

Kontrolle im Browser: Die Endpunkt-URL zeigt „Meine Heizung – Alexa-Endpunkt (München und Venediger)“.

---

## 1. Grundsatz: Alexa schaltet nie direkt

Alexa schreibt auf **denselben Wegen wie die jeweilige App**. So kann die Automatik einen Sprachbefehl
nicht überschreiben, und es gelten dieselben Grenzen.

| | München | Venediger |
|---|---|---|
| Raum stellen | `muc_rooms.override_temp` + `override_until` → Collector setzt es in Loxone um | wie `useTuyaControl.setTemperature`: Befehl in `thermostat_commands` (lokaler Modus) bzw. Edge Function `tuya-control/set-temp` (Cloud-Modus, je nach `system_settings.tuya_control_mode`), dazu `rooms.manual_override_until` + `target_temp` |
| Raum wieder automatisch | `override_temp` / `override_until` = leer | `rooms.manual_override_until` = leer |
| Automatik an/aus | `muc_settings.automation_enabled` | – (nur je Raum in der App) |
| Anwesenheit | – | `presence_periods` wie der Schnellschalter der App (Quelle `quick`, Notiz „Alexa“) |
| Protokoll | `muc_decisions`, Art `alexa` (App → Protokoll → Filter **Alexa**) | Befehle in `thermostat_commands` |
| Grenzen | `min_temp` / `max_temp` je Raum, höchstens 5–26 °C | 5–26 °C |
| Testmodus | Ist der Testmodus an oder die Automatik aus, sagt Alexa das dazu | – |

## 2. Welches Haus?

1. Ausdrücklich genannt: „… **in Venediger**“, „… **in München**“, „… **in beiden Häusern**“
   (Synonyme: Venedigersiedlung, Neukirchen, Österreich · Weidmannstraße, Stadt · überall).
2. Sonst das Haus, in dem das Echo steht: Geräte-IDs im Secret `ALEXA_VEN_DEVICES` → Venediger.
3. Sonst **München**.

**Räume** werden aus der Datenbank erkannt (`muc_rooms` bzw. `rooms`), neue oder umbenannte Räume
funktionieren also ohne Änderung am Skill. Das Haus des Echos hat Vorrang. Das andere Haus gewinnt nur
mit klar besserem Treffer, z. B. gibt es „Bad Uli“, „Zimmer Luca“ oder „Kinderbad“ nur in Venediger. Alexa
sagt dann „In Venediger: …“ dazu. Bei „Wohnzimmer“ gilt das Haus des Echos.

Geschoss als Wort oder Kürzel: Keller/KG, Erdgeschoss/EG, Obergeschoss/OG, Dachgeschoss/DG. Bei
Mehrdeutigkeit fragt Alexa nach („Meinst du KG Bad oder DG Bad?“), und die kurze Antwort genügt („Keller“).

## 3. Befehle

Fragen beginnen mit „Alexa, **frag** meine Heizung, …“, Befehle mit „Alexa, **sag** meine Heizung, …“.

| Du sagst … | Alexa macht |
|---|---|
| „… wie hoch ist der Eigenverbrauch?“ (auch „… in Venediger“, „… in beiden Häusern“) | PV, Akku, Netz jetzt; heute: PV-Summe, Eigenverbrauchsquote, Autarkie; München zusätzlich Heizstrom aus dem Netz |
| „… wie warm ist es im Bad im Keller?“ | Ist, Soll, Modus bzw. heizt/heizt nicht, Ventil (München), manuell bis |
| „… nach dem Status“ | München: Hausmodus, manuelle Räume, Collector-/Testmodus-Warnung. Venediger: anwesend/leer, Tagesmodus, heizende Räume, manuelle Räume |
| „… stelle das Wohnzimmer für drei Stunden auf 22 Grad“ | Übersteuerung mit Ablaufzeit (ohne Dauer 2 h, höchstens 12 h) |
| „… mach das Bad im Dachgeschoss warm“ | Übersteuerung auf PV-Temperatur (München) bzw. Komfort (Venediger), 2 h |
| „… Wohnzimmer wieder automatisch“ | Übersteuerung beenden |
| „… alle Räume wieder automatisch“ (auch „… in Venediger“) | alle Übersteuerungen eines Hauses beenden |
| „… Automatik aus“ / „… an“ | nur München |
| „… ich bin da bis Sonntag“ | Venediger: anwesend ab jetzt bis zum Datum (Standard-Abreisezeit, sonst 11:00); ohne Datum bis kommenden Sonntag 18:00 |
| „… ich bin weg“ | Venediger: laufende Anwesenheit endet jetzt, künftige Einträge bleiben |
| „… bis wann sind wir eingetragen?“ | Venediger: anwesend bis / leer, nächste Ankunft |

## 4. Einrichtung (so wurde es am 29.10.2026 gemacht)

### 4.1 Edge Function (Supabase-Dashboard)
1. Edge Functions → **Deploy a new function → Via Editor**, Name `alexa-heizung`, Inhalt von
   `supabase/functions/alexa-heizung/index.ts` → **Deploy**.
2. Function → **Settings** → **„Verify JWT with legacy secret“ aus** → Save changes.
   (Alexa schickt keinen Supabase-Token; geschützt wird über die Skill-ID.)
3. CLI-Alternative: `supabase functions deploy alexa-heizung --no-verify-jwt`

`SUPABASE_URL` und `SUPABASE_SERVICE_ROLE_KEY` stellt Supabase automatisch bereit.

### 4.2 Skill (Alexa Developer Console)
1. **Create Skill** → „Meine Heizung“, **German (DE)**, Other → **Custom** → **Provision your own** →
   Start from Scratch.
2. Build → Interaction Model → **JSON Editor**: Inhalt von `alexa/interaction-model-de-DE.json` → Save →
   **Build skill**.
3. Build → **Endpoint**: **HTTPS**, Default Region = Endpunkt-URL, Zertifikat *„My development endpoint is
   a sub-domain of a domain that has a wildcard certificate from a certificate authority“* → Save.
4. Skill-ID (Endpoint-Seite, „Copy to Clipboard“).

### 4.3 Secret
Supabase → Edge Functions → **Secrets** → `ALEXA_SKILL_ID` = Skill-ID. Kontrolle: Die angezeigte
SHA256-Prüfsumme muss zu `printf '%s' '<skill-id>' | sha256sum` passen (dann ohne Leerzeichen/Umbruch).

### 4.4 Test
Developer Console → **Test** → „Skill testing is enabled in“ **Development** → z. B.
`frag meine heizung wie hoch ist der eigenverbrauch in beiden häusern`.
Ab dann geht es auf allen Echos im Konto, ohne Veröffentlichung.

### 4.5 Optional
- **Nur dein Konto zulassen:** „Alexa, öffne meine Heizung“ → in den Function-Logs steht
  `Alexa-Benutzer: amzn1.ask.account.…` → als Secret `ALEXA_USER_IDS`.
- **Echos in Venediger zuordnen:** am Echo dort „Alexa, öffne meine Heizung“ → in den Logs steht
  `Alexa-Gerät: amzn1.ask.device.…` → als Secret `ALEXA_VEN_DEVICES` (mehrere durch Komma).

## 5. Änderungen einspielen

| Was geändert | Wo einspielen |
|---|---|
| `index.ts` | Supabase → Edge Functions → `alexa-heizung` → **Code** → Inhalt ersetzen → **Deploy** |
| `interaction-model-de-DE.json` | Developer Console → JSON Editor → einfügen → Save → **Build skill** |
| neue Räume | nichts – werden aus der Datenbank erkannt. Für bessere Spracherkennung optional den Namen im Slot-Typ `RAUM` ergänzen |

## 6. Fehlersuche

| Symptom | Ursache |
|---|---|
| „Beim Antworten des Skills ist ein Problem aufgetreten“ | Function-Logs ansehen: `abgelehnt: falsche Skill-ID` → Secret prüfen; 401 → JWT-Prüfung noch an |
| „Ich komme gerade nicht an die Heizungsdaten“ | Datenbankfehler, Details in den Function-Logs |
| Raum wird nicht erkannt | Raumnamen in `muc_rooms` / `rooms` prüfen; Synonyme in `SYNONYMS` (Function) oder Slot-Typ `RAUM` |
| München: Befehl kommt an, Loxone ändert nichts | Testmodus an oder Automatik aus (sagt Alexa dazu); Collector läuft? |
| Venediger: Befehl kommt an, Thermostat ändert nichts | lokaler Modus: Tuya-Dienst auf dem Mini-PC läuft? `thermostat_commands` bleibt sonst `pending`. Cloud-Modus: Tuya-Kontingent |
| Venediger antwortet „Messwerte … Minuten alt“ | Fronius-Collector auf dem Mini-PC prüfen |
| Echo in Venediger meint München | `ALEXA_VEN_DEVICES` fehlt (4.5) – oder „… in Venediger“ sagen |

## 7. Sicherheit

- Die Function prüft **Skill-ID** und **Zeitstempel** (max. 150 s), optional die **Benutzer-ID**.
  Die volle Signaturprüfung der Amazon-Zertifikate ist nur für veröffentlichte Skills Pflicht und nicht eingebaut.
- Der service_role-Key bleibt in Supabase. Skill-ID und Secrets stehen nicht im Repo.
- Alexa kann nur, was die Function anbietet: Abfragen, Übersteuerungen, Automatik (München), Anwesenheit
  (Venediger). Kein Testmodus-Schalter, keine Einstellungen, keine Raumprofile.

## 8. Ideen für später

- Alexa meldet sich von selbst („Akku voll, ich heize den Estrich vor“) – braucht proaktive Benachrichtigungen.
- Handy im WLAN setzt Venediger automatisch auf „anwesend“ (siehe Venediger-Konzept Anwesenheit, Abschnitt 6).
- Echo-Routine „Guten Morgen“ mit Eigenverbrauch und Raumtemperaturen.
