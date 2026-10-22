// Offline-Hilfe: Die Seite selbst kommt nach spätestens 2,5 Sekunden aus dem Speicher, wenn das Netz hängt (z. B. im Markt);
// sie wird trotzdem im Hintergrund aktualisiert. Abfragen an den Server gehen zuerst ins Netz, ohne Netz kommt die letzte Antwort.
const CACHE = "pv-v2";
const SEITE = ["./", "manifest.webmanifest", "icon-192.png", "apple-touch-icon.png"];
self.addEventListener("install", e => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then(c => c.addAll(SEITE)).catch(() => {})); });
self.addEventListener("activate", e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())
));
const istSeite = (req, u) => req.mode === "navigate" || /\.(html|png|webmanifest|svg|ico)$/.test(u.pathname);
async function seite(e, u) {
  const c = await caches.open(CACHE), key = e.request.mode === "navigate" ? new Request(new URL("./", self.registration.scope)) : e.request;
  const alt = await c.match(key);
  const netz = fetch(e.request).then(r => { if (r.ok) c.put(key, r.clone()); return r; });
  if (!alt) return netz;
  e.waitUntil(netz.catch(() => {}));
  const frist = new Promise(res => setTimeout(() => res(null), 2500));
  return (await Promise.race([netz.catch(() => null), frist])) || alt;
}
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return;   // fremde Seiten und Bilder nicht anfassen
  if (istSeite(e.request, u)) { e.respondWith(seite(e, u)); return; }
  e.respondWith(
    fetch(e.request).then(r => { if (r.ok) { const k = r.clone(); caches.open(CACHE).then(c => c.put(e.request, k)); } return r; })
      .catch(() => caches.match(e.request).then(r => r || Response.error()))
  );
});
