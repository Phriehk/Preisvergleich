// Gemeinsame Helfer für die Browser-Tests: echter Worker-Code (Speicher im Arbeitsspeicher, Marktguru nachgebaut) und die echte Seite.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const hier = path.dirname(fileURLToPath(import.meta.url));
export const wurzel = path.resolve(hier, "../..");
const require = createRequire(import.meta.url);

export async function ladeWorker() {
  const q = fs.readFileSync(path.join(wurzel, "worker/src/index.js"), "utf8")
    .replace(/^import \{ WorkerEntrypoint \} from "cloudflare:workers";/m, "class WorkerEntrypoint{constructor(ctx,env){this.ctx=ctx;this.env=env}}");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pv-worker-"));
  const datei = path.join(dir, "w.mjs");
  fs.writeFileSync(datei, q);
  return await import(pathToFileURL(datei).href);
}

export function playwright() {
  try { return require("playwright"); } catch (e) { return null; }
}

const V = [{ from: "2026-10-19T00:00:00Z", to: "2099-10-25T21:59:00Z" }];
let nr = 100;
const RID = { "ALDI SÜD": 127153, PENNY: 126765, REWE: 126802, Lidl: 126679, Kaufland: 126654 };
export const O = (adv, name, brand, desc, price, unit, volume, quantity, oldPrice) => ({ id: ++nr, oldPrice, url: "https://www.marktguru.de/offers/" + nr, advertisers: [{ id: "retailers/" + RID[adv], name: adv }], product: { name }, brand: { name: brand }, description: desc, price, unit: unit ? { shortName: unit } : undefined, volume, quantity, validityDates: V });
export const DATEN = {
  butter: [O("ALDI SÜD", "Butter", "Kerrygold", "250-g-Packung", 1.99), O("PENNY", "Butter", "Weihenstephan", "250 g", 1.79, "g", 250, 1), O("REWE", "Butter", "Milram", "2 x 250 g", 3.49), O("Lidl", "Erdnussbutter", "Skippy", "350 g", 3.99)],
  eier: [O("Kaufland", "Freilandeier", "", "10 Stück", 2.39), O("ALDI SÜD", "Freiland-Eier", "", "10 Stück, Größe M", 2.29), O("PENNY", "Eier", "", "6er Packung", 1.49)],
  milch: [O("PENNY", "Milch", "Weihenstephan", "1 l", 0.95, "l", 1, 1), O("Lidl", "Milch", "Milbona", "1 l", 0.89, "l", 1, 1, 1.09), O("Kaufland", "Milch", "K-Classic", "1 l", 1.05, "l", 1, 1)],
  "äpfel": [O("PENNY", "Äpfel", "", "lose", 1.99, "kg"), O("ALDI SÜD", "Äpfel", "", "1,5-kg-Beutel", 2.49)],
  reis: [O("Lidl", "Basmati Reis", "Tilda", "1 kg", 1.99), O("ALDI SÜD", "Reis", "", "500 g", 0.89)],
  akkuschrauber: [O("Lidl", "Akkuschrauber", "Parkside", "12 V, mit Akku", 29.99)],
};
// Kategorien wie bei Marktguru (Elternkategorie 107 = Molkereiprodukte, 149 = Obst, 116 = Reis, 382 = Elektrowerkzeug)
const KAT = { butter: [102, "Butter", 107], eier: [104, "Eier", 107], milch: [101, "Milch", 107], "äpfel": [300, "Äpfel", 149], reis: [400, "Reis", 116], akkuschrauber: [500, "Akkuschrauber", 382] };
for (const [k, l] of Object.entries(DATEN)) for (const o of l) o.categories = [{ id: KAT[k][0], name: KAT[k][1], parentId: KAT[k][2] }];

/** Umgebung: Speicher, Marktguru-Nachbau, ntfy-Protokoll */
export async function umgebung(opts = {}) {
  const W = await ladeWorker(), H = W.default;
  const store = new Map();
  const KV = { async get(k, t) { const v = store.get(k); return v == null ? null : t === "json" ? JSON.parse(v) : v; }, async put(k, v) { store.set(k, v); }, async delete(k) { store.delete(k); } };
  const TYPEN = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".webmanifest": "application/manifest+json", ".png": "image/png" };
  const ASSETS = { fetch: async r => {   // wie bei Cloudflare: Dateien aus dem Ordner der Seite
    const p = new URL(r.url).pathname, datei = path.join(wurzel, p === "/" ? "index.html" : p.replace(/^\/+/, ""));
    if (!datei.startsWith(wurzel) || !fs.existsSync(datei) || fs.statSync(datei).isDirectory()) return new Response("Nicht gefunden", { status: 404 });
    return new Response(fs.readFileSync(datei), { headers: { "content-type": TYPEN[path.extname(datei)] || "application/octet-stream" } });
  } };
  const env = { PV: KV, ZUGANG: "betreiber", NTFY_TOPIC: opts.ntfy ? "test" : undefined, ASSETS };
  const ctx = { exports: { Teil: new W.Teil({}, env) }, waitUntil() {} };
  const ntfy = [], push = [], pennyAbrufe = []; push.status = 201;
  globalThis.fetch = async (u, o) => {
    u = String(u);
    if (u === "https://www.marktguru.de") return new Response('..."apiKey":"k","clientKey":"c"...');
    if (u === "https://ntfy.sh") { ntfy.push(JSON.parse(o.body)); return new Response("{}"); }
    if (u.startsWith("https://push.example/")) { push.push({ url: u, headers: o.headers, body: o.body }); return new Response("", { status: push.status }); }   // Push-Dienst (Web-Push)
    if (u.startsWith("https://api.marktguru.de/api/v1/offers/publishers")) {   // Märkte der Gegend
      const m = new Map(); Object.values(opts.daten || DATEN).flat().forEach(o => m.set(o.advertisers[0].id, o.advertisers[0].name));
      return new Response(JSON.stringify({ totalResults: m.size, results: [...m].map(([id, name]) => ({ id, name, uniqueName: name.toLowerCase(), offers: [] })) }));
    }
    if (u.startsWith("https://api.marktguru.de") && new URL(u).searchParams.get("retailers")) {   // alle Angebote eines Marktes
      const q = new URL(u).searchParams, l = Object.values(opts.daten || DATEN).flat().filter(o => o.advertisers[0].id === "retailers/" + q.get("retailers"));
      return new Response(JSON.stringify({ totalResults: l.length, results: l.slice(+q.get("offset"), +q.get("offset") + +q.get("limit")) }));
    }
    if (u.startsWith("https://api.marktguru.de")) { const q = new URL(u).searchParams; return new Response(JSON.stringify({ results: q.get("offset") === "0" ? (opts.daten || DATEN)[q.get("q").toLowerCase()] || [] : [] })); }
    if (opts.penny && u.startsWith("https://www.penny.de/")) {   // penny.de nachgebaut: Kategorien der Woche 2026-44, Verkaufsregion eines Marktes
      const q = new URL(u), m = q.pathname.match(/^\/\.rest\/offers\/by-category\/([^/]+)\/([^/]+)$/);
      if (q.pathname === "/angebote") return new Response(`<div data-current-week="2026-44" data-next-week="2026-45">${Object.keys(opts.penny).map(k => `<section data-category-name="${k}"></section>`).join("")}</div>`);
      if (q.pathname.startsWith("/.rest/market/markets/market_")) return new Response(JSON.stringify({ wwIdent: q.pathname.split("_").pop(), sellingRegion: "15A-09-33", nextWeekSellingRegion: "" }));
      if (m) { pennyAbrufe.push(u); return new Response(JSON.stringify({ offerTiles: m[1] === "2026-44" ? opts.penny[decodeURIComponent(m[2])] || [] : [] })); }
    }
    return new Response("nf", { status: 404 });
  };
  const A = (p, m = "GET", b) => H.fetch(new Request("https://preise.phriehk.workers.dev" + p, { method: m, headers: { Authorization: "Bearer betreiber", "Content-Type": "application/json" }, body: b }), env, ctx);
  return { H, env, ctx, KV, store, A, ntfy, push, pennyAbrufe };
}

/** Browser mit der echten Seite; alle Anfragen an die Worker-Adresse gehen an den echten Worker-Code */
export async function browserStarten(u, { breite = 390, hoehe = 844, code = "betreiber" } = {}) {
  const pw = playwright();
  const b = await pw.chromium.launch();
  const c = await b.newContext({ viewport: { width: breite, height: hoehe }, serviceWorkers: "block" });   // ein Service Worker würde an page.route vorbei ins echte Netz gehen
  await c.addInitScript(([cd]) => { localStorage.setItem("pv-ort", JSON.stringify({ lat: 51.40, lon: 6.70, name: "Test 1, Duisburg", plz: "47178", angebote: true })); if (cd) localStorage.setItem("pv-code", cd); }, [code]);
  await c.route("**/*", r => r.abort());   // alles, was nicht nachgebaut ist, scheitert (kein Zugriff aufs echte Netz)
  const p = await c.newPage();
  const fehler = [];
  p.on("pageerror", e => fehler.push(e.message));
  await p.route("https://fonts.googleapis.com/**", r => r.fulfill({ body: "" }));
  await p.route("https://nominatim.openstreetmap.org/**", r => r.fulfill({ body: "[]", headers: { "access-control-allow-origin": "*", "content-type": "application/json" } }));
  await p.route("https://router.project-osrm.org/**", r => r.abort());
  await p.route("https://preise.phriehk.workers.dev/**", async r => {
    const q = r.request();
    const resp = await u.H.fetch(new Request(q.url(), { method: q.method(), headers: q.headers(), body: q.postData() || undefined }), u.env, u.ctx);
    await r.fulfill({ status: resp.status, headers: Object.fromEntries(resp.headers), body: Buffer.from(await resp.arrayBuffer()) });
  });
  return { b, c, p, fehler, oeffnen: async (hash = "") => { await p.goto("https://preise.phriehk.workers.dev/" + hash); await p.waitForTimeout(1500); } };
}
