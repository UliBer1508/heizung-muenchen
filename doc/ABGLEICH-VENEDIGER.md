# Abgleich mit Heizung Venediger

Grundregel (Uli, 12.11. / 24.11.2026): Beide Systeme sind gleich. München übernimmt von Venediger, Unterschiede nur, wo die Heizart sie verlangt (`MÜNCHEN:` im Code).

| Teil | Venediger | München | Stand |
|---|---|---|---|
| Rechenkern Planer | `heizplaner/modell.ts` | `heizplaner-muenchen/modell.ts` (Kopie) | af244ae, 24.11.2026 |
| Plan-Prüfung | `heizplaner/pruefung.ts` | `heizplaner-muenchen/pruefung.ts` (Kopie) | af244ae |
| Feste Regeln | `_shared/heizregeln.ts` | `_shared/heizregeln.ts` (Kopie) | af244ae |
| Daten/Planen/Gegenrechnung | `heizplaner/rechnen.ts`, `index.ts` | `heizplaner-muenchen/rechnen.ts`, `index.ts` | af244ae |
| KI steuert | `pv-automation` | `collector/src/plan.js` | af244ae |
| Wo stehen wir / Gegenrechnung | `OptimierungView`, `KiGegenRegeln` | `WoStehenWir.jsx`, `KiGegenRegeln.jsx` | af244ae |
| Nachts nur Min, Haltezeit | SQL 46/47 | migration-016, Collector 0.13 | 24.11.2026 |
| EMHASS, HiGHS | eingebaut | bewusst nicht (EMHASS-HIGHS-BEWERTUNG) | 24.11.2026 |

**Regel:** Jede Änderung am Planer oder an der Auto-Steuerung in einem Haus → im selben Zug prüfen, ob das andere Haus sie braucht, und diese Tabelle nachziehen.
