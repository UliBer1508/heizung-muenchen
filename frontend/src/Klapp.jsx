// Klappbare Abschnitte (12.11.2026, Uli: „alle Seiten klappbar“ – wie Heizung Venediger).
// Auf/zu merkt sich je Gerät (localStorage, darf fehlen). Nutzt die vorhandenen Klassen collapse-head / collapse-chev.
import { useState } from 'react';

const lesen = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const schreiben = (k, v) => { try { localStorage.setItem(k, v); } catch { /* ohne Speicher: nur für diese Sitzung */ } };

export function useAufZu(id, standardAuf = true) {
  const key = `zu:${id}`;
  const [auf, setAuf] = useState(() => {
    const v = lesen(key);
    return v == null ? standardAuf : v !== '1';
  });
  const umschalten = () => setAuf((a) => { schreiben(key, a ? '1' : '0'); return !a; });
  return [auf, umschalten];
}

// Karte mit Überschrift als Klapp-Knopf. sum = Kurzinfo, wenn zugeklappt.
export function Klappkarte({ id, titel, sub, sum, rechts, className = 'card', standardAuf = true, children }) {
  const [auf, umschalten] = useAufZu(id, standardAuf);
  return (
    <section className={className}>
      <div className="klapp-row">
        <button type="button" className="collapse-head" onClick={umschalten} aria-expanded={auf}>
          <span className="section-title">{titel}{sub && <span className="plan-sub">{sub}</span>}</span>
          <span className="collapse-sum">{auf ? '' : sum}</span>
          <span className={`collapse-chev ${auf ? 'open' : ''}`} aria-hidden="true">▶</span>
        </button>
        {rechts}
      </div>
      {auf && children}
    </section>
  );
}
