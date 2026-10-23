import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// PWA: Service Worker nur im Produktions-Build registrieren.
// Neue Version → Seite einmal neu laden, damit sofort die aktuelle App läuft.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      setInterval(() => reg.update(), 60 * 60 * 1000);
    }).catch(() => {});
    const hadController = Boolean(navigator.serviceWorker.controller);
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloaded) return; // erster Besuch: kein Neuladen nötig
      reloaded = true;
      window.location.reload();
    });
  });
}
