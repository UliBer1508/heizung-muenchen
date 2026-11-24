# Nachts nur Untergrenze und Haltezeit – München (24.11.2026)

**Uli, 24.11.2026:** „Nachts nur Min und Haltezeit prüfen und einbauen.“
**Vorbild Venediger:** `FIX-NACHT-NUR-MIN-2026-11-17.md` (PR #74) und `FIX-HIN-UND-HER-STUFE-A-2026-11-16.md` (PR #72).
Übernommen nach der Grundregel: Logik und Aussehen gleich, Unterschiede nur dort, wo die Heizart sie verlangt.
Venediger wird nicht geändert.

**Betrifft:** Collector 0.13.0 (`collector/src/logic.js`, `index.js`), `supabase/migration-016-nacht-haltezeit.sql`,
App (Einstellungen › **Nacht und Haltezeit**, Moduswort „Früh zu“), Alexa (Text für „Früh zu“).

> **Grundsatz (Uli, 17.11.2026, gilt für beide Häuser):** Ohne Sonne nur die Untergrenze halten, nie den Estrich laden.
> Den Estrich laden wir tagsüber mit PV-Überschuss.

---

## 1. Befund in München (nur lesend geprüft, Messwerte 14.–24.11.2026)

### 1.1 Nachts: kaum Überschwingen, aber ein Ventil, das nie zugeht

| | Venediger (17.11.) | München (24.11.) |
|---|---|---|
| Wer schaltet ab? | App → Thermostat, 3–9 min Verzug | Loxone-Raumregler, Ventil nach ~1 min |
| Spitze über Min/Untergrenze nachts (Ø) | 0,8–1,2 °C | meist **−0,5 bis +0,2 °C**, Luis Schlafzimmer 0,4 °C |
| Überlauf nach „aus“/„Ventil zu“ | 0,3–0,7 °C | **0,02–0,14 °C** (Fußbodenheizung mit Wärmepumpe, niedriger Vorlauf) |
| Heizstrom nachts (22–9 Uhr) | ≈ 18 kWh | **6–18 kWh** je Nacht, Akku jede Nacht leer |

- Die meisten Räume liegen nachts **auf oder unter** ihrer Untergrenze (OG Eltern Schlafzimmer, DG Schlafzimmer Ø −0,5 °C).
  Ein „früh zu“ bringt dort nichts, es gibt nichts zu kappen.
- **EG Wohnzimmer:** Das Ventil ist **seit 06.11.2026 rund um die Uhr offen** (1440 von 1440 Minuten jeden Tag) –
  auch bei 0,5–1 °C **über** dem Sollwert (nachts ~525 min). Loxone schließt es nicht.
  Folgen: Der Kreis heizt nachts den Estrich (Spitze Ø 1,1 °C über der Untergrenze) und belegt dauerhaft einen der
  6 Kreise der Netzgrenze. **Das ist ein Loxone-/Hardware-Thema** (Raumregler, Fühler oder Stellantrieb), kein Fehler der App.
  Neu: Sofort-Hinweis in der KI (Abschnitt 4).
- Der größere Hebel nachts ist – wie in Venediger – **die Untergrenze selbst**: Bei fünf Räumen ist sie gleich Normal
  (21 = 21 °C). Dafür gibt es schon Regel 1 („Absenk fehlt“) und jetzt Regel 5 (Abschnitt 3).

### 1.2 Hin und Her: die Netzgrenze flackert

Befehle je Tag: 230–480 für 16 Räume. Hin und Her (A → B → A in 15 min) 1–4 %, in 60 min ~10 %.

- Nach einem Anheben kam der nächste Befehl „wartet“ im Median **nach 3 min**, in 25 % der Fälle **nach 1 min**.
  151 von 405 Anhebungen öffneten das Ventil gar nicht, weil der Raum vorher wieder warten musste.
- Ursache (Protokoll): „Netzgrenze 6 Kreise voll – es heizen: OG Eltern Bad, OG Eltern Schlafzimmer“ – nur 2 Räume heizen,
  4 Kreise belegen **fertige Räume, deren Ventil Loxone gerade offen hat** (Nachlauf). Loxone öffnet und schließt diese
  Ventile selbst. Jede Minute, in der eins kurz zu ist, gibt es scheinbar einen freien Kreis – in der nächsten Minute fehlt
  er wieder. Dazu verdrängt ein Raum mit kleinerer Prio-Nummer einen Raum, der eben erst angefangen hat.
- Die Wärmepumpe springt auf einen neu geöffneten Kreis erst nach **Median 14,5 min** an (wenn sie vorher stand,
  217 Messungen, 10 Tage). Ein Kreis, der nach 1–3 min wieder zugeht, bringt also nichts.

## 2. Umsetzung im Collector (0.13.0)

### A) Ohne Sonne früh zu (wie Venediger „Nachts früh abschalten“)

Gilt **nachts, abends und am Wartetag**, solange kein Überschuss da ist (alle drei Modi halten nur die Untergrenze).
Venediger: nur nachts – in München ist der Abend laut Konzept (09.11.2026) gleich der Nacht.

- Je Raum **gemessener Überlauf** (`muc_rooms.ueberlauf_c`): höchste Temperatur nach „Ventil zu“ (bis zum nächsten
  „Ventil auf“, höchstens 2 h) − Temperatur beim Zumachen, letzte 7 Tage zwischen *Abend ab* und *Morgen bis*,
  neuere zählen mehr, mindestens 3 Abschaltungen, 0–1,5 °C. Stündlich neu (`muc_nacht_pruefen`, Minute 7).
- Ein Raum mit **offenem Ventil** wird zugemacht, sobald **Ist + Überlauf ≥ Untergrenze + 0,1 °C**
  (`nacht_spitze_c`, einstellbar). **Nie unter der Untergrenze** (Schwelle = max(Untergrenze, …)).
  Zumachen = Sollwert unter das Ist (Ist − 0,5 °C), Modus **„Früh zu“**.
- Danach **20 min Ruhe**: kein neuer Anstoß, solange der Raum über der Untergrenze bleibt. Fällt er darunter,
  heizt er sofort wieder (Untergrenze hart).
- Ohne Messwerte für einen Raum (< 3 Abschaltungen) → wie bisher. Abschalten: Einstellungen › Nacht und Haltezeit.
- Raumkarte: „Untergrenze 20,0 °C gehalten: 20,1 °C + gemessener Überlauf 0,1 °C erreicht 20,2 °C → Ventil früh zu
  (ohne Sonne nur Untergrenze, Estrich nicht laden)“ bzw. „früh zu um 23:04 – wartet den Überlauf ab …“.

### B) Haltezeit (Stufe A, angepasst an Ventile und Wärmepumpe)

Venediger lernt, wie lange ein **Thermostat** nach dem Befehl braucht (9 min). In München öffnet Loxone das Ventil nach
~1 min – die Trägheit steckt in der **Wärmepumpe**. Deshalb:

- **Gelernte Haltezeit** = Median „Kreis geht auf, während die Wärmepumpe steht → Wärmepumpe läuft“ (Heizstrom > 800 W),
  14 Tage, aufgerundet, 5–30 min, ab 20 Messungen, sonst 15 min. Täglich 03:25 (`muc_haltezeit_lernen`).
  Heute: **15 min**. Eigene Vorgabe in der App (leer = automatisch, 0 = aus).
- **A1 – Kreis halten:** Wer einen Kreis bekommen hat, behält ihn mindestens die Haltezeit. Er steht in seinem Durchgang
  vorn – auch vor einem Raum mit kleinerer Prio-Nummer und vor „wartet lange, ist zuerst dran“.
  **Ausnahmen:** Räume unter der Untergrenze gehen weiter vor (eigener Durchgang zuerst). Die **Netzgrenze gilt immer**.
  Fertig (Ziel erreicht) gibt den Kreis sofort frei. Manuell geht immer vor.
- **A1b – Nachlauf halten:** Ein fertiger Raum, dessen Ventil Loxone gerade kurz zugemacht hat, belegt seinen Kreis noch
  die Haltezeit lang. So entsteht kein „freier Kreis für eine Minute“. Räume mit „Früh zu“ sind davon ausgenommen
  (ihr Ventil soll zu bleiben).
- **A2 – PV-Zusage halten:** in München schon vorhanden (Überschuss-Stufe wechselt frühestens nach *Mindestdauer je
  Änderung*, 30 min, `holdPvLevel`). Nichts Neues.
- **A3 – Wartende nicht nachführen:** Steht der Loxone-Sollwert eines wartenden Raums schon sicher unter dem Ist
  (≤ Ist − 0,3 °C, höchstens 2 °C darunter), bleibt er stehen. Bisher kam jedes Mal ein neuer Befehl, wenn das Ist um
  0,5 °C weiterwanderte (Muster „wartet → wartet → wartet“). Gilt auch für „Früh zu“.
- Wartende Räume sehen in der Begründung, wer den Kreis hält: „… · Haltezeit: DG Bad bis 23:15“.

## 3. KI (migration-016)

### Nacht-Prüfung (stündlich, `muc_nacht_pruefen`)
- Je Raum und Nacht zusätzlich in `muc_room_nights`: höchste Temperatur, **Spitze über der Untergrenze**, Minuten
  Ventil offen obwohl ≥ 0,3 °C über Soll, Anzahl „Ventil auf“.
- Je Nacht in `muc_nacht_haus`: Heizstrom (Verbrauch − Auto − Grundlast), davon aus dem Netz, **Heizgradtage**
  (Σ max(0; 18 − außen) je Minute ÷ 1440), **kWh je Heizgradtag**, Räume nachgeheizt, Ø Spitze, Befehle „früh zu“.
- Beim Einspielen werden die letzten 14 Nächte nachgerechnet (Vergleichsbasis).

### Regel 5 (neu, wie Venediger): „Untergrenze 0,5 °C tiefer?“
- Hat ein Raum in **≥ 3 der letzten Nächte > 30 min** nachgeheizt und lag er **morgens trotzdem auf der Untergrenze**
  (Ende ≤ Untergrenze + 0,3 °C) → Vorschlag **Untergrenze − 0,5 °C**, nicht unter Normal − 2. Mit Zahlen: Minuten je Nacht,
  Spitze, Abkühlen je Nacht → „grob X h länger ohne Nachheizen“. **Uli genehmigt** (Ja / Anderer Wert / Nein).
- Läuft nach Regel 1 („Absenk fehlt“) und vor den PV-Regeln; ein Raum mit Vorschlag 5 bekommt am selben Tag keinen
  weiteren. Höchstens 3 Vorschläge am Tag (bestehende Regel). Wirkungsbericht nach 3 Tagen wie bei den anderen Vorschlägen.

### Erfolgskontrolle „früh zu“
- Täglich im Rückblick: Nächte seit `nacht_frueh_aus_seit` gegen die 8 Nächte davor – Ø Spitze über der Untergrenze und
  kWh je Heizgradtag. Bis 3 Nächte „gemessen, Urteil nach 3 Nächten“, danach **wirkt** (Spitze ≥ 0,15 °C tiefer, kWh je
  Heizgradtag nicht ≥ 5 % höher) / **keine klare Wirkung** / **schlechter** (kWh je Heizgradtag > 10 % höher, mit Hinweis
  auf den Schalter). Einmal pro Woche als Eintrag „Zur Info“.
- Rückblick bekommt eine Nachtzeile, z. B. „Nacht: Wärmepumpe ca. 9,5 kWh (8,7 aus dem Netz), 6 Räume nachgeheizt,
  Spitze über der Untergrenze Ø 0,1 °C, 14× früh zu.“

## 4. Sofort-Hinweis „Ventil bleibt offen, obwohl der Raum warm ist“
Alle 15 min (`muc_ki_hints_ventil`, aus `muc_ki_tick`): In den letzten 2 h ≥ 90 % der Messungen Ventil offen und im
Schnitt ≥ 0,5 °C über dem Sollwert → rote Leiste mit den Räumen. Erledigt sich selbst. Heute zutreffend: **EG Wohnzimmer**.

## 5. Ehrliche Einordnung

- **„Früh zu“ spart in München wenig**, weil die Räume nachts kaum über die Untergrenze laufen (Überlauf 0,02–0,14 °C).
  Es sorgt vor allem dafür, dass Loxone ein offenes Ventil nicht bis Untergrenze + 0,5 °C laufen lässt, und es gilt
  dieselbe Regel wie in Venediger. Gemessen wird es mit der Erfolgskontrolle.
- **Haltezeit** wirkt auf das Flackern an der Netzgrenze (viele Befehle, Kreise für 1–3 min). Erwartung: deutlich weniger
  Befehle und Hin und Her; Ziel wie Venediger unter 2 %. Nebenwirkung: Ein Raum mit kleinerer Prio-Nummer wartet bis zu
  15 min; ein gerade geschlossenes Ventil hält seinen Kreis bis zu 15 min. Messen: Einstellungen › Nacht und Haltezeit.
- **Die größten Hebel nachts** sind (1) das Ventil EG Wohnzimmer, (2) Untergrenzen gleich Normal (Regel 1 und 5),
  (3) später die Wärmepumpe im LAN (echter Heizstrom, Vorlauf, eigenes Zeitprogramm).

## 6. Nebenwirkungen geprüft

| Stelle | Wirkung |
|---|---|
| Untergrenze-Durchgang (Räume darunter) | unverändert zuerst; Räume mit „Früh zu“ sind nie darunter |
| Modell a (Überschuss) | „früh zu“ nur ohne Überschuss (level 0); Haltezeit-Reihenfolge gilt auch hier |
| Modell b (Netzgrenze) | Grenze unverändert hart; Haltezeit ändert nur die Reihenfolge, Nachlauf zählt länger |
| Wartezeit-Vorrang (60 min) | gilt weiter, aber nicht gegen einen gehaltenen Kreis |
| Manuell (Override) | unverändert, geht vor |
| Aufheiz-Messung `muc_heat_runs` | kürzere Läufe < 30 min werden wie bisher verworfen; weniger kurze Läufe durch die Haltezeit |
| Planer (Schattenbetrieb) | liest Messwerte, unverändert |
| KI-Raummodell (`muc_room_night_calc`) | unverändert; neue Spalten kommen in einer eigenen Funktion dazu |
| Alexa | neues Wort „Untergrenze erreicht, Ventil früh zu“ |
| Collector ohne migration-016 | läuft wie 0.12 (keine Überlauf-Werte → kein „früh zu“), Haltezeit 15 min |

## 7. Geprüft (24.11.2026)
- Collector: `npm test` – 48 Tests grün, davon 8 neu (`test/nacht-halte.test.js`): früh zu, nie unter der Untergrenze,
  Schutzzeit, ohne Messwerte/mit Überschuss/Schalter aus wie bisher, Haltezeit hält den Kreis, Nachlauf halten,
  Wartende nicht nachführen, Vorgabe vor gelerntem Wert.
- migration-016 in einer leeren Postgres-16-Datenbank nach allen Migrationen davor, zweimal hintereinander, mit
  10 Tagen erfundener Messwerte: Überlauf, Haltezeit, Nächte, Hin und Her, Regel 5, Nachtzeile, Erfolgskontrolle.
- Überlauf- und Haltezeit-Abfrage lesend gegen die echten Daten: Überlauf 0,02–0,14 °C je Raum (4–28 Abschaltungen),
  Wärmepumpe springt nach Median 14,5 min an.
- App gebaut (`npm run build`).

## 8. Einspielen
1. Supabase: `supabase/migration-016-nacht-haltezeit.sql` – **am 24.11.2026 ausgeführt** (Claude per Connector). Gelernte Haltezeit 16 min (187 Messungen).
2. Mini-PC München:
   ```powershell
   cd C:\Users\ulibe\heizung-muenchen
   git pull
   C:\nssm\nssm.exe restart HeizungMuenchen
   ```
   Im Log: „Collector 0.13.0 startet“, nachts Zeilen `[FRUEH-ZU] …`.
3. App (Vercel baut automatisch): Einstellungen › **Nacht und Haltezeit**.
4. Alexa: deployt die GitHub-Aktion beim Merge.

## 9. Rückweg
- Einstellungen › Nacht und Haltezeit › „Ohne Sonne früh zu“ aus; Haltezeit 0 = aus.
- `select cron.unschedule('muc-nacht-pruefen'); select cron.unschedule('muc-haltezeit-lernen');`
- Collector: `git checkout` auf 0.12.0 und Dienst neu starten.
