// Service Worker – Heizung München
// - App-Hülle (index.html): erst Netz, bei fehlendem Netz aus dem Cache
// - Gebaute Dateien (/assets/…, Icons): aus dem Cache, sonst Netz
// - Supabase und alle fremden Adressen werden NIE gecacht (immer Live-Daten)
// - Ohne Netz und ohne gespeicherte Hülle: offline.html (wie Heizung Venediger, 12.11.2026)
// - __BUILD__ ersetzt vite.config.js beim Bauen durch die Build-Kennung → jede neue Version bekommt einen
//   eigenen Cache, alte Programmdateien werden beim Aktivieren gelöscht (12.11.2026)
const CACHE = 'heizung-__BUILD__';
const SHELL = ['/', '/offline.html', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('heizung-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Supabase & Co.: nicht anfassen

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('/', copy));
          return res;
        })
        .catch(async () => (await caches.match('/')) || caches.match('/offline.html')),
    );
    return;
  }

  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok && (url.pathname.startsWith('/assets/') || url.pathname.endsWith('.png'))) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    })),
  );
});
