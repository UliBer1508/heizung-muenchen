# Heizung München

PV-gesteuerte Wasser-Fußbodenheizung (Wärmepumpe) im Haus München.
FENECON liefert PV-, Netz- und Batteriewerte, die App setzt pro Raum die
Komforttemperatur im Loxone-Raumregler. Pilot: **KG Bad**.

| | |
|---|---|
| Collector | `collector/` – Node.js ≥ 20.6, ohne Zusatzpakete, läuft als NSSM-Dienst auf dem Mini-PC |
| Web-App | `frontend/` – React + Vite, Hosting Vercel (Root Directory `frontend`) |
| Datenbank | `supabase/schema.sql` – Tabellen `muc_*` im Venediger-Supabase-Projekt |
| Doku | `doc/KONZEPT.md` (Wie & Warum), `doc/INBETRIEBNAHME.md` (Schritt für Schritt) |

## Kurz

```
collector/  npm test              # Logik- und End-to-End-Tests (ohne Hardware)
            npm run test:fenecon  # FENECON-Werte prüfen
            npm run test:loxone   # Loxone lesen (und mit -- --set 22 schreiben)
            npm start             # Dauerbetrieb
frontend/   npm install && npm run dev
```

**Sicherheit:** Ab Werk läuft alles im **Testmodus** – es wird nichts nach Loxone
geschrieben, bis du ihn in der App ausschaltest. Loxone begrenzt den Sollwert
zusätzlich auf 5–26 °C.

Verwandt: Venediger-Lösung `smartfox-insight-ai-selfhosted` (Fronius/Tuya, Direktheizung).
