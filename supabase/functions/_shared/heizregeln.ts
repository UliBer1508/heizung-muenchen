// KOPIE aus Heizung Venediger – Herkunft: UliBer1508/smartfox-insight-ai-selfhosted · supabase/functions/_shared/heizregeln.ts
// Commit af244ae (Stand 24.11.2026). Inhalt unverändert (Grundregel doc/KONZEPT.md). München benutzt tagesart() nicht –
// der Wartetag kommt wie im Collector aus dem erwarteten Überschuss (wait_min_kwh), siehe heizplaner-muenchen/rechnen.ts.
// sonnenuntergangMin rechnet mit Europe/Vienna – gleiche Zeitzone wie Berlin (MEZ/MESZ); München nutzt es nicht (Abend = evening_start).
//
// Feste Heizregeln – EINE Stelle für Steuerung (pv-automation) und Planer (heizplaner).
// 16.11.2026, doc/FIX-REGELN-RAHMEN-FUER-PLANER-2026-11-16.md
//
// Uli 16.11.2026: „Die Steuerung soll den Planer, der nach festen Regeln steuert, um die KI-Funktionen ergänzen und
// nicht ausschalten.“ Die Regeln sind der Rahmen, die KI (Planer: Raummodell, PV-Vorhersage, Muster) entscheidet
// innerhalb des Rahmens, wann und welcher Raum heizt.
//
// Heizkonzept (Uli, 27.10. / 02.11. / 14.11.2026):
//   – Min wird nie unterschritten (Tag und Nacht).
//   – PV-Überschuss heizt immer, erst Normal, dann PV-Überschuss-Wert, nach Priorität.
//   – Sonnentag (PV-Überschuss reicht heute für Normal): aus Netz/Batterie nur bis Min, auf die Sonne warten.
//   – Tag ohne genug Sonne: Normal aus dem Netz nach Priorität (Leistungsgrenze).
//   – Abend nach Sonnenuntergang und Nacht: aus Netz/Batterie nur bis Min.
//   – Abwesend (Kalender): jeder Tag wie ein Sonnentag (Netz nur bis Min, PV lädt).
// Reine Funktionen ohne Datenbank, damit sie mit echten Daten geprüft werden können.

/** Ab diesem Verhältnis PV-Überschuss / Normal-Bedarf gilt der Tag als Sonnentag (seit 12.11.2026 fest 1,0). */
export const SONNENTAG_SCHWELLE = 1.0;

export interface Tagesart { ratio: number | null; sonnentag: boolean; ueberschussWh: number }

/**
 * Sonnentag oder nicht. Überschuss = Rest-PV des Tages (nach Grundlast) − was die Batterie bis voll noch aufnimmt.
 * Sonnentag, wenn der Überschuss den Bedarf deckt, um alle Räume auf Normal zu bringen.
 */
export function tagesart(pvRestWh: number, batterieBedarfWh: number, normalBedarfWh: number, nachSonnenuntergang: boolean): Tagesart {
  const ueberschussWh = Math.max(0, pvRestWh - Math.max(0, batterieBedarfWh));
  if (nachSonnenuntergang) return { ratio: null, sonnentag: false, ueberschussWh };
  const ratio = normalBedarfWh > 0 ? ueberschussWh / normalBedarfWh : (ueberschussWh > 0 ? 99 : 0);
  return { ratio, sonnentag: ratio >= SONNENTAG_SCHWELLE, ueberschussWh };
}

/** Bis wohin darf ein Raum aus Netz oder Batterie geheizt werden (ohne PV-Überschuss)? */
export type Netzgrenze = 'min' | 'normal';
export function netzGrenze(z: { nacht: boolean; abend: boolean; sonnentag: boolean; abwesend?: boolean }): Netzgrenze {
  return (z.nacht || z.abend || z.sonnentag || z.abwesend) ? 'min' : 'normal';
}

/** Bis zu welcher Raumtemperatur darf ohne PV-Überschuss geheizt werden? Min immer, Normal nur am Tag ohne genug Sonne. */
export function netzGrenzTemp(grenze: Netzgrenze, min: number, normal: number): number {
  return grenze === 'normal' ? Math.max(min, normal) : min;
}

/** Darf ein Raum JETZT aus Netz/Batterie heizen? (PV-Überschuss wird vorher geprüft.)
 *  spielraum: wie weit über der Grenztemperatur noch geheizt werden darf (Schaltband, ziel_abschalt_ueber_c 0,3 °C).
 *  16.11.2026: ohne Vorlauf – der Planer heizt laut Raummodell rechtzeitig vor Min (Entscheidung 14.11., Variante A). */
export function netzHeizenErlaubt(grenze: Netzgrenze, ist: number, min: number, normal: number, spielraum: number): boolean {
  if (!(ist > 0)) return false;
  return ist < netzGrenzTemp(grenze, min, normal) + spielraum;
}

/** Sonnenuntergang (Wiener Ortszeit, Minuten nach Mitternacht) – astronomisch, ohne Bergschatten. */
export function sonnenuntergangMin(tagIso: string, lat = 47.25, lon = 12.25): number {
  const d = new Date(`${tagIso}T12:00:00Z`);
  const n = Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86400000);
  const rad = Math.PI / 180;
  const gamma = 2 * Math.PI / 365 * (n - 1);
  const eqt = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma) - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma));
  const decl = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma) - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma) - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma);
  const ha = Math.acos(Math.cos(90.833 * rad) / (Math.cos(lat * rad) * Math.cos(decl)) - Math.tan(lat * rad) * Math.tan(decl)) / rad;
  const utcMin = 720 - 4 * (lon - ha) - eqt;
  // Wiener Zeit: Offset des Tages bestimmen
  const off = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Vienna', timeZoneName: 'shortOffset' })
    .formatToParts(d).find(p => p.type === 'timeZoneName')?.value ?? 'GMT+1';
  const h = Number((off.match(/GMT([+-]\d+)/) ?? [, '1'])[1]);
  return Math.round(utcMin + h * 60);
}
