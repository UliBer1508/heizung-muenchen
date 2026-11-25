# Heizung jetzt – gleicher Aufbau wie Venediger (25.11.2026)

Uli 24.11.2026: beide Systeme sollen gleich sein. Die Karte „Heizung jetzt“ war seit 10.11. auseinandergelaufen.
Mockup am 25.11. freigegeben („ja bauen“). Gegenstück in Venediger: `doc/HEIZUNG-JETZT-WIE-MUENCHEN-2026-11-25.md`.

## Gemeinsamer Aufbau
1. Drei Zahlen: Wärmepumpe (geschätzt) · Kreise offen · **Grenze** (neu: `max_grid_circuits`, belegt = offene Kreise).
   Je Haus anders nur die ersten zwei – die Wärmepumpe wird nicht gemessen, ein Ventil hat keine eigene Leistung.
2. Prüfzeile mit Erklärung wie Venediger: Messung zu alt (> 7 min), Kreise erst nach der Messung geöffnet,
   Auto lädt / Batterie lädt bzw. gibt ab, ohne offenen Kreis viel Leistung → Warmwasser der Wärmepumpe.
3. **Woher kommt der Heizstrom?** Heute/Woche/Monat/Jahr, Balken Sonne/Akku/Netz jetzt in kWh des Zeitraums
   (vorher: Balken in W von jetzt, Zeiträume in der dritten Zahl).
4. Offene Kreise mit „seit“, Raumtemperatur und **Begründung** (neu): manuell (override_until) → Ventil offen trotz
   „Wartet/Aus“ (folgt nicht) → Ziel erreicht, noch offen → letzte Entscheidung der Automatik (`muc_decisions`, 3 h).
5. **Netzstrom sparen** (neu, nur Hinweise): offen über dem Ziel bei Netzbezug, Ventil folgt nicht, mehr Kreise als
   die Grenze ohne Sonne.

Nur `frontend/src/HeatingNow.jsx` und `styles.css`, keine Datenbank-Änderung, keine Änderung an der Steuerung.
