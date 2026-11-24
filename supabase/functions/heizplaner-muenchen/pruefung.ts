// KOPIE aus Heizung Venediger – Herkunft: UliBer1508/smartfox-insight-ai-selfhosted · supabase/functions/heizplaner/pruefung.ts
// Commit af244ae (Stand 24.11.2026). Geändert nur, was München anders hat (MÜNCHEN:): Uhrzeit Europe/Berlin, „unter Eco“ heißt
// in München „unter Normal“ (Messwerte aus muc_raum_messwerte, migration-018).
//
// Heizplaner – Plan-Prüfung je Raum (13.11.2026, doc/FIX-PLANER-PRUEFUNG-2026-11-13.md)
//
// Uli: „Wir wissen, wie lange ein Raum zum Auskühlen braucht und wie lange zum Aufheizen – also wissen wir, wie lange
// das Heizen dauern darf. Wenn etwas schief läuft, hat die KI zu reagieren.“
//
// Darum prüft der Planer jeden Plan gegen das, was je Raum GEMESSEN ist (raum_messwerte, SQL 38) – nicht gegen sein
// eigenes Raummodell. Fällt ein Raum auf, steuert ihn die Regel-Steuerung (pv-automation) statt des Plans, mindestens
// SPERRE_MIN; der Modus (aus/schatten/steuern) bleibt, wie Uli ihn eingestellt hat.
//
// Reine Funktionen ohne Datenbank, damit sie mit echten Daten geprüft werden können.

import { DT_H, aufheizen, type PlanRaum, type PlanSlot, type RaumParam } from './modell.ts';

export const SPERRE_MIN = 120;          // so lange bleibt ein auffälliger Raum mindestens bei der Regel-Steuerung
export const FAKTOR_HEIZZEIT = 2;       // Spielraum: geplant darf höchstens das Doppelte des gemessenen Bedarfs sein
export const ZUSCHLAG_H = 1;            // + 1 h (ganze Heizblöcke, Nachheizen)
export const UEBER_ZIEL_C = 0.5;        // „über Ziel“ erst ab 0,5 °C (Schaltband der Thermostate)
export const UEBERSTEUERT_MAX = 2;      // so oft von Hand übersteuert (24 h) → Plan passt für den Raum nicht

export interface Messwert {
  n_heiz?: number | null;               // gezählte Heizblöcke (14 Tage)
  auf_dauer_k_h?: number | null;        // dauerhafte Erwärmung je Heizstunde (2 h nach dem Heizen gemessen)
  n_dauer?: number | null;              // Heizblöcke, aus denen auf_dauer_k_h stammt
  heiz_h_tag?: number | null;           // geheizte Stunden je Tag (14 volle Tage)
  tin?: number | null; tout?: number | null;   // mittlere Raum-/Außentemperatur derselben Tage
  unter_eco?: number | null;            // Anteil 08–22 Uhr (3 Tage) mehr als 0,3 °C unter Eco
  heiz_h_3t?: number | null;            // geheizte Stunden je Tag (3 Tage)
  uebersteuert?: number | null;         // Übersteuerungen von Hand (24 h)
}
export interface RaumPruefung {
  ok: boolean;                          // false → Regel-Steuerung für diesen Raum
  gruende: string[];                    // in einfachen Worten, für Protokoll und App
  arten: string[];                      // heizzeit | ueber_ziel | uebersteuert | wartezeit
  geplant_h: number;                    // geplante Heizstunden ohne PV-Überschuss
  erlaubt_h: number | null;             // nach Messung erlaubt (null: zu wenig Messwerte)
  bis: number | null;                   // Epoch-Sekunden: Regel-Steuerung mindestens bis
  hinweis?: string | null;              // nur Hinweis (keine Sperre), z. B. Ziel wird nicht erreicht
}
export type PruefStand = Record<string, { bis: number; gruende: string[]; seit: number }>;

const r1 = (x: number) => Math.round(x * 10) / 10;
const de = (x: number) => r1(x).toFixed(1).replace('.', ',');
const fin = (x: any): x is number => x != null && Number.isFinite(Number(x));

/** Erwärmung, mit der gerechnet wird: gemessen (dauerhaft, nach dem Heizen), sonst das gelernte Modell. */
export function aufheizRate(m: Messwert | undefined, param: RaumParam): { rate: number; quelle: 'gemessen' | 'modell' } {
  if (m && fin(m.auf_dauer_k_h) && Number(m.auf_dauer_k_h) > 0.05 && Number(m.n_dauer ?? 0) >= 4)
    return { rate: Number(m.auf_dauer_k_h), quelle: 'gemessen' };
  return { rate: Math.max(0.05, aufheizen(param)), quelle: 'modell' };
}

/**
 * Wie viele Stunden darf der Raum in diesem Plan ohne PV-Überschuss heizen?
 *   Halten  = gemessene Heizstunden je Tag, umgerechnet auf Ziel und Außentemperatur des Plans
 *   Aufheizen = (höchstes Ziel − jetzt) / Erwärmung je Heizstunde
 *   erlaubt = FAKTOR × (Halten + Aufheizen) + ZUSCHLAG
 */
export function erlaubteHeizzeit(r: PlanRaum, m: Messwert | undefined, slots: PlanSlot[]): number | null {
  if (!m || !fin(m.heiz_h_tag) || !fin(m.tin) || !fin(m.tout) || Number(m.n_heiz ?? 0) < 5) return null;
  const n = slots.length;
  const zielMittel = r.ziel.reduce((s, z) => s + z, 0) / n;
  const toutMittel = slots.reduce((s, x) => s + x.tout, 0) / n;
  const bezug = Math.max(3, Number(m.tin) - Number(m.tout));
  const f = Math.min(2.5, Math.max(0.5, (zielMittel - toutMittel) / bezug));
  const halten = Number(m.heiz_h_tag) * f * (n * DT_H / 24);
  const { rate } = aufheizRate(m, r.param);
  const aufheizenH = Math.max(0, Math.max(...r.ziel) - r.T0) / rate;
  return FAKTOR_HEIZZEIT * (halten + Math.min(aufheizenH, 12)) + ZUSCHLAG_H;
}

/**
 * Prüft den Plan je Raum. heizen/temp: Ergebnis von plane(); heizW: Heizleistung je Slot (alle Räume).
 * vorher: Stand der letzten Prüfung (Sperren mit Ablaufzeit). jetzt: Epoch-Sekunden.
 */
export function pruefePlan(raeume: PlanRaum[], heizen: number[][], temp: number[][], slots: PlanSlot[], heizW: number[],
                           messwerte: Record<string, Messwert> | null | undefined, vorher: PruefStand | null | undefined,
                           jetzt: number): Record<string, RaumPruefung> {
  const out: Record<string, RaumPruefung> = {};
  // Slots, in denen die Heizung NICHT vom PV-Überschuss gedeckt ist (Netz oder Batterie)
  const ohnePv = slots.map((s, i) => heizW[i] > Math.max(0, s.pv - s.base) + 1);
  raeume.forEach((r, ri) => {
    const m = messwerte?.[r.id];
    const gruende: string[] = [], arten: string[] = [];
    // 1. Heizzeit gegen Messung
    let geplant = 0;
    heizen[ri].forEach((h, i) => { if (h === 1 && r.fest[i] == null && ohnePv[i]) geplant += DT_H; });
    const erlaubt = erlaubteHeizzeit(r, m, slots);
    if (erlaubt != null && geplant > erlaubt) {
      arten.push('heizzeit');
      gruende.push(`Plan heizt ${de(geplant)} h ohne Sonne, nach den Messwerten reichen etwa ${de((erlaubt - ZUSCHLAG_H) / FAKTOR_HEIZZEIT)} h`);
    }
    // 2. Aus Netz/Batterie über das Ziel
    let ueber = 0, tMax = -Infinity;
    // Temperatur zu Beginn des Slots (vor dem Heizen) – ein großer Heizblock darf übers Ziel schießen, aber nicht
    // anfangen, wenn der Raum schon deutlich über dem Ziel ist.
    heizen[ri].forEach((h, i) => {
      const vorher = i === 0 ? r.T0 : temp[ri][i - 1];
      if (h === 1 && r.fest[i] == null && ohnePv[i] && vorher > r.ziel[i] + UEBER_ZIEL_C) { ueber += DT_H; tMax = Math.max(tMax, temp[ri][i]); }
    });
    if (ueber >= 0.5) {
      arten.push('ueber_ziel');
      gruende.push(`Plan heizt ${de(ueber)} h aus Netz/Batterie über das Ziel (bis ${de(tMax)} °C)`);
    }
    // 3. Von Hand übersteuert
    if (Number(m?.uebersteuert ?? 0) >= UEBERSTEUERT_MAX) {
      arten.push('uebersteuert');
      gruende.push(`in 24 h ${m!.uebersteuert}× von Hand übersteuert – der Plan passt für diesen Raum nicht`);
    }
    // Sperre: neu auffällig → jetzt + SPERRE_MIN; vorher gesperrt und Zeit noch nicht um → weiter gesperrt
    const alt = vorher?.[r.id];
    let bis: number | null = null;
    if (arten.length) bis = jetzt + SPERRE_MIN * 60;
    else if (alt && alt.bis > jetzt) {
      bis = alt.bis;
      arten.push('wartezeit');
      gruende.push(`war auffällig (${alt.gruende[0] ?? '–'}), Regel-Steuerung noch bis ${new Date(alt.bis * 1000).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin'   /* MÜNCHEN */ })}`);
    }
    // 4. Hinweis (keine Sperre): Raum heizt viel länger als gemessen nötig und bleibt trotzdem unter Eco
    let hinweis: string | null = null;
    if (m && fin(m.heiz_h_3t) && fin(m.heiz_h_tag) && fin(m.unter_eco)
        && Number(m.heiz_h_3t) >= 2 * Math.max(1, Number(m.heiz_h_tag)) && Number(m.unter_eco) >= 0.5) {
      hinweis = `heizt zuletzt ${de(Number(m.heiz_h_3t))} h am Tag (sonst ${de(Number(m.heiz_h_tag))} h) und liegt trotzdem `
        + `${Math.round(Number(m.unter_eco) * 100)} % der Zeit unter Normal – Ventil, Fühler oder Normal-Wert prüfen`;   // MÜNCHEN: Normal statt Eco
    }
    out[r.id] = { ok: arten.length === 0, gruende, arten, geplant_h: r1(geplant), erlaubt_h: erlaubt == null ? null : r1(erlaubt), bis, hinweis };
  });
  return out;
}

/** Neuer gespeicherter Stand aus dem Prüfergebnis (nur gesperrte Räume). */
export function neuerStand(p: Record<string, RaumPruefung>, vorher: PruefStand | null | undefined, jetzt: number): PruefStand {
  const s: PruefStand = {};
  for (const [id, x] of Object.entries(p)) {
    if (x.bis == null) continue;
    const echte = x.gruende.filter((_, i) => x.arten[i] !== 'wartezeit');
    s[id] = { bis: x.bis, gruende: echte.length ? echte : (vorher?.[id]?.gruende ?? []), seit: vorher?.[id]?.seit ?? jetzt };
  }
  return s;
}
