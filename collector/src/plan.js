// „KI steuert“ (Collector 0.14, 24.11.2026) – doc/PLANER-WIE-VENEDIGER-2026-11-24.md
//
// ÜBERNOMMEN aus Heizung Venediger (pv-automation: ladePlanerPlan, planerSollwert, planerImRahmen; Commit af244ae,
// doc/FIX-PLANER-MODELL-2026-11-13.md, FIX-PLANER-MIN-HART-2026-11-14.md, FIX-REGELN-RAHMEN-FUER-PLANER-2026-11-16.md).
// In Venediger setzt die Edge Function pv-automation den Plan um, in München der Collector – die Logik ist dieselbe:
//
//   * Modus muc_settings.planer_modus = 'steuern' (schaltet nur Uli). Sonst ändert diese Datei nichts.
//   * Jüngster Plan aus muc_heizplan, höchstens 30 min alt, Slot = aktuelle Viertelstunde. Sonst Regel-Steuerung (allocateRooms).
//   * Je Raum nur, wenn sein Raummodell neu gelernt ist (m2) und die Plan-Prüfung ihn nicht auffällig findet (pruefung_ok).
//   * Sicherheit bleibt: manuell übersteuert, Raum aus, „früh zu“ der Regel-Steuerung bleiben unberührt; unter der
//     Untergrenze heizt der Raum immer (Min hart); über dem Höchstwert (PV-Wert) + 0,3 °C ist das Ventil zu.
//   * Feste Regeln als Rahmen (_shared/heizregeln.ts): ohne PV-Überschuss heizt der Plan nur bis zur Netzgrenze –
//     Nacht, Abend, Wartetag → Untergrenze; Tag ohne genug Sonne → Normal (Ziel des Plans) + Spielraum.
//   * Netzgrenze (Kreise) gilt weiter: Räume ohne Sonnenstrom höchstens max_grid_circuits gleichzeitig.
//
// MÜNCHEN: „heizen“ = Loxone-Sollwert so über das Ist, dass der Raumregler das Ventil öffnet; „nicht heizen“ = Sollwert
// sicher unter dem Ist (wie closedTarget/holdBelow der Regel-Steuerung). Loxone bleibt der Regler.

import { clamp, holdBelow, HARD_MIN, HARD_MAX, overrideActive } from './logic.js';

export const PLAN_MAX_ALTER_MIN = 30;
const SPIELRAUM = 0.3;   // wie Venediger ziel_abschalt_ueber_c

/** Reine Funktion: Planstand aus der jüngsten Zeile von muc_heizplan. */
export function planStandAus(row, { modus, now = new Date() }) {
  if (modus !== 'steuern') return { map: null, grund: `Modus ${modus ?? 'schatten'}` };
  if (!row?.plan) return { map: null, grund: 'kein Plan vorhanden → Regel-Steuerung' };
  const alterMin = (now.getTime() - new Date(row.erstellt_at).getTime()) / 60000;
  if (alterMin > PLAN_MAX_ALTER_MIN) return { map: null, grund: `Plan ${Math.round(alterMin)} min alt (> ${PLAN_MAX_ALTER_MIN}) → Regel-Steuerung` };
  const idx = Math.floor((now.getTime() / 1000 - Number(row.plan.start)) / 900);
  if (!(idx >= 0 && idx < 96)) return { map: null, grund: `Plan passt nicht zur Uhrzeit (Slot ${idx}) → Regel-Steuerung` };
  const map = new Map();
  for (const r of row.plan.raeume ?? []) {
    const h = String(r.h ?? '');
    if (h.length <= idx) continue;
    if (r.m2 === false) continue;            // Raummodell noch nicht neu gelernt → Regel-Steuerung
    if (r.pruefung_ok === false) continue;   // Plan-Prüfung: auffällig → Regel-Steuerung für diesen Raum
    map.set(r.id, { heizt: h[idx] === '1', ziel: Number(r.ziel?.[idx]), unter: Number(r.unter), p: Number(r.p) || 400 });
  }
  const at = new Date(row.erstellt_at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });
  return { map, grund: `Plan von ${at}` };
}

const fmt1 = (v) => Number(v).toFixed(1).replace('.', ',');

/**
 * Plan in Sollwerte umsetzen (reine Funktion). items: Ergebnis von allocateRooms (Regel-Steuerung, Rückfall).
 * grenze: 'min' (Nacht, Abend, Wartetag) | 'normal' (Tag ohne genug Sonne). pvFreiW: Sonnenstrom, den die Heizung nutzen darf.
 * Gibt neue items zurück; Räume ohne Planeintrag behalten das Ergebnis der Regel-Steuerung.
 */
export function planAnwenden({ items, stand, settings, grenze, pvFreiW, now = new Date() }) {
  if (!stand?.map) return { items, planRaeume: [], heizen: [] };
  const cap = Math.max(1, Number(settings.max_grid_circuits) || 6);
  let pvFrei = Math.max(0, Number(pvFreiW) || 0);
  const out = items.map((it) => ({ ...it, t: { ...it.t } }));
  // Räume, die die Regel-Steuerung ohnehin festhält: manuell, früh zu → bleiben, zählen aber zur Netzgrenze
  let netzKreise = out.filter((it) => (it.t.mode === 'OVERRIDE') && Number(it.state?.valve ?? 0) > 0).length;
  const kandidaten = [];
  for (const it of out) {
    const e = stand.map.get(it.room.id);
    if (!e || it.t.mode === 'OVERRIDE' || it.t.mode === 'FRUEH_AUS' || overrideActive(it.room, now)) continue;
    if (it.temp == null || Number.isNaN(Number(it.temp))) continue;
    kandidaten.push({ it, e });
  }
  // Reihenfolge wie die Regel-Steuerung: unter der Untergrenze zuerst, dann Priorität
  const prio = (it) => (it.room.priority == null ? 99 : Number(it.room.priority));
  kandidaten.sort((a, b) => (Number(a.it.temp) < Number(a.e.unter) ? -1 : 0) - (Number(b.it.temp) < Number(b.e.unter) ? -1 : 0)
    || prio(a.it) - prio(b.it) || ((a.it.room.sort ?? 0) - (b.it.room.sort ?? 0)));

  const planRaeume = [], heizen = [];
  for (const { it, e } of kandidaten) {
    const lo = Math.max(HARD_MIN, it.room.min_temp ?? HARD_MIN), hi = Math.min(HARD_MAX, it.room.max_temp ?? HARD_MAX);
    const ist = Number(it.temp);
    const unter = Number.isFinite(e.unter) ? e.unter : Number(it.room.temp_night);
    const ziel = Number.isFinite(e.ziel) ? e.ziel : unter;
    const hoechst = Number(it.room.pv_prio) > 0 ? Math.max(Number(it.room.temp_normal), Number(it.room.temp_pv ?? it.room.temp_normal))
      : Number(it.room.temp_normal) + 0.5;
    const sp = it.state?.setpoint == null ? null : Number(it.state.setpoint);
    const zu = (why) => {
      const target = sp != null && sp <= ist - 0.3 && sp >= ist - 2 && sp >= lo ? sp : clamp(holdBelow(ist, Math.max(lo, ist)), lo, hi);
      return { mode: 'PLAN_ZU', target, reason: why, wanted: ziel };
    };
    let t;
    const notfall = ist < unter;
    if (ist >= hoechst + 0.3) {
      t = zu(`KI: über Höchstwert (${fmt1(ist)} ≥ ${fmt1(hoechst)} + 0,3 °C) → Ventil zu`);
    } else if (e.heizt || notfall) {
      const grund = notfall ? `Sicherheit: unter Untergrenze (${fmt1(ist)} < ${fmt1(unter)} °C) → heizt, auch wenn der Plan nicht heizt`
        : `KI: heizen (Ziel ${fmt1(ziel)} °C, Ist ${fmt1(ist)} °C)`;
      // Regel-Rahmen (Venediger planerImRahmen): ohne freien Sonnenstrom nur bis Grenztemperatur + Spielraum
      const mitPv = pvFrei >= 0.5 * e.p;
      const grenzT = (grenze === 'normal' ? Math.max(unter, ziel) : unter) + SPIELRAUM;
      if (!notfall && !mitPv && !(ist < grenzT)) {
        const regel = grenze === 'min' ? `ohne PV-Überschuss nur bis Untergrenze ${fmt1(unter)} °C` : `aus dem Netz nur bis Normal ${fmt1(ziel)} °C`;
        t = zu(`Regel: ${regel} – KI wollte aus Netz/Akku heizen (Ist ${fmt1(ist)} °C) → wartet auf Sonne, Ventil zu`);
      } else if (!mitPv && !notfall && netzKreise >= cap) {
        t = zu(`KI wollte heizen – Netzgrenze ${cap} Kreise voll → wartet`);
      } else {
        if (mitPv) pvFrei -= e.p; else netzKreise += 1;
        // Sollwert so, dass Loxone sicher öffnet: mindestens Ziel, mindestens Ist + 0,5 (0,5er-Schritte), höchstens Höchstwert
        const auf = Math.min(hoechst, Math.max(notfall ? unter : ziel, Math.ceil((ist + 0.5) * 2) / 2));
        const laeuft = Number(it.state?.valve ?? 0) > 0 && sp != null && sp >= ist + 0.2 && sp <= hoechst;
        const target = clamp(laeuft ? sp : auf, lo, hi);
        t = { mode: 'PLAN', target, reason: `${grund}${mitPv ? ' – mit Sonnenstrom' : ''}${laeuft ? ', läuft' : ` → ${fmt1(target)} °C`}`, wanted: ziel };
        heizen.push(it.room.id);
      }
    } else {
      t = zu(`KI: nicht heizen (Ist ${fmt1(ist)} °C, Ziel ${fmt1(ziel)} °C) → Ventil zu`);
    }
    it.t = t;
    planRaeume.push(it.room.id);
  }
  return { items: out, planRaeume, heizen };
}

/** Netzgrenze des Regel-Rahmens aus dem Tagesmodus des Collectors (logic.js dayModeOf). */
export const grenzeAus = (dayMode) => (dayMode === 'grid' ? 'normal' : 'min');

/** Sonnenstrom, den die Heizung jetzt nutzen darf: unter pv_min_soc gehört die Sonne zuerst dem Akku (wie surplusW). */
export function pvFreiAus(energy, settings) {
  if (!energy) return 0;
  const base = Number(settings.baseload_w) || 350;
  if (energy.soc != null && energy.soc >= Number(settings.pv_min_soc ?? 60)) return Math.max(0, (energy.pvW ?? 0) - base);
  return Math.max(0, -(energy.gridW ?? 0));
}
