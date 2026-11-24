// Bestätigungsseite für die Alexa+-Kontoverknüpfung (24.11.2026, doc/ALEXA-PLUS.md)
// Die Alexa-App öffnet …/oauth/authorize des MCP-Servers; der leitet hierher weiter: /?alexa=<Anfrage-ID>.
// Uli ist in der App angemeldet und bestätigt mit einem Knopf. Danach geht es zurück zu Amazon.
import { useEffect, useState } from 'react';

const FN = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/mcp-heizung`;

export default function AlexaVerknuepfen({ session, id }) {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const headers = { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' };

  useEffect(() => {
    fetch(`${FN}/oauth/request?id=${encodeURIComponent(id)}`, { headers })
      .then((r) => r.json())
      .then(setInfo)
      .catch((e) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const entscheiden = async (erlauben) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`${FN}/oauth/approve`, { method: 'POST', headers, body: JSON.stringify({ id, erlauben }) });
      const j = await r.json();
      if (j.redirect) { window.location.href = j.redirect; return; }
      setError(j.error || `Fehler ${r.status}`);
    } catch (e) {
      setError(String(e));
    }
    setBusy(false);
  };

  return (
    <div className="login">
      <div className="card login-card">
        <div className="brand">
          <img className="brand-mark" src="/icon-192.png" alt="" />
          <div>
            <div className="brand-title">Alexa verknüpfen</div>
            <div className="muted small">Meine Heizung – München und Venediger</div>
          </div>
        </div>
        {!info && !error && <div className="muted">Prüfe die Anfrage …</div>}
        {info && !info.gueltig && <div className="alert">Diese Anfrage ist abgelaufen. Bitte die Verknüpfung in der Alexa-App neu starten.</div>}
        {info && info.gueltig && !info.erlaubt && (
          <div className="alert">Das Konto {info.email} ist für Alexa nicht freigegeben (Secret MCP_ALLOWED_EMAILS).</div>
        )}
        {info && info.gueltig && info.erlaubt && (
          <>
            <p>
              Alexa+ möchte auf beide Heizungen zugreifen: Temperaturen und Energie abfragen, Räume vorübergehend stellen,
              die Automatik in München schalten und in Venediger Abwesenheiten eintragen.
            </p>
            <p className="muted small">
              Angemeldet als {info.email}. Rücksprung zu {info.ziel}. Einstellungen, Testmodus und KI-Vorschläge bleiben in der App.
              Jeder Sprachbefehl steht im Protokoll unter „Alexa“.
            </p>
            <button className="btn primary" disabled={busy} onClick={() => entscheiden(true)}>Erlauben</button>
            <button className="btn" disabled={busy} onClick={() => entscheiden(false)}>Ablehnen</button>
          </>
        )}
        {error && <div className="alert">{error}</div>}
      </div>
    </div>
  );
}
