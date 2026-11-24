# EMHASS und HiGHS für München – lohnt sich der Einbau? (24.11.2026)

**Uli, 24.11.2026:** „Dennoch möchte ich EMHASS und HiGHS prüfen, ob es Sinn macht, sie in München einzubauen.“
**Vorbild Venediger:** `EMHASS-VERGLEICH-2026-11-22.md` (PR #78–80) und `FIX-PLANER-HIGHS-2026-11-22.md` (PR #81).
Nur Prüfung – an Code und Daten ist dafür nichts geändert.

## Ergebnis in einem Satz

**Jetzt noch nicht.** In München gibt es im Winter fast nichts zu verschieben, die Wärmepumpe ist noch nicht messbar
und nicht steuerbar, und in Venediger zeigen beide Verfahren bisher keinen Vorteil gegenüber unserem Planer. Wieder prüfen,
wenn die Wärmepumpe im LAN ist **und** Venediger ein Ergebnis mit Sonnentagen hat (Abschnitt 5).

## 1. Was EMHASS und HiGHS tun

- **EMHASS** (github.com/davidusb-geek/emhass, MIT): plant Verbraucher, PV und Batterie als lineare Optimierung für den
  Tag voraus. In Venediger läuft es seit 22.11. **nebenher** auf dem Österreich-PC (täglich 03:45), bekommt dieselben
  Daten wie unsere Gegenrechnung und wird mit unserem Raummodell bewertet.
- **HiGHS** ist der Löser. In Venediger rechnet er seit 22.11. **dieselbe Aufgabe wie unser Planer** vollständig
  (statt „gierig“ Schritt für Schritt), um zu prüfen, ob die Suche des Planers die Schwäche ist. Gelöst wird auf dem PC
  (39–112 s), Supabase ist dafür zu langsam.

## 2. Was Venediger bisher zeigt (Gegenrechnung, Netz in kWh, bereinigt um die Wärme am Tagesende)

| Tag | Steuerung (gemessen) | Planer (gierig) | Planer mit HiGHS | EMHASS |
|---|---|---|---|---|
| 15.11. | 13,1 | 11,6 | 9,3 | 0,2 ¹ |
| 16.11. (Sonne) | 31,8 | 39,4 | 39,5 | 30,5 |
| 17.11. | 38,0 | 37,4 | 37,2 | 37,4 |
| 18.11. | 34,4 | 33,5 | 33,3 | keine Lösung |
| 19.11. | 49,2 | 49,2 | 49,2 | – |
| 20.11. | 32,8 | 32,3 | 32,3 | 32,5 |
| 21.11. | 24,6 | 24,5 | 24,6 | 24,5 |
| 22.11. | 38,7 | 38,5 | 38,6 | 38,5 |
| 23.11. | 46,8 | 46,0 | 46,0 | 46,1 |

¹ unplausibel, in Venediger als offen vermerkt. Steuerung = gemessener Netzbezug (nicht bereinigt).

- **HiGHS = gierig** an jedem Tag (± 0,2 kWh). Die Suche ist nicht die Schwäche – Venediger hat das genau damit prüfen wollen.
- **An trüben Tagen sind alle gleich.** Bei festem Tarif ohne Sonne gibt es nichts zu verschieben; Netz sparen geht dann nur
  über weniger Wärme (Untergrenze, Normal), nicht über eine bessere Planung.
- **Nur am Sonnentag 16.11. ist EMHASS besser** als unser Planer (30,5 statt 39,4) – aber nicht besser als die heutige
  Steuerung (31,8). Ein einziger Sonnentag; Venediger wertet nach ~2 Wochen mit Sonnentagen aus.

## 3. Warum es in München heute nichts bringen würde

| Voraussetzung | Venediger | München heute |
|---|---|---|
| Was die Steuerung stellen kann | Leistung je Raum (Heizkörper, gemessen) | nur **Ventile auf/zu**; die Wärmepumpe entscheidet selbst, ob sie läuft (in 172 von 279 Stunden lief sie nicht, obwohl Ventile offen waren) |
| Heizstrom | je Raum gemessen | **geschätzt** (Verbrauch − Auto − Grundlast, enthält Warmwasser) |
| Wirkungsgrad | 1 kWh Strom = 1 kWh Wärme | hängt von Vorlauf und Außentemperatur ab – ohne Messung kein brauchbares COP-Modell |
| Raummodell (Abweichung) | Ø 0,34 °C | Ø 0,33 °C – vergleichbar, aber auf geschätztem Heizstrom |
| Etwas zu verschieben (10.–23.11.) | – | **PV 157 kWh in 14 Tagen, davon nur ~25 kWh eingespeist** (20 kWh am 14.11.); Akku jede Nacht leer |
| Strompreis | fest | fest; in `muc_prices` noch kein Preis eingetragen |
| Unser Planer gegen die Regeln | gleichauf | **gleichauf** (z. B. 23.11.: 38,4 = 38,4 kWh, 21.11.: 42,8 zu 42,1) |
| Rechner für den Löser | Österreich-PC mit EMHASS | Mini-PC München (Python ließe sich installieren) |

Daraus folgt: Ein Optimierer kann in München nur so gut sein wie das Modell der Wärmepumpe – und das fehlt, solange sie
nicht im LAN ist. Er hätte im November fast keinen Überschuss zu verteilen und keinen Preis, nach dem er Zeiten wählen
könnte. Das Ergebnis wäre dieselbe Zahl wie heute, mit einem weiteren Dienst, der täglich laufen und überwacht werden muss
(Uli: „Ich kann nicht jeden Tag am PC etwas prüfen.“).

## 4. Was es kosten würde (wenn später ja)

- **HiGHS-Prüfstein:** Planer-Stand von Venediger übernehmen (Gegenrechnung „alle Spalten mit demselben Raummodell“,
  `highs.ts`, Aktionen `highs_eingabe`/`highs_bewerten`), Spalte `muc_heizplan_vergleich.planer_highs`,
  Python + highspy auf dem Mini-PC München, geplante Aufgabe, Überwachung im Systemstatus. Mittlerer Aufwand.
- **EMHASS:** zusätzlich Brücke und Grundkonfiguration – für eine Wärmepumpe mit COP-Modell (Vorlauf, Außentemperatur);
  das geht erst mit Messwerten der Wärmepumpe. Größerer Aufwand.

## 5. Wann wieder prüfen (Wiedervorlage)

Einbauen lohnt sich, wenn **alle drei** Punkte erfüllt sind:
1. **Wärmepumpe im LAN** (Modbus): echte elektrische Leistung, Vorlauf, Betriebsart – und eine Stellgröße
   (Leistung oder SG-Ready über FENECON).
2. **Venediger hat ein Ergebnis mit Sonnentagen** (Auswertung „nach ~2 Wochen“ laut EMHASS-Doku): Liegt EMHASS oder
   HiGHS dort deutlich unter Planer **und** Regeln, ist der Weg für München klar.
3. **Es gibt etwas zu verschieben**: Übergangszeit/Frühjahr mit Überschuss, oder ein dynamischer Tarif.

Bis dahin sinnvoll und billig: die **Gegenrechnung in München auf den Venediger-Stand vom 22.11. bringen**
(ältere Tage neu rechenbar, alle Spalten mit demselben Raummodell). Dann steht der Vergleich bereit, sobald ein
HiGHS- oder EMHASS-Wert dazukommt. Eigener PR, wenn gewünscht.
