# Datensicherung – Heizung München

> Stand: 13.11.2026 (Ersatz-Rechner) · Supabase-Projekt `pflnniklvqbwjwrjswaz` (gemeinsam mit Venediger)
> Vorbild: Venediger `doc/DATENSICHERUNG.md`

## Grundsatz

- München hat **kein eigenes Supabase-Projekt** (Gratis-Limit von zwei Projekten erreicht).
  Alle Münchner Tabellen (`muc_*`) liegen im Venediger-Projekt.
- Supabase macht im Free-Plan **keine** Backups. Deshalb sichert ein Skript jede Nacht die
  **komplette Datenbank** des Projekts ins OneDrive – München ist damit **immer mit drin**.
  Kontrolle 13.11.2026: 22 `muc_*`-Tabellen, Tabellenzahl der Sicherung von 75 (15.10.) auf 120 gestiegen.
- Daten (Supabase) und Sicherungen (OneDrive) liegen beide in der Cloud. Der PC ist nur der
  **Ausführende** (`pg_dump` → OneDrive). Fällt er aus, geht nichts verloren – es entsteht nur keine neue Sicherung.

## Was wo liegt

| Was | Wo |
|---|---|
| Sicherungen | `OneDrive\Backups\Supabase-Heizung\JJJJ-MM-TT_HHMM\datenbank.dump` |
| Status auf einen Blick | `OneDrive\Backups\Supabase-Heizung\LETZTE-SICHERUNG.txt` |
| Skripte | `C:\Users\ulibe\supabase-backup\` (`Backup-Supabase.ps1`, Profil **„Heizung“**) |
| Geplante Aufgabe | „Supabase-Sicherung Heizung“ |
| Protokoll je Lauf | Tabelle `backup_runs` (eine Zeile pro Lauf, mit Rechnername `host`) |
| Einstellungen | `system_settings.backup_settings` (aktiv, Aufbewahrung, Warnschwelle) |

## Wer sichert

| Rechner | Rolle | Uhrzeit | Ordner |
|---|---|---|---|
| PC München (`MINIPC-WEIDMANN`) | **Hauptrechner** – sichert jede Nacht | 03:45 eingestellt, seit Zeitumstellung tatsächlich **02:45** (Aufgabe hängt an UTC) | `OneDrive\Backups\Supabase-Heizung` |
| PC Österreich (`MINIPC-VENEDIGE`, Windows kürzt auf 15 Zeichen) | **Ersatz** – sichert nur, wenn nötig | 04:15 | `OneDrive\Backups\Supabase-Heizung-Oesterreich` |

**Ersatz-Regel (Skript v5, 13.11.2026):** Steht in `config.json` des Profils `"StandbyHours": 20`, prüft der PC vor dem Sichern
in `backup_runs`, ob ein **anderer** Rechner in den letzten 20 Stunden erfolgreich gesichert hat.
- Ja → **keine** Sicherung, **keine** Zeile in `backup_runs`, nur ein Lebenszeichen in `system_settings.backup_standby`
  (`host`, `checked_at`, `result = uebersprungen`, `main_host`, `main_finished`). `LETZTE-SICHERUNG.txt` zeigt „ÜBERSPRUNGEN“.
- Nein → normale Sicherung (springt ein), Lebenszeichen mit `result = gesichert`.
- Prüfung nicht möglich (Netz, Passwort) → sicherheitshalber sichern.

Ohne `StandbyHours` verhält sich das Skript wie v4 – PC München und Hausverwaltung bleiben unverändert.
Es gibt keinen neuen Status in `backup_runs`. Die Venediger-App zeigt seit 13.11.2026 (Version 2.28.0) ebenfalls beide PCs.

## In der App

Einstellungen → **Datensicherung** (`frontend/src/Datensicherung.jsx`):

- Stand **je Rechner**: letzter Lauf, letzte gelungene Sicherung, Größe, Tabellen; beim Ersatz „⏸ Bereit – nicht nötig“ mit Uhrzeit (bis 23.11.2026 „Übersprungen“ – klang nach Fehler).
- Darstellung seit 13.11.2026 **gleich wie Venediger**: je PC eine Karte (Rolle, Status, letzter Lauf, letzte gelungene,
  Datenbank, Uhrzeit, Ordner), darunter Verlauf 14 Tage mit Rechner je Lauf.
- **Rot**, wenn innerhalb der Warnschwelle (Standard 30 h) *keine* gelungene Sicherung vorliegt.
- **Gelb**, wenn der Hauptrechner ausbleibt und der Ersatz eingesprungen ist (Daten gesichert, PC München prüfen),
  oder wenn sich der Ersatz länger als die Warnschwelle nicht meldet (dann sichert niemand, falls München ausfällt).
- Verlauf der letzten 14 Tage.
- **Nur lesen.** Aktiv/Pausieren, Aufbewahrung und Warnschwelle gelten für beide Apps und werden in der
  **Venediger-App** eingestellt (Einstellungen → Datensicherung). Die München-App schreibt weiterhin nur in `muc_*`.

**Systemstatus (23.11.2026):** Im Systemstatus-Fenster steht unter „Alles läuft“ die Karte **„Sicherungen“**.
Sie zeigt, wann zuletzt gesichert wurde, von welchem PC, mit welcher Größe und ob PC Österreich bereit war, ohne sichern zu müssen („PC Österreich bereit (nicht nötig)“, seit 24.11.2026)
(`frontend/src/SystemStatus.jsx`, Urteil `bewerten()` aus `Datensicherung.jsx`). Gibt es in der Warnschwelle
keine gelungene Sicherung, zählt das im Symbol als Problem. Venediger zeigt dasselbe.

## Nur München wiederherstellen

Eine Sicherung enthält beide Systeme. Für München nur die `muc_*`-Tabellen zurückspielen – Venediger bleibt unberührt.
PowerShell am PC (PostgreSQL-Werkzeuge installiert), Verbindungszeile aus Supabase → Connect → **Session pooler**:

```powershell
$dump = "$env:OneDrive\Backups\Supabase-Heizung\2026-11-13_0245\datenbank.dump"

# 1. Ansehen, welche München-Teile drin sind
pg_restore -l $dump | Select-String "muc_"

# 2. Liste nur mit muc_-Einträgen erzeugen
pg_restore -l $dump | Select-String "muc_" | Set-Content muc.list

# 3. Zurückspielen (Daten der muc_-Tabellen werden ersetzt)
pg_restore --clean --if-exists --no-owner --no-privileges -L muc.list -d "<Verbindungszeile>" $dump
```

Vorher den Collector stoppen (`C:\nssm\nssm.exe stop HeizungMuenchen`), danach wieder starten.
Einzelne Tabelle: statt Schritt 2/3 `pg_restore --data-only -t muc_rooms -d "<Verbindungszeile>" $dump`.
Ausführliche Anleitung (komplette Wiederherstellung): Hausverwaltung, `docs/Datensicherung.md`.

## Wartung

| Anlass | Befehl |
|---|---|
| Datenbank-Passwort geändert | `.\Set-DbPassword.ps1 -Profil Heizung` (auf **jedem** sichernden PC) |
| Sicherung sofort starten | Aufgabenplanung → „Supabase-Sicherung Heizung“ → Ausführen |
| Lebenszeichen Ersatz | `select value from system_settings where key = 'backup_standby';` |
| Kontrolle in Supabase | `select host, max(finished_at), count(*) from backup_runs group by host;` |

## Uhrzeit ändern (24.11.2026)

Uli: „Ich will eine Einstellung in den Karten, um die Zeiten zu ändern. Ich ändere die Zeit und drücke einen Button,
der die Änderung ausführt.“ – in **Heizung Venediger und Heizung München**, Einstellungen › Datensicherung, Karte je PC.

| Schritt | Wer | Was |
|---|---|---|
| 1 | App | Uhrzeit eintragen › **Uhrzeit ändern** → Zeile in `service_commands` (`action = 'backup_time'`, `param = 'HH:MM'`, `service_name = 'backup'`) |
| 2 | Datenbank (SQL 55) | prüft: nur Admins, PC bekannt, Uhrzeit gültig, kein zweiter Befehl offen |
| 3 | Dienste-Wächter des PCs (ab **v1.1**, alle 30 s) | stellt die geplante Aufgabe **„Supabase-Sicherung Heizung“** auf *täglich HH:MM Ortszeit* (`Set-ScheduledTask`) |
| 4 | Wächter → App | Ergebnis unter dem Button: „✓ täglich 03:45 – nächster Lauf 25.11. 03:45“ oder der Fehler |

- Die Karte findet den Wächter über den Rechnernamen (`system_hosts.info.computer` beginnt mit dem Namen aus `backup_runs`).
- Der neue Auslöser gilt in **Ortszeit** – damit ist auch das Problem „läuft seit der Zeitumstellung 1 h früher“ (Aufgabe hing an UTC) weg.
- Die Zeile „Uhrzeit“ in der Karte zeigt weiter, was das Sicherungsskript beim letzten Lauf gemeldet hat; sie springt nach der nächsten Sicherung um.
- **PC Österreich soll nach PC München laufen** (heute 03:45 und 04:15), sonst sichert der schwächere PC zuerst und München überspringt nicht – beide würden sichern.
- Fehlermeldungen: „Aufgabe … nicht gefunden“ (anderer Name → `config.json` des Wächters: `"backup_task"`),
  „mit Kennwort gespeichert“ (Uhrzeit einmal von Hand in der Aufgabenplanung ändern), „kein Zugriff“ (Wächter-Dienst ohne Adminrechte).
- Taste grau mit Hinweis: Wächter älter als v1.1, PC meldet sich nicht, oder nicht als Admin angemeldet.

**Einrichten (einmal):** SQL `55_sicherung_uhrzeit.sql` (Venediger-Repo) ausführen, dann den Wächter auf beiden PCs aktualisieren:

```powershell
# PC Österreich
cd C:\Heizung\repo; git pull; nssm restart DiensteWaechter
# PC München (Wächter liegt als Kopie in C:\Users\ulibe\dienste-waechter)
Invoke-WebRequest https://raw.githubusercontent.com/UliBer1508/smartfox-insight-ai-selfhosted/main/local-collector/dienste-waechter/index.js -OutFile C:\Users\ulibe\dienste-waechter\index.js
C:\nssm\nssm.exe restart DiensteWaechter
```
Danach zeigt der Systemstatus bei beiden PCs Wächter **1.1**.
