# Alexa+-Add-on „Meine Heizung“ – München und Venediger (MCP)

**Stand:** 24.11.2026 · **Status:** gebaut und getestet (17 Tests, Prüfskript), noch nicht bei Amazon eingerichtet
**Konzept:** Projekt-Doc `konzept-alexa-plus-mcp.md` · **Vorgänger:** Skill „Meine Heizung“ (`ALEXA.md`, bleibt parallel)

Alexa+ versteht freie Sprache. Statt „Alexa, frag meine Heizung …“ mit festen Sätzen reicht z. B.
„Alexa, stell das Uli Bad für zwei Stunden auf 22 Grad“. Dafür ist die Heizung als **MCP-Server** angebunden:
Alexa+ ist der Client, wählt die passenden Tools und formuliert die Antwort. Zahlen und Schaltwege kommen nur
vom Server.

| | |
|---|---|
| Edge Function | `mcp-heizung` (Code `supabase/functions/mcp-heizung/`), **JWT-Prüfung aus** |
| Öffentliche Adresse | über die Heizungs-App auf Vercel (`frontend/vercel.json`): `https://<app>/mcp`, `/oauth/…`, `/.well-known/…` |
| Datenbank | `supabase/migration-017-alexa-plus.sql` – Tabelle `muc_mcp_oauth` (nur Hashes, nur service_role) |
| Kontoverknüpfung | Bestätigungsseite in der Heizungs-App (`frontend/src/AlexaVerknuepfen.jsx`, Adresse `/?alexa=…`) |
| Add-on-Vorlage | `alexa-plus/addon.vorlage.json`, Bilder und Seiten unter `frontend/public/alexa/` |
| Prüfskript | `node alexa-plus/pruefen.mjs <app-adresse> <client-id> <client-secret>` |
| Tests | `deno test -A supabase/tests/mcp-heizung.test.ts` |
| Protokoll | München: `muc_decisions`, Art `alexa_plus` (App → Protokoll → Filter **Alexa**) |

---

## 1. Grundsätze

1. **Alexa+ schaltet nie direkt.** Geschrieben wird auf denselben Wegen wie die Apps:
   München `muc_rooms.override_temp/override_until`, `muc_settings.automation_enabled`;
   Venediger `thermostat_commands` bzw. `tuya-control/set-temp`, `rooms.manual_override_until`, `presence_periods`.
2. **Das Sprachmodell rechnet und entscheidet nicht.** Grenzen (je Raum, höchstens 5–26 °C, höchstens 12 h),
   Raum- und Hauserkennung prüft der Server. Jede Antwort ist ein fertiger Satz mit den gemessenen Zahlen.
3. **Jede Antwort beginnt mit dem Haus:** „München: …“, „Venediger: …“.
4. **Nicht per Sprache:** Testmodus, Einstellungen, Raumprofile, KI-Vorschläge übernehmen.
5. **Rückfragen statt Raten:** Ausschalten der Automatik und „alle Räume in beiden Häusern“ nur nach Bestätigung.

## 2. Welches Haus, welcher Raum?

- **Haus genannt** („… in Venediger“) → dieses Haus.
- **Alexa+ weiß, wo das Echo steht** (Adresse des Geräts) → setzt das Haus selbst. Ob Alexa+ das tut, zeigt sich
  beim ersten Test.
- **Raum gibt es nur in einem Haus** → dieses Haus: „Bad Uli“, „Zimmer Luca“, „Kinderbad“ → Venediger;
  „Luis Bad“, „KG Bad“, „Hobbyraum“ → München.
- **Raum gibt es in beiden** („Wohnzimmer“, „Büro“) und kein Haus bekannt → **Fragen** beantwortet Alexa für beide
  Häuser, **Schalten** nur nach Rückfrage „In welchem Haus?“.
- **Wortstellung ist egal:** „Uli Bad“, „Bad Uli“, „Ulis Bad“, „Bad von Uli“ meinen denselben Raum.
- **Mehrdeutig im Haus** („Bad“ in München) → Rückfrage nach dem Geschoss.

## 3. Tools

| Tool | Art | Was |
|---|---|---|
| `haeuser_und_raeume` | lesen | alle Räume beider Häuser mit Ist/Soll, Grenzen, manuell bis |
| `status` | lesen | München: Hausmodus, Automatik, Testmodus, manuelle Räume, Collector, KI-Hinweise · Venediger: bewohnt/abwesend, Tagesmodus, heizende Räume |
| `raum` | lesen | Ist, Soll, heizt, manuell bis; München zusätzlich Ventil und Prognose für morgen früh |
| `energie` | lesen | PV, Akku, Netz jetzt; heute PV-Summe, Eigenverbrauch, Autarkie, Heizstrom (München) |
| `hinweise` | lesen | offene KI-Hinweise und Vorschläge München (nur vorlesen) |
| `tagesrueckblick` | lesen | Rückblick der täglichen KI-Analyse München |
| `anwesenheit_venediger` | lesen | bewohnt/abwesend, bis wann, nächste Abwesenheit |
| `raum_stellen` | schreiben | Übersteuerung mit Ablaufzeit (Standard 2 h, max. 12 h), Grenzen je Raum |
| `raum_automatisch` | schreiben | Übersteuerung eines Raums beenden |
| `alle_automatisch` | schreiben | alle Übersteuerungen eines Hauses beenden („beide“ nur mit Bestätigung) |
| `automatik_muenchen` | schreiben | Hauptschalter München (Ausschalten nur mit Bestätigung) |
| `abwesenheit_venediger` | schreiben | Abwesenheit eintragen (von/bis, ohne bis: eine Woche bis 14 Uhr) |
| `zurueck_in_venediger` | schreiben | laufende Abwesenheit endet jetzt |

**Venediger-Anwesenheit:** Seit 01.11.2026 ist der Grundzustand **bewohnt**, im Kalender stehen nur
**Abwesenheiten** (Venediger `doc/KONZEPT-ANWESENHEIT-2026-10-28.md` §9). Das Add-on folgt dieser Regel
(gleiche Rechnung wie `usePresence.computePresence`, Vorlauf vor der Rückkehr).

## 4. Einrichtung

### Schritt 1 – Datenbank
Supabase → SQL Editor → Inhalt von `supabase/migration-017-alexa-plus.sql` → **Run**.

### Schritt 2 – Secrets
Supabase → Edge Functions → **Secrets** → hinzufügen:

| Name | Wert |
|---|---|
| `MCP_CLIENT_ID` | frei wählbar, z. B. `meine-heizung-alexa` |
| `MCP_CLIENT_SECRET` | langer Zufallswert, z. B. erzeugt mit `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` |
| `MCP_ALLOWED_EMAILS` | deine Anmelde-E-Mail der Heizungs-App München |
| `MCP_APP_URL` | Adresse der Heizungs-App, z. B. `https://heizung-muenchen.vercel.app` (ohne `/` am Ende) |
| `MCP_PUBLIC_BASE` | dieselbe Adresse wie `MCP_APP_URL` |

Client-ID und -Secret brauchst du in Schritt 4 noch einmal. Nicht ins Repo schreiben.

### Schritt 3 – Bereitstellen und prüfen
1. Pull Request mergen. Die GitHub-Action deployt `mcp-heizung` (mit `--no-verify-jwt`) und `alexa-heizung`.
   Vercel baut die App neu und übernimmt `frontend/vercel.json`.
2. Prüfen (Mini-PC, im Repo-Ordner):
   `node alexa-plus/pruefen.mjs https://<app> <MCP_CLIENT_ID> <MCP_CLIENT_SECRET>` → alles ✓.

### Schritt 4 – Add-on bei Amazon anlegen (Phase 0)
1. Alexa AI CLI installieren: https://developer.amazon.com/docs/alexaplus/add-ons/set-up-your-development-environment
2. `alexa-ai configure` – Anmeldung mit `uli.berresheim@hotmail.de` (dasselbe Konto wie die Echos).
3. Im Repo-Ordner `alexa-plus`:
   `alexa-ai new mcp --name "Meine Heizung" --locale de-DE --mcp-server-url "https://<app>/mcp"`
   - Die CLI liest die 13 Tools vom Server. Für die Tool-Liste nutzt sie die Anmeldung Stufe 1 → Client-ID/-Secret angeben.
   - **Geht `de-DE` nicht**, ist das die Antwort auf die wichtigste Frage aus Phase 0: dann vorerst beim Skill bleiben.
4. In der erzeugten `addon.json` die Werte aus `addon.vorlage.json` übernehmen (`HEIZUNG_APP` ersetzen),
   Länder `DE`, `AT`. Kontoverknüpfung: Autorisierungs-URL `https://<app>/oauth/authorize`,
   Token-URL `https://<app>/oauth/token`, Client-ID/-Secret aus Schritt 2, Scopes `mcp:tools mcp:resources`.
5. `alexa-ai deploy` → Add-on steht im Entwicklungsstadium (wird **nicht** veröffentlicht).
6. Zeigt die Kontoverknüpfung eine Amazon-Rücksprungadresse, die abgelehnt wird (Meldung „redirect_uri nicht
   erlaubt“ in den Function-Logs), deren Host als Secret `MCP_REDIRECT_HOSTS` ergänzen.

### Schritt 5 – Konto verknüpfen
Alexa-App → Add-on „Meine Heizung“ → **Verknüpfen**. Es öffnet sich die Heizungs-App mit „Alexa verknüpfen“
(ggf. erst anmelden) → **Erlauben** → zurück zur Alexa-App.

### Schritt 6 – Testen
Erst im Web-Simulator der Developer Console, dann am Echo bzw. in der Alexa-App:
- „Wie warm ist es im Bad im Keller?“ → „München: Im KG Bad sind es …“
- „Stell das Uli Bad für zwei Stunden auf 22 Grad“ → „Venediger: Okay, Bad Uli steht auf 22 Grad bis …“
- „Wie hoch ist der Eigenverbrauch in beiden Häusern?“
- „Mach das Wohnzimmer wärmer“ → Rückfrage „In welchem Haus?“ (wenn Alexa+ den Standort nicht kennt)
- „Stell das Bad auf 30 Grad“ → begrenzt mit Hinweis
- „Wir sind ab Freitag bis Dienstag nicht in Venediger“ → Abwesenheit, Prüfen in der Venediger-App (Kalender)
- „Schalte die Automatik in München aus“ → Rückfrage, nichts geändert bis „ja“

## 5. Fehlersuche

| Symptom | Ursache / Abhilfe |
|---|---|
| Prüfskript: Metadaten fehlen | `frontend/vercel.json` nicht deployt oder `MCP_PUBLIC_BASE` falsch |
| Prüfskript: kein Token | `MCP_CLIENT_ID`/`MCP_CLIENT_SECRET` stimmen nicht; Logs: `token: falscher Client` |
| Verknüpfung: „nicht freigegeben“ | angemeldetes Konto steht nicht in `MCP_ALLOWED_EMAILS` |
| Verknüpfung: „Anfrage abgelaufen“ | länger als 15 Minuten gewartet → in der Alexa-App neu verknüpfen |
| Alexa: „Ich komme gerade nicht an die Heizungsdaten“ | Function-Logs `mcp-heizung`: `tool … Fehler` |
| Alexa antwortet langsam | Logs zeigen je Tool die Dauer (`tool status 120 ms`); Alexa+ verlangt < 500 ms |
| München: Befehl kommt an, Loxone ändert nichts | Testmodus an oder Automatik aus (sagt Alexa dazu); Collector läuft? |
| Venediger: Befehl kommt an, Thermostat ändert nichts | lokaler Modus: Tuya-Dienst auf dem Mini-PC; Cloud: Tuya-Kontingent |

## 6. Sicherheit

- Anmeldung nach OAuth 2.1: Stufe 1 `client_credentials` (nur Tool-Liste), Stufe 2 `authorization_code` mit PKCE (S256)
  für alle Tool-Aufrufe. Tokens 1 Stunde, Refresh 90 Tage mit Rotation, Codes 5 Minuten und nur einmal gültig.
- Gespeichert wird nur der SHA-256-Hash. Der Bestätigungsschritt läuft in der Heizungs-App mit deinem normalen Login,
  der Server sieht nie ein Passwort.
- Rücksprung nur zu Amazon-Adressen (`redirect_uri`-Prüfung).
- **Alle Alexa+-Zugänge sperren:** SQL `delete from muc_mcp_oauth;` – wirkt sofort für neue Anmeldungen, laufende
  Zugänge spätestens nach 5 Minuten (Zwischenspeicher der Function). Danach muss neu verknüpft werden.
- Abwesenheiten höchstens 90 Tage am Stück, Übersteuerungen höchstens 12 Stunden.

## 7. Offen (Phase 0)

- Geht `de-DE` / `DE, AT` für ein privates MCP-Add-on? (Schritt 4.3)
- Läuft der Test im Entwicklungsstadium auf den eigenen Echos und nicht nur im Web-Simulator?
- Schickt Alexa+ den Standort des Echos mit bzw. setzt es `haus` selbst?
- Erwartet Alexa+ die Metadaten unter `/.well-known/…` der App-Adresse (eingerichtet) oder eigene Angaben in der `addon.json`?
- Echo-Geräte: Echo Spot (2017) in München kann kein Alexa+ – dort bleibt der Skill.
