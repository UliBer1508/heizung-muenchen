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
Es gibt keinen neuen Status in `backup_runs`; Venediger-App und Hausverwaltung brauchen deshalb keine Änderung.

## In der App

Einstellungen → **Datensicherung** (`frontend/src/Datensicherung.jsx`):

- Stand **je Rechner**: letzter Lauf, letzte gelungene Sicherung, Größe, Tabellen; beim Ersatz „⏸ Übersprungen“ mit Uhrzeit.
- **Rot**, wenn innerhalb der Warnschwelle (Standard 30 h) *keine* gelungene Sicherung vorliegt.
- **Gelb**, wenn der Hauptrechner ausbleibt und der Ersatz eingesprungen ist (Daten gesichert, PC München prüfen),
  oder wenn sich der Ersatz länger als die Warnschwelle nicht meldet (dann sichert niemand, falls München ausfällt).
- Verlauf der letzten 14 Tage.
- **Nur lesen.** Aktiv/Pausieren, Aufbewahrung und Warnschwelle gelten für beide Apps und werden in der
  **Venediger-App** eingestellt (Einstellungen → Datensicherung). Die München-App schreibt weiterhin nur in `muc_*`.

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
