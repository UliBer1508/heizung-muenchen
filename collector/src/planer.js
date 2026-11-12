// Planer der Auto-Steuerung anstoßen (Collector 0.12, 12.11.2026) – doc/AUTO-STEUERUNG-2026-11-12.md
//
// In Venediger stößt die Edge Function analysis-scheduler den Planer an. München hat keinen eigenen Scheduler in der
// Cloud – der Collector läuft ohnehin rund um die Uhr und hat den service_role-Key. Deshalb ruft er die Edge Function
// heizplaner-muenchen auf:
//   * alle 15 Minuten  aktion=planen
//   * täglich ab 03:00 aktion=lernen je Raum, dann pv_lernen, dann vergleich (gestern)
// Der Planer steuert nichts (Schattenbetrieb). Fällt er aus, läuft die Heizungssteuerung unverändert weiter.

export const PLAN_EVERY_MS = 15 * 60 * 1000;
export const LEARN_AT_MIN = 3 * 60;          // 03:00 Ortszeit
export const LEARN_WINDOW_MIN = 120;         // bis 05:00 nachholen, falls der Collector um 3 Uhr nicht lief

/** Ist jetzt ein Planungslauf fällig? */
export function planDue(nowMs, lastPlanMs) {
  return !lastPlanMs || nowMs - lastPlanMs >= PLAN_EVERY_MS - 30_000;
}

/** Ist heute (Ortszeit) das Lernen fällig? minutes = Minuten seit Mitternacht. */
export function learnDue({ today, minutes, lastLearnDay }) {
  return lastLearnDay !== today && minutes >= LEARN_AT_MIN && minutes < LEARN_AT_MIN + LEARN_WINDOW_MIN;
}

export class Planer {
  constructor({ url, key, log, timeoutMs = 120_000 }) {
    this.enabled = Boolean(url && key);
    this.endpoint = url ? `${url.replace(/\/$/, '')}/functions/v1/heizplaner-muenchen` : '';
    this.key = key;
    this.log = log;
    this.timeoutMs = timeoutMs;
    this.busy = false;
    this.lastPlanMs = 0;
    this.lastLearnDay = null;
    this.warned = false;
  }

  async call(body) {
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.key}`, apikey: this.key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`heizplaner-muenchen ${body.aktion}: ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  }

  /**
   * Einmal je Collector-Takt aufrufen. Wartet nicht auf den Planer (läuft im Hintergrund, nie zwei gleichzeitig).
   * rooms = aktive Räume (für das Lernen je Raum).
   */
  tick({ now, today, minutes, rooms }) {
    if (!this.enabled || this.busy) return;
    const learn = learnDue({ today, minutes, lastLearnDay: this.lastLearnDay });
    const plan = planDue(now.getTime(), this.lastPlanMs);
    if (!learn && !plan) return;
    this.busy = true;
    (async () => {
      try {
        if (learn) {
          this.lastLearnDay = today;
          let ok = 0;
          for (const r of rooms) {
            try { const x = await this.call({ aktion: 'lernen', raum: r.id }); if (x?.ok) ok += 1; } catch (e) { this.log(`Planer lernen ${r.name}: ${e.message}`); }
          }
          await this.call({ aktion: 'pv_lernen' }).catch((e) => this.log(`Planer pv_lernen: ${e.message}`));
          const v = await this.call({ aktion: 'vergleich' }).catch((e) => { this.log(`Planer vergleich: ${e.message}`); return null; });
          this.log(`Planer gelernt: ${ok}/${rooms.length} Räume${v?.ok ? `, Gegenrechnung ${v.tag}: Steuerung ${v.steuerung?.netz_kwh} kWh Netz, Planer ${v.planer?.netz_kwh} kWh` : ''}`);
        }
        if (plan) {
          this.lastPlanMs = now.getTime();
          const p = await this.call({ aktion: 'planen' });
          this.warned = false;
          if (p?.aus) return;
        }
      } catch (e) {
        if (!this.warned) {
          this.log(/404|not found/i.test(e.message)
            ? 'Hinweis: Edge Function heizplaner-muenchen fehlt – Anleitung doc/INBETRIEBNAHME.md, Abschnitt 16'
            : `Planer: ${e.message}`);
        }
        this.warned = true;
      } finally {
        this.busy = false;
      }
    })();
  }
}
