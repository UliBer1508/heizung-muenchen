# FIX: Drei Temperaturen je Raum – Min, Normal, PV-Max (25.11.2026)

## Anlass

München hatte noch vier Temperaturen je Raum (Untergrenze, Normal, PV-Laden, Batterie voll). Venediger hat „Batterie voll“
am 07.11.2026 abgeschafft und am 14.11.2026 auf drei Temperaturen umgestellt
(Venediger: `doc/FIX-DREI-TEMPERATUREN-2026-11-14.md`). Uli, 25.11.2026: „Wir stellen auf das Modell Venediger um“ –
dazu die Raumkarten in den Einstellungen wie in Venediger.

## Entscheidung

| Neu | Spalte | Bedeutung | früher |
|---|---|---|---|
| **Min** | `temp_night` | nie darunter, Tag und Nacht; nachts, abends und am Wartetag das Ziel | „Untergrenze“ |
| **Normal** | `temp_normal` | Ziel tagsüber, ohne Sonne auch aus dem Netz | „Normal“ |
| **PV-Max** | `temp_pv` | bis hierhin mit PV-Überschuss (Estrich-Speicher) – auch bei voller Batterie nicht höher | „PV-Laden“ |
| – | `temp_full` | wird nicht mehr verwendet | „Batterie voll“ |

München hatte Min schon (die Untergrenze galt bereits Tag und Nacht). Es entfällt nur „Batterie voll“.

## Umsetzung

**Collector 0.15.0** (`collector/src/logic.js`, Modell a)
- Bei voller Batterie (Stufe `PV_FULL`) dürfen weiterhin **alle** PV-Räume gleichzeitig heizen, aber nur bis **PV-Max**
  (`temp_pv`), nicht mehr bis `temp_full`. Begründung im Protokoll: „Batterie voll – alle PV-Räume auf PV-Max“.
  Das entspricht Venediger: Komfort ist das Maximum, bei voller Batterie bleiben die Räume auf Komfort.
- Test angepasst (60/60 grün).

**Oberfläche**
- Einstellungen › **Räume** (neu, `frontend/src/Raeume.jsx`): eine Karte je Raum wie in Venediger – Kopf mit Ist/Soll,
  Priorität, „PV laden“ / „kein PV“, „Automatik aus“; drei Felder Min / Normal / PV-Max mit Prüfung Min ≤ Normal ≤ PV-Max;
  Automatik-Schalter; Hinweis zur Batterie; aufklappbar „Technik & Lernwerte“ (Loxone-Namen, gemessene Aufheizzeit);
  Speichern nur der geänderten Felder, „Verwerfen“. Zweispaltig, auf dem Handy einspaltig.
- Heizplan, Raum-Prioritäten, Übersicht und KI-Tab heißen jetzt Min / PV-Max; „voll …“ ist aus dem Heizplan verschwunden.

**Datenbank:** keine Änderung. `temp_full` bleibt als Spalte stehen (alte Tagesprotokolle lesen sie), wird aber weder
angezeigt noch geschrieben noch von der Steuerung genutzt.

## Noch nicht umbenannt (eigene Entscheidung)

- Begründungstexte des Collectors und der Nacht-Haltezeit sagen weiter „Untergrenze“.
- KI-Vorschlagstexte in der Datenbank (migration-007/016) sagen „Absenk“ bzw. „PV-Laden“.

## Einspielen

1. PR mergen → Vercel deployt die Oberfläche.
2. Mini-PC München: `git pull` → `C:\nssm\nssm.exe restart HeizungMuenchen` (Collector 0.15.0).
   Bis dahin heizt der alte Collector bei voller Batterie noch auf den alten Wert „Batterie voll“.
