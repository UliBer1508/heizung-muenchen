// Auto-Steuerung › Verlauf und Wirkung: lädt muc_energie_stunde / muc_energie_tag (migration-014) und die genehmigten
// KI-Vorschläge. Übernommen aus Heizung Venediger (src/components/ki/VerlaufView.tsx, Commit bf8d3a7).
import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../supabase.js';
import { VerlaufAnsicht } from './VerlaufAnsicht.jsx';
import { bereich, heuteOrt, vergleichAnker, verschieben, ortMs } from './zeit.js';

const ST = 'stunde, pv_kwh, verbrauch_kwh, heizung_kwh, auto_kwh, haus_kwh, netz_kwh, einspeisung_kwh, soc_ende';
const fmtWert = (v) => (v == null ? '–' : Number(v).toLocaleString('de-DE', { maximumFractionDigits: 1 }));

async function stundenLaden(von, bis) {
  const { data } = await supabase.from('muc_energie_stunde').select(ST)
    .gte('stunde', new Date(ortMs(von)).toISOString()).lt('stunde', new Date(ortMs(bis)).toISOString()).order('stunde').limit(1000);
  return data ?? [];
}

export default function Verlauf({ settings }) {
  const [periode, setPeriode] = useState('woche');
  const [anker, setAnker] = useState(heuteOrt());
  const [vergleich, setVergleich] = useState('vor');
  const [alleTage, setAlleTage] = useState([]);
  const [vorschlaege, setVorschlaege] = useState([]);
  const [stunden, setStunden] = useState([]);
  const [vglStunden, setVglStunden] = useState([]);
  const [fehler, setFehler] = useState(null);

  const b = useMemo(() => bereich(periode, anker), [periode, anker]);
  const va = vergleichAnker(periode, anker, periode === 'jahr' && vergleich === 'vorjahr' ? 'vor' : vergleich);
  const vb = useMemo(() => (va ? bereich(periode, va) : null), [periode, va]);
  const stuendlich = periode === 'tag' || periode === 'woche';

  // Tageswerte (alle – ein Jahr sind 365 Zeilen) und KI-Vorschläge einmal laden, alle 15 min neu
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const [t, k] = await Promise.all([
        supabase.from('muc_energie_tag').select('*').order('tag').limit(5000),
        supabase.from('muc_ki_suggestions').select('decided_at, title, old_value, decided_value')
          .eq('kind', 'vorschlag').in('status', ['genehmigt', 'geaendert']).order('decided_at'),
      ]);
      if (!alive) return;
      if (t.error) setFehler(/muc_energie_tag/.test(t.error.message) ? 'Bitte supabase/migration-014-auto-steuerung.sql ausführen.' : t.error.message);
      setAlleTage(t.data ?? []);
      setVorschlaege((k.data ?? []).filter((x) => x.decided_at).map((x) => ({
        ts: Math.floor(Date.parse(x.decided_at) / 1000), titel: String(x.title ?? '').replace(/\?$/, ''),
        wert: `${fmtWert(x.old_value)} → ${fmtWert(x.decided_value)} °C`,
      })));
    };
    load();
    const id = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 15 * 60_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  // Stundenwerte nur für Tag und Woche
  useEffect(() => {
    let alive = true;
    if (!stuendlich) { setStunden([]); setVglStunden([]); return undefined; }
    (async () => {
      const [a, v] = await Promise.all([stundenLaden(b.von, b.bis), vb ? stundenLaden(vb.von, vb.bis) : Promise.resolve([])]);
      if (alive) { setStunden(a); setVglStunden(v); }
    })();
    return () => { alive = false; };
  }, [stuendlich, b.von, b.bis, vb?.von, vb?.bis]); // eslint-disable-line react-hooks/exhaustive-deps

  if (fehler) return <div className="alert">{fehler}</div>;
  const tage = alleTage.filter((t) => t.tag >= b.von && t.tag < b.bis);
  const vglTage = vb ? alleTage.filter((t) => t.tag >= vb.von && t.tag < vb.bis) : [];
  const naechster = verschieben(periode, anker, 1);
  return (
    <VerlaufAnsicht periode={periode} setPeriode={setPeriode} titel={b.titel}
      zurueck={() => setAnker(verschieben(periode, anker, -1))}
      vor={bereich(periode, naechster).von <= heuteOrt() ? () => setAnker(naechster) : null}
      vergleich={periode === 'jahr' && vergleich === 'vorjahr' ? 'vor' : vergleich} setVergleich={setVergleich} vglTitel={vb?.titel ?? ''}
      stunden={stunden} vglStunden={vglStunden} tage={tage} vglTage={vglTage} alleTage={alleTage} ersterTag={alleTage[0]?.tag ?? null}
      vorschlaege={vorschlaege} vonMs={ortMs(b.von)} bisMs={ortMs(b.bis)} vglVonMs={vb ? ortMs(vb.von) : null}
      battKwh={Number(settings?.battery_kwh) || 10} />
  );
}
