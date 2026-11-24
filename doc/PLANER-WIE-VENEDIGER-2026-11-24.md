# Planer und Auto-Steuerung auf den Stand von Venediger (24.11.2026)

**Uli, 24.11.2026:** „Die Version in Venediger ist doch die bessere: die KI rechnet mit und wird trainiert, dass sie besser
als die Planung wird. Warum wird das nicht in München gemacht? Beide Systeme sollten gleich sein, war das nicht unsere
Forderung?“ → „So machen, lies die Doku in beiden Systemen und den Source-Code vorher.“

**Vorbild Venediger** (Repo `smartfox-insight-ai-selfhosted`, Stand Commit `af244ae`):
`FIX-PLANER-MODELL-2026-11-13.md`, `FIX-PLANER-PRUEFUNG-2026-11-13.md`, `FIX-PLANER-MIN-HART-2026-11-14.md`,
`FIX-PLANER-TIMEOUT-2026-11-14.md`, `FIX-REGELN-RAHMEN-FUER-PLANER-2026-11-16.md` (mit beiden Nachträgen).
Übernommen nach der Grundregel (`KONZEPT.md`): Logik und Aussehen gleich, Unterschiede nur, wo die Heizart sie verlangt.
Venediger wird nicht geändert. Wie es künftig gleich bleibt: [`ABGLEICH-VENEDIGER.md`](ABGLEICH-VENEDIGER.md).

**Betrifft:** Edge Function `heizplaner-muenchen` (alle Dateien, neu `pruefung.ts`, `_shared/heizregeln.ts`),
Collector 0.14.0 (neu `src/plan.js`), `supabase/migration-018-planer-wie-venediger.sql`, App (Auto-Steuerung, Plan,
„Wo stehen wir?“, Protokoll), Alexa-Texte.

---

## 1. Befund: Was München vom Planer hatte

| | Venediger (24.11.) | München `main` | München live (Supabase) |
|---|---|---|---|
| Stand | `af244ae` | Kopie von `bf8d3a7` (12.11.) | Zweig `ki-pruefungen-planer-modell`, Kopie von `b9444bb` (13.11. vormittags), **von Hand deployt, nie gemergt** |
| Raummodell | zwei Speicher (Estrich + Luft) | ein Speicher | zwei Speicher |
| Wärme am Planende | asymmetrisch (mehr Wärme zählt nur wie PV) | – | **0,9 symmetrisch** – Netzwärme im Estrich „fast gratis“ |
| Plan-Prüfung je Raum | ja | nein | nein |
| Untergrenze im Planer | hart | − 1,5 °C Abstand | − 1,5 °C Abstand |
| Feste Regeln als Rahmen | ja (je Viertelstunde) | nein | nein |
| Modus | Planer (Regeln) / KI rechnet mit / **KI steuert** | Aus / Schatten / Steuern (gesperrt) | dto. |
| Gegenrechnung in „Wo stehen wir?“ | ja, mit „bereit für KI steuert“ | nein | nein |

Folge in der Gegenrechnung (live, alte Rechnung): KI 55–61 kWh Netz am Tag, Regel-Steuerung 38–50 kWh
(19.–23.11.2026). Die KI in München rechnete sich schlecht, weil ihr genau der Fix vom 13.11. abends fehlte, nicht weil
München anders ist.

Schon gleich (vorher übernommen): „Wo stehen wir?“ (22.11.), Nachts nur Untergrenze und Haltezeit (24.11.).
Bewusst nicht übernommen: EMHASS und HiGHS (`EMHASS-HIGHS-BEWERTUNG-2026-11-24.md`: „jetzt noch nicht“).

## 2. Was übernommen wurde

### Planer (`supabase/functions/heizplaner-muenchen/`)
- `modell.ts`, `pruefung.ts`, `_shared/heizregeln.ts`: **Kopien** von Venediger `af244ae` (Herkunft im Dateikopf).
  In `pruefung.ts` nur Uhrzeit Berlin und „Normal“ statt „Eco“ im Hinweis.
- `rechnen.ts`: Venediger `af244ae` mit den „MÜNCHEN:“-Stellen des ersten Ports (Phasen, Profil, Kreise, FENECON, Prio 1–4)
  und neu:
  - **Untergrenze hart** (`sicher` = Untergrenze, kein Abstand).
  - **Regel-Rahmen wie der Collector:** Nacht und Abend (ab *Abend ab*) → nur bis Untergrenze; **Wartetag** (Rest-Überschuss
    nach Grundlast und Akku bis voll ≥ *Wartetag ab* `wait_min_kwh`, wie `dayModeOf`) → nur bis Untergrenze; sonst
    Profil-Räume bis Normal. Die Sonne lädt zuerst den Akku bis `pv_min_soc` (wie `surplusW`). Venediger rechnet den
    Sonnentag mit dem Bedarf für Normal – München nimmt bewusst die Regel des eigenen Collectors, damit KI und Regeln
    denselben Rahmen haben.
  - Wärme am Planende asymmetrisch, Gegenrechnung mit Regel-Rahmen, Sonnentag, `netz_ueber_min_h`, „Wärme ausgeglichen“.
- `index.ts`: Plan-Prüfung je Raum mit Sperre (≥ 2 h), Protokoll (`muc_decisions`, Art `planer`, App › Protokoll › KI),
  Hinweise unter KI › Zu entscheiden (`muc_ki_suggestions`, Regel `planer_pruefung`), Tagesprüfung der Gegenrechnung,
  Gegenrechnung älterer Tage neu rechenbar (lädt so viele Tage wie nötig, 22.11.).

### Datenbank (migration-018)
- `muc_raum_messwerte(14)` wie Venediger `raum_messwerte`: aus `muc_room_readings` (5-min-Mittel, „heizt“ = Ventil offen),
  Außentemperatur aus `muc_energy_readings.outdoor_c`, „unter Eco“ = unter dem Tagesziel, „übersteuert“ = Beginn eines
  Übersteuerns in 24 h. Gemessen ~22 s → **Cache stündlich** (`muc-raum-messwerte`, Minute 11; Venediger alle 30 min).
- `muc_settings.planer_pruefung` (Stand der Prüfung), `raum_messwerte_cache`, `planer_sicherheit_abstand = 0`.
- `muc_heizplaner_daten` liefert zusätzlich `messwerte`, `pruefung`, `pv_min_soc`, `wait_min_kwh`, `seq_on_delta`.

### „KI steuert“ im Collector (0.14.0, `src/plan.js`)
In Venediger setzt `pv-automation` den Plan um, in München der Collector – dieselbe Logik (`ladePlanerPlan`,
`planerSollwert`, `planerImRahmen`):
- Nur bei `planer_modus = 'steuern'`; jüngster Plan ≤ 30 min, Slot der aktuellen Viertelstunde. Sonst Regel-Steuerung.
- Je Raum nur mit neuem Raummodell (`m2`) und unauffälliger Prüfung (`pruefung_ok`).
- **Heizen** = Loxone-Sollwert max(Ziel, aufgerundet Ist + 0,5), höchstens PV-Wert; läuft das Ventil schon, bleibt der Sollwert.
  **Nicht heizen** = Sollwert sicher unter dem Ist (bleibt, wenn er schon ≤ Ist − 0,3 steht – kein unnötiger Befehl).
- **Regel-Rahmen:** ohne Sonnenstrom (frei ≥ ½ Kreisleistung) nur bis Grenztemperatur + 0,3 °C (Untergrenze nachts, abends,
  am Wartetag; Normal am Tag ohne genug Sonne). Sonst „Regel: … wartet auf Sonne, Ventil zu“.
- **Netzgrenze** gilt: höchstens `max_grid_circuits` Räume ohne Sonnenstrom (Übersteuerte mit offenem Ventil zählen mit).
- **Sicherheit:** manuell, Raum aus und „früh zu“ bleiben unberührt; unter der Untergrenze heizt der Raum immer;
  ≥ PV-Wert + 0,3 °C → Ventil zu.
- Modus-Wörter: `PLAN` „KI heizt“, `PLAN_ZU` „KI wartet“ (App, Alexa, Alexa+). Log `[KI-STEUERT] …`, Kopfzeile des
  Collector-Status zeigt „KI steuert (Plan von …)“.

### App
- **Steuerung:** Modus-Namen *Planer (Regeln) · KI rechnet mit · KI steuert*, „KI steuert“ wählbar, Texte wie Venediger,
  Regler „Sicherheit unter Untergrenze“ entfernt, beim Umschalten sofort neuer Plan. *Einzelne Räume* zeigt kurz:
  „Plan passt nicht – <Grund> → Regel-Steuerung“ (Ulis Hinweis 24.11.: der Venediger-Text war schwer lesbar).
- **Plan:** Etikett nach Modus, auffällige Räume mit Grund, Gegenrechnung „Wärme ausgeglichen“, Raummodell mit
  Abkühlen k/(1+r) und Aufheizen `auf` (neues Modell).
- **Wo stehen wir?:** Karte „KI gegen tatsächliche Steuerung – darf die KI steuern?“ (Venediger `KiGegenRegeln`, ohne EMHASS/HiGHS):
  bereit, wenn 3 Tage in Folge (mit einem Wartetag) weniger Netz, nicht öfter unter der Untergrenze, an Sonnentagen kein
  Netz über der Untergrenze.

## 3. Nebenwirkungen geprüft (Regel 08.11.2026)

| Stelle | Wirkung |
|---|---|
| Collector bei „KI rechnet mit“ / „Planer (Regeln)“ | **unverändert** – `plan.js` greift nur bei `steuern` |
| Collector ohne migration-018 | `planer_pruefung` fehlt → keine Sperren; Plan wird bei `steuern` trotzdem umgesetzt |
| `heizplaner-muenchen` ohne migration-018 | `messwerte` leer → keine Prüfung (Plan wird gerechnet); `pv_min_soc`/`wait_min_kwh` fehlen → 60 % / kein Wartetag. **Erst SQL, dann Merge.** |
| `muc_heizplan.plan` | neue Felder `regeln`, `raeume[].pruefung_ok`; App liest sie, alte Pläne ohne sie werden angezeigt wie bisher |
| `muc_heizplan_vergleich.planer` | neue Felder (jsonb, keine Schemaänderung); alte Tage: „ohne Regeln“, zählen nicht für „bereit“ |
| Haltezeit / früh zu (0.13) | im Modus `steuern` für Planräume ohne Wirkung (wie in Venediger); „früh zu“-Räume nimmt der Plan nicht |
| Aufheiz-Messung `muc_heat_runs` | `active` enthält bei `steuern` die vom Plan heizenden Räume |
| Wechsel KI ↔ Regeln in einem Raum | Sperre ≥ 2 h (kein Springen alle 15 min); Plan > 30 min alt → alle Räume Regel-Steuerung |
| Edge-Function-Deploy | GitHub-Aktion deployt beim Merge `heizplaner-muenchen`, `alexa-heizung`, `mcp-heizung`. `_shared/` allein löst keinen Deploy aus – bei Änderungen dort die Funktion mit anfassen oder von Hand deployen. **Damit ersetzt der Merge die von Hand deployte Version vom 13.11.** |
| Alexa/Alexa+ | nur neue Wörter für PLAN/PLAN_ZU |

**Verhalten über Zeit:** Plan alle 15 min, Collector jede Minute, Messwerte stündlich. Fällt die Edge Function aus, ist der
Plan nach 30 min zu alt → Regel-Steuerung. Die Wärmepumpe springt auf einen geöffneten Kreis im Median erst nach 14,5 min
an (NACHT-UND-HALTEZEIT §1.2) – kürzer als ein Planblock (30 min); der Plan schaltet je halbe Stunde, also kein Flackern.

## 4. Geprüft (24.11.2026)
- Collector `npm test`: **60 Tests grün**, davon 12 neu (`test/plan.test.js`): Modus, Planalter, Modell/Prüfung,
  Heizen mit/ohne Sonne, Regel-Rahmen Nacht/Wartetag, Untergrenze hart, kein unnötiger Befehl, Netzgrenze, manuell,
  über PV-Wert, Netzgrenze aus dem Tagesmodus, Sonnenstrom unter `pv_min_soc`.
- `deno check` für alle Planer-Dateien. App `npm run build`.
- `muc_raum_messwerte` lesend gegen die echten Daten (14 Tage): plausibel – z. B. DG Bad 8,8 h Heizen am Tag,
  OG Ankleidezimmer 100 % unter Ziel, **EG Wohnzimmer 24 h** (Ventil seit 06.11. dauernd offen → keine Heizzeit-Prüfung,
  zu wenig getrennte Heizblöcke), Laufzeit ~22 s.
- **Offen:** Nachrechnung der Gegenrechnung 17.–23.11. mit dem neuen Stand gegen echte Daten. Braucht eine Prüffunktion
  in Supabase (liest nur) oder den Merge (dann rechnet die Nacht um 03:00 den Vortag neu; ältere Tage per
  `aktion=vergleich tag=…`).

## 5. Einspielen
1. Supabase › SQL-Editor: `supabase/migration-018-planer-wie-venediger.sql` (am Ende wird der Messwerte-Cache einmal gefüllt, ~22 s).
2. PR mergen → GitHub-Aktion deployt `heizplaner-muenchen` (+ Alexa-Funktionen), Vercel die App.
3. Mini-PC München: `cd C:\Users\ulibe\heizung-muenchen` · `git pull` · `C:\nssm\nssm.exe restart HeizungMuenchen` →
   Log „Collector 0.14.0 startet“.
4. Modus bleibt „KI rechnet mit“. „KI steuert“ erst, wenn „Wo stehen wir?“ **bereit** zeigt – schaltest nur du.
5. Älteste Tage neu gegenrechnen (optional): `aktion=vergleich` mit `tag` 17.–23.11.

## 6. Rückweg
- Modus „Planer (Regeln)“ oder „KI rechnet mit“ – sofort wirksam.
- Collector: `git checkout` auf 0.13.0, Dienst neu starten. Edge Function: PR zurücknehmen.
- `select cron.unschedule('muc-raum-messwerte');`
