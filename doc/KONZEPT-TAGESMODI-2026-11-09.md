# Konzept: Heizen mit und ohne PV-Überschuss – München

**Stand:** 9. November 2026 · **Status:** ENTWURF – zur Freigabe durch Uli
**Betrifft:** Collector (`collector/src/logic.js`), `muc_settings`, `muc_rooms`, App (Einstellungen, Übersicht)
**Vorbild:** Venediger `doc/KONZEPT-TAGESABLAUF-HEIZUNG-2026-10-27.md` (freigegeben 27.10.2026),
`FIX-ABEND-WIE-NACHT-2026-11-06.md`, `FIX-HEIZLEISTUNG-2026-11-06.md`, `SYSTEM_DOCUMENTATION.md` §4

> Regel aus Venediger, gilt auch hier: *Konzept ist die Wahrheit – der Code wird daran angepasst.*
> Begriffe sind dieselben wie in Venediger. Abweichungen nur dort, wo die Wärmepumpe sie verlangt (Abschnitt 7).

---

## 1. Anlass (09.11.2026)

- Die Heiz-Reihenfolge (Collector 0.7–0.10, `INBETRIEBNAHME.md` §11) galt **immer gleich**, mit und ohne PV.
  „Gleichzeitig heizen“ stand auf **1 Raum**: Von den vier Prio-1-Räumen heizte nur einer, alle anderen
  Räume warteten den ganzen Tag. Behelfsmäßig am 09.11. 11:00 auf „alle Räume der Prio“ gestellt.
- Absenk (Normal − 1 = 21 °C) lag **über** der Raumtemperatur (18–19 °C). Dadurch blieben die Ventile nachts offen,
  die Wärmepumpe lief vom 08.11. 16 Uhr bis 09.11. mittags durch: ca. 25 kWh Heizstrom zwischen 22 und 9 Uhr,
  der Akku war um 19 Uhr leer.
- Ursache: Beim Übernehmen der Prioritäten aus Venediger wurden die **Tagesmodi** nicht mit übernommen.
  Die München-Doku kannte nur das Heizen mit PV-Stufen.

## 2. Grundsätze

1. **Zwei Modelle:**
   **a) mit PV-Überschuss** – der Überschuss wird nach Priorität auf die Räume verteilt. Je nach Überschuss
   heizen ein oder mehrere Räume, sonst einer nach dem anderen in der Reihenfolge der Priorität.
   **b) ohne PV-Überschuss** – Strom aus dem Netz. Entscheidend ist nur, **mit wie viel Leistung** aus dem Netz
   geheizt wird (Netzgrenze), nicht die Reihenfolge der Räume.
2. **Sonne zuerst in die Batterie.** Überschuss zählt erst ab Akku ≥ `pv_min_soc` (60 %) – wie bisher.
3. **Ist Überschuss absehbar, wird gewartet (Wartetag).** Zeigt die FEMS-Prognose, dass heute noch genug
   Überschuss kommt, wird morgens nicht aus dem Netz geheizt. Die Räume halten nur ihre **Untergrenze**.
4. **Abend wie Nacht.** Nach Sonnenuntergang wird nicht mehr auf Normal geheizt. Der Akku ist für den
   Haushaltsstrom in der Nacht da, nicht für die Heizung (Uli, Nov 2026).
5. **Nachts wird nicht geheizt.** Der Estrich gibt die Wärme vom Tag ab. Geheizt wird nur ein Raum, der unter
   seine **Untergrenze** fällt.
6. **Kein Sollwert über der Raumtemperatur, wenn der Raum nicht heizen soll.** Ein Raum, der warten oder
   absenken soll, darf nie ein Ziel bekommen, das sein Ventil öffnet.
7. **KI und Muster** entscheiden nur innerhalb dieser Regeln mit (wie Venediger §3.6).
8. **Alle Werte sind in der App einstellbar.**

## 3. Tagesmodi

| Modus | Wann | Was passiert |
|---|---|---|
| **Nacht** | *Nacht ab* (22:00) bis *Morgen ab* (09:00) | Ziel je Raum = **Untergrenze**. Nur Räume darunter heizen, nach Priorität, unter der Netzgrenze. |
| **Morgenbewertung** | ab *Morgen ab*, bei jedem Lauf neu | Reicht der heute noch erwartete PV-Überschuss (FEMS-Prognose, `muc_forecast`) für den Bedarf? → **Wartetag**, sonst **Schlechter Tag** |
| **Wartetag** | bis Überschuss da ist | Räume halten ihre Untergrenze. Nur Räume darunter heizen (nach Priorität, Netzgrenze). |
| **Schlechter Tag** = Modell b | ganzer Tag, solange kein Überschuss | Räume mit Profil *morgens/tagsüber* in dieser Phase auf **Normal**, nach Priorität, begrenzt durch die **Netzgrenze**. |
| **Überschuss** = Modell a | Überschuss ≥ *Stufe 1 ein* (1,5 kW) | Überschuss nach Priorität verteilen: Räume auf **PV-Wert**, bei vollem Akku auf **Voll**. So viele Räume, wie der Überschuss trägt. |
| **Abend** | Sonnenuntergang bis *Nacht ab* | wie Nacht: Ziel = Untergrenze. Ausnahme nur bei echtem Überschuss (Modell a). |

Wechsel Wartetag ↔ Schlechter Tag bei jedem Lauf neu: Bricht die Prognose ein, wird aus dem Wartetag ein Schlechter Tag.

## 4. Modell a – mit PV-Überschuss

- **Budget** = Überschuss (Einspeisung + Batterieladung ab 60 %) + Leistung, die die Heizung gerade schon zieht
  (wie Venediger: heizende Räume verdrängen keine neuen).
- **Reihenfolge:** Prio 1 zuerst, alle Räume einer Prio gemeinsam. Die nächste Prio kommt dazu, **sobald das Budget
  reicht** – nicht erst, wenn die vorige Prio fertig ist. Reicht das Budget nur knapp, heizt eine Prio nach der anderen.
- **Wie viele Kreise trägt der Überschuss?** In Venediger zählt die Summe der Heizkörper-Leistungen. In München gibt
  es nur die Wärmepumpe. Bis sie im LAN ist, gilt die gemessene Tabelle aus Abschnitt 8.1
  (offene Kreise → Leistung der Wärmepumpe), danach die echte Leistung der Wärmepumpe.
- Erreicht ein Raum seinen PV-Wert, fällt er auf Normal zurück und hält; der nächste Raum bekommt den Platz.
- Bleibt der Überschuss unter *Stufe zurück* (300 W) länger als die Haltezeit (30 min), endet Modell a.

## 5. Modell b – ohne PV-Überschuss (Netz)

- Räume, die nach Profil in dieser Phase heizen sollen, bekommen **Normal**, in der Reihenfolge der Priorität.
- **Netzgrenze** (neu, wie Venediger `max_grid_heating_power_w`): höchstens so viel Leistung, wie eingestellt.
  Die Wärmepumpe kann noch nicht direkt begrenzt werden. Bis zum LAN-Anschluss wird die Grenze über die
  **Anzahl gleichzeitig offener Kreise** eingehalten (Tabelle Abschnitt 8.1).
  Weitere Räume warten, bis ein Raum Normal erreicht hat. **Wartende Räume bekommen „Ist − 0,3 °C“**
  (Ventil zu), nie einen Wert darüber.
- **Untergrenze geht vor, Grenze gilt immer** (wie Venediger seit 06.11.2026): Räume unter der Untergrenze werden
  zuerst geheizt, aber auch sie nur innerhalb der Netzgrenze. Passt nichts, darf ein Raum allein heizen – nur bis zur Untergrenze.
- **Optimale Leistung:** siehe 8.2. Bis echte Messwerte der Wärmepumpe vorliegen, ist die Netzgrenze ein Startwert,
  den Uli einstellt und die KI später vorschlägt.

## 6. Neue und geänderte Einstellwerte

| Wert | Tabelle | Anzeige in der App | Startwert | Bedeutung |
|---|---|---|---|---|
| **`floor_temp`** (neu) | muc_rooms | Einstellungen › Räume › „Untergrenze“ | **offen, siehe 9.1** | So weit darf der Raum ohne Sonne fallen. Ziel nachts, abends und am Wartetag. |
| **`max_grid_kw`** bzw. **`max_grid_circuits`** (neu) | muc_settings | Einstellungen › Haus › „Max. Heizleistung ohne PV“ | 6 Kreise ≈ 2 kW (8.1) | Netzgrenze Modell b, nachts und am Wartetag |
| **`wait_threshold`** (neu) | muc_settings | Einstellungen › Haus › „Wartetag ab“ | 1,0 | Verhältnis erwarteter Überschuss / Bedarf, ab dem gewartet wird |
| `temp_night` (Absenk) | muc_rooms | bleibt | – | wird nicht mehr als Nachtziel verwendet (ersetzt durch Untergrenze), siehe 9.2 |
| `reserve_soc` („Abends heizen nur ab Akku“) | muc_settings | entfällt | – | Abend wie Nacht |
| `seq_max_rooms`, `seq_max_minutes` | muc_settings | entfällt | – | ersetzt durch Budget (a) und Netzgrenze (b) |
| `pv_prio` und `priority` | muc_rooms | **eine** Priorität | – | siehe 9.3 |

## 7. Unterschiede zu Venediger (durch die Heizart bedingt)

| | Venediger | München |
|---|---|---|
| Wärmeerzeuger | ein Elektroheizkörper je Raum, Leistung bekannt | eine Wärmepumpe für alle Fußbodenkreise |
| Netzgrenze | Summe der Raumleistungen (W) | Anzahl offener Kreise, nach LAN-Anschluss echte WP-Leistung |
| Wer schaltet die Wärmeerzeugung? | das Thermostat jedes Raums | die Wärmepumpe selbst (eigenes Programm, Heizkurve); wir öffnen und schließen nur Ventile |
| Wirkungsgrad | immer gleich (1 kWh Strom = 1 kWh Wärme) | hängt von Vorlauf- und Außentemperatur ab → es gibt eine **optimale** Leistung (8.2) |
| Trägheit | Estrich, Raum heizt in 1–3 h | Estrich, Raum heizt 0,1–0,3 °C pro Stunde |

## 8. Auswertung der Messwerte (27.10.–09.11.2026, 279 Stunden mit allen Räumen)

Heizstrom geschätzt als Verbrauch − E-Auto − Grundlast 350 W (enthält auch Warmwasser).

### 8.1 Leistung der Wärmepumpe nach offenen Kreisen (nur Stunden mit Wärmepumpe an, > 800 W)

| Offene Kreise | Stunden | Ø Heizstrom |
|---|---|---|
| 0–1 | 12 | 1,2 kW |
| 2–3 | 10 | 1,6 kW |
| 4–5 | 15 | 1,9 kW |
| 6–8 | 12 | 2,2 kW |
| 9–11 | 29 | 2,3 kW |
| 12–14 | 10 | 2,6 kW |

Mit mehr offenen Kreisen zieht die Wärmepumpe mehr Strom, aber nicht proportional (2 Kreise → 1,6 kW, 12 Kreise → 2,6 kW).
**Das ist der einzige Hebel, den wir heute auf die Netzleistung haben.**

### 8.2 Gibt es eine optimale kW-Stufe?

- **Physikalisch ja:** Eine Wärmepumpe arbeitet am effizientesten mit **niedriger Vorlauftemperatur**, also mit vielen
  offenen Kreisen und kleiner Leistung über lange Zeit, und bei **höherer Außentemperatur** (mittags statt nachts).
  Wenige offene Kreise bei hoher Leistung (wie in der Nacht 08./09.11.) ist der ungünstigste Fall.
- **Aus unseren Daten heute nicht belastbar bestimmbar.** Die Wirkung je kWh (Temperaturgewinn aller Räume abzüglich
  Wärmeverlust) streut stark (Modell erklärt nur 37 %). Je Leistungsband in 6-Stunden-Blöcken:
  1,6–2,0 kW ≈ 75 m°C/kWh (8 Blöcke), 2,0–2,4 kW ≈ 42 (25 Blöcke), 2,4–2,8 kW ≈ 48 (18 Blöcke).
  Ein Hinweis, dass ~1,6–2 kW günstiger ist – aber zu wenige Messungen, und der Heizstrom ist nur geschätzt.
- **Die Wärmepumpe entscheidet selbst, ob sie läuft.** In 172 von 279 Stunden lief sie nicht, obwohl im Schnitt
  9 Ventile offen waren. An 5 Tagen (30.10.–03.11., 07.11.) lief sie gar nicht, an anderen 17 Stunden.
  Laufanteil je Uhrzeit 18–46 %, am höchsten 06–07 und 10 Uhr.
- **Folgerung:** Startwert für die Netzgrenze **6 Kreise ≈ 2 kW**. Die genaue Stufe lernt das System, sobald die
  Wärmepumpe im LAN ist (elektrische Leistung, Vorlauf, Betriebsart). Dann: Wärme je kWh nach Leistung und
  Außentemperatur → Vorschlag der KI.

| Tag | Heizstrom | Stunden an | davon 22–9 Uhr | außen |
|---|---|---|---|---|
| 05.11. | 43,1 kWh | 17 | 9,8 kWh | 4,6 °C |
| 06.11. | 38,5 kWh | 17 | 21,2 kWh | 2,9 °C |
| 07.11. | 1,3 kWh | 0 | 0,8 kWh | 5,9 °C |
| 08.11. | 20,3 kWh | 8 | 5,3 kWh | 6,2 °C |
| 09.11. (bis 11 Uhr) | 28,3 kWh | 12 | 20,7 kWh | 2,8 °C |

## 9. Offene Entscheidungen (Uli)

1. **Untergrenze je Raum.** Vorschlag als Startwert: Schlaf- und Wohnräume Normal − 3 °C (≈ 19 °C), Bäder
   Normal − 2 °C (≈ 20 °C), Flur/Ankleide/Büro OG Normal − 3,5 °C. In Venediger gilt Eco − 1 bzw. − 0,5 °C,
   aber dort sind die Räume abends auf Eco. In München liegen die Räume heute bei 18–19 °C – eine Untergrenze von 21 °C
   würde die Wärmepumpe jede Nacht laufen lassen.
2. **Absenk.** Bleibt als Wert für die KI-Raumanalyse („Absenk = Normal − 1“) oder entfällt zugunsten der Untergrenze?
3. **Eine Priorität statt zwei.** Heute gibt es `pv_prio` (PV-Stufe 1–3, auf den Kacheln „PV Prio“) und `priority`
   (Heiz-Reihenfolge 1–4). Vorschlag wie Venediger: **eine** Priorität für beide Modelle. Die PV-Stufen ergeben sich
   dann aus dem Budget.
4. **Abend wie Nacht** ohne Ausnahme, oder Profil *abends* weiter erlauben, wenn der Akku über der Reserve ist?
5. **Netzgrenze** als Anzahl Kreise (heute machbar) bestätigen, Startwert 6.

## 10. Umsetzung (nach Freigabe)

| Schritt | Datei | Inhalt |
|---|---|---|
| Datenbank | `supabase/migration-012-tagesmodi.sql` | `muc_rooms.floor_temp`, `muc_settings.max_grid_circuits`, `wait_threshold`; Startwerte |
| Steuerung | `collector/src/logic.js` | Tagesmodus (Nacht / Wartetag / Schlechter Tag / Überschuss / Abend), Budget-Verteilung (a), Netzgrenze (b), Wartende = Ist − 0,3 °C, Untergrenze; Tests in `collector/test/logic.test.js` |
| App | `frontend/src/Settings.jsx`, Übersicht | Untergrenze je Raum, Netzgrenze, Wartetag-Schwelle; Kacheln zeigen Tagesmodus und Heiz-Prio |
| KI | `supabase/migration-007-ki.sql` | Regel „Absenk fehlt“ an Untergrenze anpassen |
| Doku | `KONZEPT.md`, `INBETRIEBNAHME.md`, `STAND-UND-ROADMAP.md` | nachziehen |
| Venediger | – | nichts zu ändern; München übernimmt dessen Begriffe |
