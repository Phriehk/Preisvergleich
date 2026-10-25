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

// pdf.js für das Einlesen von Prospekten (die Seite lädt es von jsDelivr; im Test kommt es aus node_modules)
export const PDFJS_DIR = [process.env.PDFJS_DIR, path.join(wurzel, "node_modules/pdfjs-dist"), "/opt/npm-tools/node_modules/pdfjs-dist"].filter(Boolean).find(d => fs.existsSync(path.join(d, "build/pdf.min.mjs")));

/** Ein kleines PDF mit Textebene (Helvetica, WinAnsi): seiten = [[{s, x, y (Grundlinie von oben), h, fett}]] */
export function pdfMachen(seiten, { breite = 560, hoehe = 800 } = {}) {
  const obj = [], esc = t => t.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  obj[1] = "<</Type/Catalog/Pages 2 0 R>>";
  obj[3] = "<</Type/Font/Subtype/Type1/BaseFont/Helvetica-Bold/Encoding/WinAnsiEncoding>>";
  obj[4] = "<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>";
  const kids = [];
  seiten.forEach((l, i) => {
    const inhalt = l.map(t => `BT /${t.fett ? "F1" : "F2"} ${t.h} Tf 1 0 0 1 ${t.x} ${hoehe - t.y} Tm (${esc(t.s)}) Tj ET`).join("\n");
    const n = 5 + i * 2;
    obj[n] = `<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${breite} ${hoehe}]/Resources<</Font<</F1 3 0 R/F2 4 0 R>>>>/Contents ${n + 1} 0 R>>`;
    obj[n + 1] = `<</Length ${Buffer.byteLength(inhalt, "latin1")}>>\nstream\n${inhalt}\nendstream`;
    kids.push(`${n} 0 R`);
  });
  obj[2] = `<</Type/Pages/Kids[${kids.join(" ")}]/Count ${kids.length}>>`;
  let out = "%PDF-1.4\n", lage = [];
  for (let i = 1; i < obj.length; i++) { lage[i] = Buffer.byteLength(out, "latin1"); out += `${i} 0 obj\n${obj[i]}\nendobj\n`; }
  const x = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${obj.length}\n0000000000 65535 f \n` + lage.slice(1).map(o => String(o).padStart(10, "0") + " 00000 n \n").join("") + `trailer\n<</Size ${obj.length}/Root 1 0 R>>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** Antwort von Google Cloud Vision für einen Bon: Namen links, Preise rechts (Google liefert sie spaltenweise), leicht schräg */
export function visionAntwort(zeilen, { schraeg = 0.03 } = {}) {   // zeilen: "NAME|PREIS" (Preis in der rechten Spalte) oder "TEXT"
  const woerter = [];
  zeilen.forEach((z, i) => z.split("|").forEach((sp, k) => {
    let x = k ? 600 : 40;
    for (const w of sp.trim().split(/\s+/).filter(Boolean)) {
      const breite = w.length * 18, y = 100 + i * 50 + x * schraeg;
      woerter.push({ description: w, boundingPoly: { vertices: [{ x, y }, { x: x + breite, y: y + breite * schraeg }, { x: x + breite, y: y + 30 + breite * schraeg }, { x, y: y + 30 }] } });
      x += breite + 14;
    }
  }));
  // spaltenweise wie bei Google: erst alles links, dann alles rechts
  woerter.sort((a, b) => (a.boundingPoly.vertices[0].x >= 600) - (b.boundingPoly.vertices[0].x >= 600));
  return { responses: [{ textAnnotations: [{ description: woerter.map(w => w.description).join("\n") }, ...woerter] }] };
}

/** Prospektseite wie bei Netto: Name fett, Beschreibung, Menge, Grundpreis links; rechts groß der Preis, klein UVP bzw. statt, darüber die Prozente */
export function prospektSeiten(markt = "PENNY", von = new Date()) {
  const d = x => { const t = new Date(von.getTime() + x * 864e5); return `${t.getDate()}.${t.getMonth() + 1}.`; };
  const preis = (x, y, ganz, cent, klein, uvp, proz) => [{ s: ganz + ".", x, y, h: 37, fett: true }, { s: cent, x: x + 24, y: y - 11, h: 21.6, fett: true },
    ...(uvp ? [{ s: "UVP", x: x + 20, y: y + 7, h: 8, fett: true }] : []), ...(klein ? [{ s: klein, x: x + 42, y: y + 7, h: 8, fett: true }] : []), ...(proz ? [{ s: proz, x: x + 1, y: y - 34, h: 19.8, fett: true }] : [])];
  const block = (x, y, zeilen) => zeilen.map((z, i) => ({ s: z, x, y: y + i * 10, h: i ? 7.5 : 9, fett: !i }));
  return [[
    { s: `Montag ${d(0)} - Samstag ${d(5)}${String(von.getFullYear()).slice(2)}`, x: 160, y: 25, h: 16, fett: true },
    ...block(26, 110, ["Weihenstephan Butter", "mildgesäuert", "250 g", "(9.96 / kg)"]), ...preis(130, 131, "2", "49", "", false, ""),
    ...block(26, 300, ["Weihenstephan Butter", "gesalzen, gekühlt", "250 g", "(7.16 / kg)"]), ...preis(130, 321, "1", "79", "2.49", false, "-28%"),
    ...block(300, 300, ["Milka Schokolade", "versch. Sorten", "100 g", "(9.50 / kg)"]), ...preis(400, 321, "0", "95", "1.99", true, "-52%"),
    ...block(26, 500, ["Zewa Toilettenpapier", "Ultrasoft 4-lagig", "16 x 150 Blatt"]), ...preis(130, 521, "6", "99", "8.39", true, "-17%"),
    { s: `${markt} Markt GmbH, Artikel mit diesem Hinweis gibt es solange der Vorrat reicht.`, x: 20, y: 780, h: 6 },
  ]];
}

export function playwright() {
  try { return require("playwright"); } catch (e) { return null; }
}

const V = [{ from: "2026-10-19T00:00:00Z", to: "2099-10-25T21:59:00Z" }];
let nr = 100;
const RID = { "ALDI SÜD": 127153, PENNY: 126765, REWE: 126802, Lidl: 126679, Kaufland: 126654, OBI: 126750, "dm-drogerie markt": 127057 };
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

/* Web-Push wie ein Browser: eigenes Schlüsselpaar und Geheimnis, damit die Nachricht entschlüsselt werden kann (RFC 8291) */
const b64u = b => Buffer.from(b).toString("base64url");
const verbindeB = (...l) => new Uint8Array(Buffer.concat(l.map(x => Buffer.from(x))));
async function hkdfT(salt, ikm, info, n) {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, n * 8));
}
export async function geraet() {
  const k = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", k.publicKey)), auth = crypto.getRandomValues(new Uint8Array(16));
  return { k, pub, auth, abo: { endpoint: "https://push.example/" + b64u(auth), keys: { p256dh: b64u(pub), auth: b64u(auth) } } };
}
export async function entschluesseln(g, body) {
  body = new Uint8Array(body);
  const salz = body.slice(0, 16), rs = new DataView(body.buffer, body.byteOffset).getUint32(16), idlen = body[20], serverPub = body.slice(21, 21 + idlen), chiffre = body.slice(21 + idlen);
  if (rs !== 4096 || idlen !== 65) throw new Error("Kopf der Push-Nachricht stimmt nicht");
  const sk = await crypto.subtle.importKey("raw", serverPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const geheim = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: sk }, g.k.privateKey, 256));
  const ikm = await hkdfT(g.auth, geheim, verbindeB(Buffer.from("WebPush: info\0"), g.pub, serverPub), 32);
  const cek = await hkdfT(salz, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16), nonce = await hkdfT(salz, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);
  const k = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const klar = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, k, chiffre));
  if (klar[klar.length - 1] !== 2) throw new Error("Trennzeichen für den letzten Datensatz fehlt");
  return JSON.parse(Buffer.from(klar.slice(0, -1)).toString("utf8"));
}

/** Umgebung: Speicher, Marktguru-Nachbau, Push-Protokoll; opts.geraet: ein Gerät für Mitteilungen anmelden (u.mitteilungen() entschlüsselt, was ankam) */
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
  const env = { PV: KV, ZUGANG: "betreiber", ASSETS, ...(opts.vision ? { GOOGLE_VISION_KEY: "vision-schluessel" } : {}) };
  const ctx = { exports: { Teil: new W.Teil({}, env) }, waitUntil() {} };
  const ntfy = [], push = [], pennyAbrufe = [], vision = []; push.status = 201;
  globalThis.fetch = async (u, o) => {
    u = String(u);
    if (u === "https://www.marktguru.de") return new Response('..."apiKey":"k","clientKey":"c"...');
    if (u.startsWith("https://ntfy.sh")) { ntfy.push(o.body); return new Response("{}"); }   // darf nicht mehr vorkommen
    if (u.startsWith("https://push.example/")) { push.push({ url: u, headers: o.headers, body: o.body }); return new Response("", { status: push.status }); }   // Push-Dienst (Web-Push)
    if (u.startsWith("https://api.marktguru.de/api/v1/offers/publishers")) {   // Märkte der Gegend
      const m = new Map(), zip = new URL(u).searchParams.get("zipCode");
      // opts.nurPlz: Markt nur in dieser Postleitzahl; opts.verlagOhne: Märkte, die Marktguru gerade nicht nennt (ihre Angebote findet die Suche trotzdem)
      Object.values(opts.daten || DATEN).flat().forEach(o => { const n = o.advertisers[0].name; if (!(opts.verlagOhne && opts.verlagOhne.has(n)) && (!(opts.nurPlz || {})[n] || opts.nurPlz[n] === zip)) m.set(o.advertisers[0].id, n); });
      return new Response(JSON.stringify({ totalResults: m.size, results: [...m].map(([id, name]) => ({ id, name, uniqueName: name.toLowerCase(), offers: [] })) }));
    }
    if (u.startsWith("https://api.marktguru.de") && new URL(u).searchParams.get("retailers")) {   // alle Angebote eines Marktes
      const q = new URL(u).searchParams, l = Object.values(opts.daten || DATEN).flat().filter(o => o.advertisers[0].id === "retailers/" + q.get("retailers") && (!(opts.nurPlz || {})[o.advertisers[0].name] || opts.nurPlz[o.advertisers[0].name] === q.get("zipCode")));
      return new Response(JSON.stringify({ totalResults: l.length, results: l.slice(+q.get("offset"), +q.get("offset") + +q.get("limit")) }));
    }
    if (u.startsWith("https://api.marktguru.de")) { const q = new URL(u).searchParams, nur = opts.nurPlz || {}; return new Response(JSON.stringify({ results: q.get("offset") === "0" ? ((opts.daten || DATEN)[q.get("q").toLowerCase()] || []).filter(o => !nur[o.advertisers[0].name] || nur[o.advertisers[0].name] === q.get("zipCode")) : [] })); }
    if (u.startsWith("https://vision.googleapis.com/")) {   // Google Cloud Vision nachgebaut: opts.vision = Antwort (oder Funktion), vision.status für Fehler
      vision.push({ url: u, body: o.body });
      if (vision.status) return new Response('{"error":{"message":"API key not valid"}}', { status: vision.status });
      return new Response(JSON.stringify(typeof opts.vision === "function" ? opts.vision(o.body) : opts.vision));
    }
    if (opts.penny && u.startsWith("https://www.penny.de/")) {   // penny.de nachgebaut: Kategorien der Woche 2026-44, Verkaufsregion eines Marktes
      const q = new URL(u), m = q.pathname.match(/^\/\.rest\/offers\/by-category\/([^/]+)\/([^/]+)$/);
      if (q.pathname === "/angebote") return new Response(`<div data-current-week="2026-44" data-next-week="2026-45">${Object.keys(opts.penny).map(k => `<section data-category-name="${k}"></section>`).join("")}</div>`);
      if (q.pathname.startsWith("/.rest/market/markets/market_")) return new Response(JSON.stringify({ wwIdent: q.pathname.split("_").pop(), sellingRegion: "15A-09-33", nextWeekSellingRegion: "" }));
      if (m) { pennyAbrufe.push(u); return new Response(JSON.stringify({ offerTiles: m[1] === "2026-44" ? opts.penny[decodeURIComponent(m[2])] || [] : [] })); }
    }
    return new Response("nf", { status: 404 });
  };
  const A = (p, m = "GET", b) => H.fetch(new Request("https://preise.phriehk.workers.dev" + p, { method: m, headers: { Authorization: "Bearer betreiber", "Content-Type": "application/json" }, body: b }), env, ctx);
  let g = null;
  if (opts.geraet) { g = await geraet(); await A("/push/abo", "POST", JSON.stringify({ ...g.abo, geraet: "Test-iPhone" })); }
  const mitteilungen = async () => Promise.all(push.filter(x => g && x.url === g.abo.endpoint).map(x => entschluesseln(g, x.body)));
  return { H, env, ctx, KV, store, A, ntfy, push, pennyAbrufe, vision, mitteilungen };
}

/** Browser mit der echten Seite; alle Anfragen an die Worker-Adresse gehen an den echten Worker-Code */
export async function browserStarten(u, { breite = 390, hoehe = 844, code = "betreiber" } = {}) {
  const pw = playwright();
  const b = await pw.chromium.launch();
  const c = await b.newContext({ viewport: { width: breite, height: hoehe }, serviceWorkers: "block" });   // ein Service Worker würde an page.route vorbei ins echte Netz gehen
  await c.addInitScript(([cd]) => { localStorage.setItem("pv-ort", JSON.stringify({ lat: 51.40, lon: 6.70, name: "Test 1, Duisburg", plz: "47178", angebote: true })); if (cd) localStorage.setItem("pv-code", cd); }, [code]);
  await c.route("**/*", r => r.abort());   // alles, was nicht nachgebaut ist, scheitert (kein Zugriff aufs echte Netz)
  if (PDFJS_DIR) await c.route("https://cdn.jsdelivr.net/npm/pdfjs-dist@*/build/*", r => {   // pdf.js aus node_modules (auch für den Hintergrund-Worker)
    const datei = path.join(PDFJS_DIR, "build", path.basename(new URL(r.request().url()).pathname));
    if (!fs.existsSync(datei)) return r.fulfill({ status: 404, body: "" });
    return r.fulfill({ body: fs.readFileSync(datei), headers: { "content-type": "text/javascript", "access-control-allow-origin": "*" } });
  });
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
