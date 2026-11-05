# KI – Raummodell, Vorschläge, Hinweise

**Stand:** 05.11.2026 · **SQL:** `supabase/migration-007-ki.sql` · **App:** Tab **KI** (`frontend/src/Ki.jsx`)
**Vorbild:** Venediger, `KONZEPT-RAUMMODELL-2026-11-02.md` und `KONZEPT-KI-VORSCHLAEGE-2026-11-02.md` (§9)

## 1. Grundsatz

- **Die KI misst und schlägt vor – Uli entscheidet.** Geschrieben wird erst nach „Ja, übernehmen“ oder „Anderer Wert“,
  und nur über `muc_ki_decide()`. Jede Übernahme steht im Protokoll (Filter **KI**).
- **Nachprüfbar statt erfunden:** Die Texte entstehen aus festen Satzbausteinen mit den gemessenen Zahlen.
  Lehre aus Venediger: Die stündlichen Sprachmodell-Vorschläge waren dort widersprüchlich (Batterie-Grenze 90 → 85 → 80 → 85
  an einem Vormittag) und sind abgeschaltet.
- **Vorschlagsfähig** sind nur **Absenk** und **PV-Laden** je Raum. Normal ist Ulis Wunschwert; Nachtzeiten, Akku-Reserve
  für den Abend und PV-Schwellen sind gesperrt.
- Läuft komplett in Supabase (pg_cron `muc-ki-tick` alle 15 min). Am Collector ändert sich nichts.

## 2. Raummodell – wie schnell kühlt jeder Raum aus?

Ohne Heizen nähert sich ein Raum der Außentemperatur: `T(t) = T_außen + (T_start − T_außen) · e^(−k·t)`.
`k` je Raum wird aus jeder Nacht (Absenk-Beginn bis „Morgen ab“, Standard 22–6 Uhr) gelernt, in der nicht nachgeheizt wurde.

- **Nachgeheizt** = Ventil offen **und** Wärmepumpe lief (Heizstrom = Verbrauch − Auto − Grundlast > 800 W).
  Nächte mit offenem Ventil, aber stehender Wärmepumpe (30.10.–04.11.2026) zählen deshalb als gültige Abkühl-Nächte.
- Ungültig: zu wenige Messwerte, Temperatur zwischendurch gestiegen, keine Außentemperatur, Raum zu nah an außen.
- Vorsichtig gerechnet mit dem 75-%-Wert von k (lieber zu schnelles Auskühlen annehmen).
- Tabelle `muc_room_nights`, Auswertung `muc_room_model()`, Vorausschau `muc_room_outlook()`:
  vor Nachtbeginn „so warm muss der Raum um 22 Uhr sein“, danach „so warm ist er morgen früh ohne Heizen“.
  Bei Nachtbeginn wird die Vorhersage gespeichert und morgens mit der Messung verglichen.

Erste Werte (Nächte 22.10.–04.11.2026, außen ~5 °C, 8 h): EG 0,3–0,5 °C pro Nacht, OG/DG 0,5–0,7 °C, KG Bad 0,1 °C.
Ulis Regel „Absenk = Normal − 1 °C“ reicht damit, damit die Wärmepumpe nachts meist aus bleibt.

## 3. Tägliche Analyse (ab „Morgen ab“, Standard 09:00)

Grundlage: letzte 7 Tage. Tage, an denen die Wärmepumpe praktisch nicht geheizt hat (< 3 kWh), zählen für die Regeln nicht.

| Regel | Bedingung | Vorschlag |
|---|---|---|
| **Absenk fehlt** (Einstellungsfehler) | Absenk ≥ Normal | Absenk = Normal − 1 °C (zählt nicht zum Tageslimit, nach „Nein“ 30 Tage Ruhe) |
| **Estrich mehr laden** | an ≥ 3 Sonnentagen (≥ 2 kWh eingespeist) PV-Wert erreicht | PV-Laden + 0,5 °C (höchstens Normal + 2) |
| **Nacht reicht nicht** | an ≥ 3 Nächten > 30 min nachgeheizt, obwohl Absenk < Normal | mit Sonnentagen: PV-Laden + 0,5 °C, sonst nur Info |
| **Erreicht Soll nicht** (Info) | an ≥ 3 Tagen > 2 h unter Soll in der Heizzeit | keine Wertänderung – Ursache Wärmepumpe/Ventil/Heizkreis |

Höchstens 3 Verhaltens-Vorschläge am Tag, Rücknahmen zuerst. Kein neuer Vorschlag, solange der gleiche offen ist oder in den
letzten 7 Tagen abgelehnt wurde. Offene Vorschläge, deren Ausgangswert inzwischen anders eingestellt ist, werden „veraltet“.
Dazu ein **Rückblick** auf gestern (Außentemperatur, Sonne, Einspeisung, Heizstrom, Räume unter Soll, Nachtheizung, fehlende Messwerte).

**Wirkungsbericht** 3 Tage nach dem Übernehmen: Nachtheizung und Minuten unter Soll vorher/nachher.
Liegt der Raum danach im Schnitt > 60 min/Tag länger unter Soll → **Rücknahme-Vorschlag** (genehmigt ebenfalls Uli).

## 4. Sofort-Hinweise (alle 15 min, erledigen sich selbst)

| Hinweis | Bedingung |
|---|---|
| **Wärmepumpe liefert keine Wärme** | 2 h lang ≥ 3 Ventile ≥ 80 % offen, Heizstrom < 300 W, außen < 15 °C (hätte am 30.10.2026 gegen 14 Uhr angeschlagen); erledigt, wenn 30 min > 800 W |
| **Collector meldet sich nicht** | keine Energiewerte seit 15 min |
| **Keine Raumwerte von Loxone** | Energiewerte kommen, Raumwerte seit 30 min nicht (wie 03.11. 18 Uhr – 05.11. 7 Uhr) |
| **Automatik ist aus** / **Testmodus ist an** | seit mehr als 6 h |

Hinweise erscheinen als rote Leiste über jeder Seite und im Tab KI. „Gesehen, ausblenden“ blendet für 24 h aus.

## 5. Bedienung und Betrieb

- Tab **KI**: Hinweise · Zu entscheiden (Ja / Anderer Wert / Nein) · Zur Info · Raummodell · Verlauf.
  „Neu analysieren“ rechnet die heutige Analyse sofort neu.
- Kontrolle in Supabase: `select muc_ki_tick();` · `select * from muc_room_model();` · `select * from muc_room_outlook();`
- Nächte nachrechnen: `select muc_room_nights_rebuild('2026-10-22', current_date - 1);`
- Abschalten: `select cron.unschedule('muc-ki-tick');`

## 6. Nächste Schritte

- Ähnliche Tage (Stufe B): Prognose, Außentemperatur, Heizgradzahl aus `muc_day_patterns` → welche Einstellungen hatten
  an vergleichbaren Tagen den geringsten Netzbezug bei eingehaltenen Temperaturen.
- Vorausschau in der Steuerung: Raum mit dem größten Nachtbedarf bekommt PV-Wärme zuerst (wie Venediger §5) –
  erst, wenn die Vorhersage einige Nächte gegen die Messung geprüft ist.
- Nach LAN-Anschluss der Wärmepumpe: echter Heizstrom statt Schätzung für Raummodell und Hinweis.
