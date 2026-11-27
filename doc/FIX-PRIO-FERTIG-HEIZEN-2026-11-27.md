# FIX: Nach Prio heizen, fertig heizen, offene Ventile zählen (27.11.2026, Collector 0.16)

## Anlass

Uli, 27.11.2026, 12:15 (Screenshot „Räume“): „Warum sind hier wieder so viele Ventile offen? Es sollte der Prio nach
geheizt werden, aber nicht alle offen.“ Danach, 12:20: „Wir machen der Prio nach die Ventile auf und heizen diese Räume.
Sobald sie die Temperatur erreicht haben, schließen wir die Ventile und halten sie geschlossen, solange die Temperatur nicht
unter den entsprechenden Wert fällt. Dann heizen wir andere Räume usw. Wir kontrollieren die Ventile, es sollte kein Hin und
Her geben.“

## Befund (Live-Daten 12:16, −1 °C, keine PV, Akku 0 %)

| | |
|---|---|
| Netzgrenze | 6 Kreise, die Automatik hat 6 zugeteilt |
| tatsächlich offen | 8 – DG Bad, OG Büro, EG Küche standen auf „Wartet“ (Soll unter Ist), Ventil noch offen |
| Wechsel | Liste der heizenden Räume änderte sich ab 11:49 alle 5 min (DG Bad → KG Hobbyraum, DG Schlafzimmer → DG Wohnen → OG Ankleide, EG Büro → EG Eingang) |
| OG Eltern Schlafzimmer | Soll 22 °C, Ist 20 °C, Ventil 6 h lang 0 % offen – **Loxone folgt nicht** (Raumregler/Stellantrieb prüfen) |

Ursachen im Code (`allocateRooms`):
1. Fast alle Räume lagen unter Min (21 °C). Im Durchgang „unter Untergrenze“ ging **„wer seit 60 min wartet“ vor der Prio**.
   Damit wurde reihum gewechselt, sobald die Haltezeit (12 min) abgelaufen war.
2. Ein noch offenes Ventil zählte nur als belegt, wenn der Raum sein Ziel erreicht hatte. Ein Raum, der gerade auf
   „Wartet“ gesetzt wurde, dessen Stellantrieb aber noch zuging, zählte nicht → bei jedem Wechsel mehr als 6 Ventile offen.

## Neue Regel (0.16)

1. **Wer heizt, heizt fertig.** Ein Raum mit Kreis behält ihn, bis er sein Ziel erreicht hat (Ziel − `seq_on_delta` 0,3 °C).
   Kein Zeitlimit, keine Haltezeit mehr dafür.
2. **Dann bleibt das Ventil zu**, bis der Raum unter Ziel − `seq_off_delta` (0,8 °C) fällt (Schaltband, wie bisher).
3. **Freie Kreise streng nach Prio.** Die Wartezeit (`wait_boost_min`) zählt nur noch innerhalb derselben Prio.
4. **Min geht vor:** Räume unter Min bekommen freie Kreise vor Räumen, die schon über Min Richtung Normal heizen
   (Durchgang 1, unverändert). Ein solcher Raum verliert dabei seinen Kreis – das passiert erst, wenn ein anderer Raum
   unter Min fällt, also in Stunden, nicht in Minuten.
5. **Jedes offene Ventil zählt.** Ein Ventil, das offen ist (oder vor weniger als `halte_min` offen war), ohne dass die
   Automatik den Raum heizen lässt, belegt einen Kreis. Es sperrt nur **neue** Räume; Räume, die schon heizen, verdrängt
   es nicht (sonst wieder Wechsel). In der Begründung der wartenden Räume steht „Ventil noch offen: …“.

Ergebnis: höchstens `max_grid_circuits` Ventile offen, plus kurz die, die Loxone gerade zumacht bzw. die nicht folgen.

## Unterschied zu Venediger

Venediger sortiert Räume unter Min nach dem Abstand zu Min (laufende +0,3 °C), dann Prio (`FIX-MIN-VORRANG-2026-11-14.md`),
und zählt Watt statt Kreise. München: laufende Räume zuerst, dann Prio – auf Ulis Wunsch „der Prio nach“.
Die Wartezeit-Regel ist in beiden Systemen nicht mehr vorrangig vor der Prio.

## Geändert

- `collector/src/logic.js` – `allocateRooms`: Reihenfolge, Nachlauf, Platzprüfung `hasRoom`, Begründungstexte.
- Tests: `logic.test.js`, `nacht-halte.test.js` (u. a. Nachrechnung der Lage 27.11.2026 12:16). 64 Tests grün.
- Oberfläche: Hilfetexte in Einstellungen › Prioritäten und › Nacht und Haltezeit.
- Keine Datenbank-Änderung.

## Einspielen

1. PR mergen → Vercel deployt die Oberfläche.
2. Mini-PC München: `git pull` → `nssm restart HeizungMuenchen`.

## Prüfen

- „Heizung jetzt“: offene Kreise ≤ 6, die Liste der heizenden Räume bleibt stehen, bis ein Raum fertig ist.
- `select ts, reason from muc_decisions where kind='sequence' order by ts desc limit 20;` – kein Wechsel der Räume
  von Lauf zu Lauf.
