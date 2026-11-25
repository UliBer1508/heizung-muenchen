# FIX: Heizsignal und Rückblick für das Raummodell München (25.11.2026)

## Anlass

Uli: „In München haben wir die WP und Wasserleitungen im Boden (Fußbodenheizung), in Venediger Heizmatten im Estrich.
Das sollte einen Unterschied bei der Aufheizung und Wärmehaltung ausmachen. In München wird viel mehr Masse geheizt.“

Das Raummodell (`heizplaner-muenchen/modell.ts`) ist eine unveränderte Kopie aus Venediger. Lernlauf vom 25.11.2026:
fast alle Münchner Räume hängen an den Parametergrenzen – g = 0,05 (Aufheizen, unten), u = 2 (Austausch, oben),
r = 0,5 (Estrich-Speicher, unten). Das Modell hat also gelernt, dass Heizen fast nichts bewirkt und der Estrich nichts
speichert; die Vorhersage war kaum besser als „bleibt gleich“. Venediger: r 4–20, deutlich besser als „gleich“.

## Ursache

1. **Heizsignal.** „Heizt“ war in München nur „Ventil offen“. Wärme fließt aber nur, wenn die Wärmepumpe läuft
   (eigenes Zeitprogramm, Warmwasser, Ausfälle). 7 Tage bis 25.11.: in 30–40 % der Ventil-offen-Zeit lieferte die WP
   keine Wärme. In Venediger heißt „heizt“: Heizmatte bekommt Strom – da kommt die Wärme sofort.
2. **Masse.** Rohre unten im Estrich, Wasser muss erst warm werden, viel mehr Masse → reagiert später, hält länger.
   Der Estrich-Zustand wurde nur aus 12 h Vorgeschichte nachgerechnet.

## Umsetzung

- **migration-020** (in Supabase am 25.11.2026 durch Claude eingespielt): in `muc_heizplaner_daten` › `samples15`
  gilt `h = Ventil offen UND Heizstrom > 800 W` (Heizstrom = Verbrauch − Auto − Grundlast, dieselbe Schätzung wie der
  KI-Hinweis „Wärmepumpe liefert keine Wärme“). Minuten ohne Energiewert zählen wie bisher nach dem Ventil.
  Die Werte reichen 24 h vor den Lernzeitraum. Beispiel EG Büro, 30 Tage: 358 → 158 Heizstunden.
- **heizplaner-muenchen** (`rechnen.ts`, `HIST_SLOTS = 96`): Estrich-Zustand aus 24 h statt 12 h Vorgeschichte, beim
  Lernen und beim Planen.
- `modell.ts` (Rechenkern) bleibt die Kopie aus Venediger. Venediger ändert sich nicht.
- Steuerung: keine Änderung – der Planer läuft in München im Schattenbetrieb.

## Wirkung prüfen

Ab der Nacht nach dem Merge: Auto-Steuerung › Wo stehen wir? › **„Lernt das Modell dazu?“** – Abweichung 12 h je Raum
gegen „bleibt gleich“. Und: `select raum, param, fehler_12h, gleich_12h from muc_heizmodell;` – die Parameter sollten
von den Grenzen weggehen.

Sobald die Wärmepumpe am LAN hängt: echte Betriebs- und Vorlaufwerte statt der Schätzung über den Hausverbrauch.
