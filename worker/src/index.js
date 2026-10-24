// Preisvergleich-Server bei Cloudflare: fragt Marktguru direkt ab (Suche, tägliche Aktualisierung, Preisalarm per Web-Push und ntfy).
// Gleiche Logik wie test_marktguru.py. Jede Teilabfrage (ein Suchbegriff in einer Postleitzahl) läuft als eigener
// Aufruf, damit die Grenzen des kostenlosen Tarifs (10 ms Rechenzeit, 50 Abrufe je Aufruf) eingehalten werden.
import { WorkerEntrypoint } from "cloudflare:workers";

const APP_URL = "https://preise.phriehk.workers.dev/";
const UA = { "User-Agent": "Mozilla/5.0 (privates Testprojekt)" };
const SEARCH = "https://api.marktguru.de/api/v1/offers/search";
const PLZ = "47178", PLZ2 = "46535", PLZ2_MAERKTE = ["penny", "thomas philipps"], PLZ3 = "47053", PLZ3_MAERKTE = ["rewe"];
const SUCHEN = { "Coca-Cola": ["Coca-Cola", "Coca Cola", "Cola"], "Red Bull": ["Red Bull"], "Monster Energy": ["Monster Energy", "Monster"] };
const KW = { "Coca-Cola": ["coca"], "Red Bull": ["red bull", "redbull"], "Monster Energy": ["monster energy"] };
const AUSSCHLUSS = ["munch", "mash"];
const START_FAVS = [{ name: "Coca-Cola", aus: "" }, { name: "Red Bull", aus: "" }, { name: "Monster Energy", aus: "" }];
const GLEICHZEITIG = 4;

/* ---------- Hilfen ---------- */
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS", "Access-Control-Allow-Headers": "Authorization,Content-Type,X-Wartung", "Access-Control-Max-Age": "86400" };
const antwort = (body, typ = "application/json; charset=utf-8", status = 200) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": typ, "Cache-Control": "no-store" } });
const fehler = (text, status = 500) => antwort({ fehler: text }, undefined, status);
const schlaf = ms => new Promise(r => setTimeout(r, ms));
const berlin = (d, mitZeit) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}` + (mitZeit ? `T${p.hour}:${p.minute}` : "");
};
const heute = () => berlin(new Date());
const tageBis = iso => Math.round((Date.parse(iso + "T00:00:00Z") - Date.parse(heute() + "T00:00:00Z")) / 864e5);

async function http(url, headers, versuche = 3) {
  for (let i = 0; ; i++) {
    const r = await fetch(url, { headers: { ...UA, ...(headers || {}) } });
    if (r.ok) return r;
    if ([429, 500, 502, 503, 504].includes(r.status) && i < versuche - 1) { await schlaf(2000 * (i + 1)); continue; }
    const e = new Error(`HTTP ${r.status} bei ${url.split("?")[0]}`); e.status = r.status; throw e;
  }
}

/* ---------- Marktguru-Schlüssel (von der Webseite, einen Tag zwischengespeichert) ---------- */
let schluesselHolen = null;   // mehrere gleichzeitige Abfragen teilen sich eine Erneuerung des Schlüssels
async function schluessel(env, neu) {
  if (!neu) { const k = await env.PV.get("keys", "json"); if (k && Date.now() - k.t < 864e5) return k; }
  if (!schluesselHolen) schluesselHolen = (async () => {
    try {
      const html = await (await http("https://www.marktguru.de")).text();
      const api = html.match(/"apiKey"\s*:\s*"([^"]+)"/), client = html.match(/"clientKey"\s*:\s*"([^"]+)"/);
      if (!api || !client) throw new Error("Schlüssel auf marktguru.de nicht gefunden - die Seite hat sich vermutlich geändert.");
      const k = { api: api[1], client: client[1], t: Date.now() };
      await env.PV.put("keys", JSON.stringify(k));
      return k;
    } finally { schluesselHolen = null; }
  })();
  return schluesselHolen;
}

/* ---------- Mengen ---------- */
const EINHEIT = "(milliliter|ml|centiliter|cl|liter|ltr|l)";
const TEILER = { milliliter: 1000, ml: 1000, centiliter: 100, cl: 100 };
const RE1 = new RegExp("(\\d+)\\s*[x×]\\s*(\\d+(?:\\.\\d+)?)\\s*-?\\s*" + EINHEIT + "\\b"), RE2 = new RegExp("(\\d+(?:\\.\\d+)?)\\s*-?\\s*" + EINHEIT + "\\b");
function menge(text) {
  let t = (text || "").toLowerCase().replace(/,/g, ".").replace(/(\d)\s*i\b/g, "$1 l");
  let m = t.match(RE1), n, v, u;
  if (m) { n = +m[1]; v = +m[2]; u = m[3]; } else { m = t.match(RE2); if (!m) return null; n = 1; v = +m[1]; u = m[2]; }
  return [n, n * v / (TEILER[u] || 1)];
}
/* Lebensmittel: Gewicht (g, kg) und Stück. Grundpreise wie "(1 kg = 7,96)" und "je 100 g" gehören nicht zur Packung und werden vorher entfernt. */
const GEW = "(kilogramm|kg|gramm|gr|g)";
const GRE1 = new RegExp("(\\d+)\\s*[x×]\\s*(\\d+(?:\\.\\d+)?)\\s*-?\\s*" + GEW + "(?![a-zäöüß])"), GRE2 = new RegExp("(\\d+(?:\\.\\d+)?)\\s*-?\\s*" + GEW + "(?![a-zäöüß])");
function ohneGrundpreis(text) {
  return (text || "").toLowerCase().replace(/,/g, ".")
    .replace(/\(?\s*\d*\s*(?:kg|g|l|ml|100\s*g|100\s*ml)\s*=\s*[\d.]+[^)\n;]*\)?/g, " ")
    .replace(/\b(?:pro|je|per)\s+\d*\s*(?:kg|g|l|ml|stück|stk)\b/g, " ");
}
function gewicht(text) {
  const t = ohneGrundpreis(text);
  let m = t.match(GRE1), n, v, u;
  if (m) { n = +m[1]; v = +m[2]; u = m[3]; } else { m = t.match(GRE2); if (!m) return null; n = 1; v = +m[1]; u = m[2]; }
  return [n, n * (u[0] === "k" ? v : v / 1000)];
}
function stueckZahl(text) {
  const t = ohneGrundpreis(text);
  const m = t.match(/(\d+)\s*(?:stück|stk\.?|st\.)(?![a-zäöüß])/) || t.match(/\b(\d+)\s*er(?:[- ]?pack(?:ung)?)?(?![a-zäöüß])/);
  return m && +m[1] >= 1 && +m[1] <= 200 ? +m[1] : null;
}
/* Ergebnis: [Anzahl, Menge in Basiseinheit, Art]; Art "l" = Liter, "kg" = Kilogramm, "st" = Stück */
function mengenangabe(o) {
  const e = o.einheit;
  if (e === "l" && o.volume > 0) { const n = o.quantity >= 1 ? Math.floor(o.quantity) : 1; return [n, Math.round(n * o.volume * 1e4) / 1e4, "l"]; }
  if (e === "kg") { const n = o.quantity >= 1 ? Math.floor(o.quantity) : 1, v = o.volume > 0 ? o.volume : 1; return [n, Math.round(n * v * 1e4) / 1e4, "kg"]; }
  if (e === "g" && o.volume > 0) { const n = o.quantity >= 1 ? Math.floor(o.quantity) : 1; return [n, Math.round(n * o.volume) / 1000, "kg"]; }
  const fl = menge(o.desc) || menge(o.name);
  if (fl) return [fl[0], fl[1], "l"];
  const ge = gewicht(o.desc) || gewicht(o.name);
  if (ge) return [ge[0], Math.round(ge[1] * 1e4) / 1e4, "kg"];
  const sz = stueckZahl(o.desc) || stueckZahl(o.name);
  if (sz) return [sz, sz, "st"];
  if (/^(st|stk|stück)/.test(e || "")) { const n = o.quantity >= 1 ? Math.floor(o.quantity) : 1; return [n, n, "st"]; }
  return null;
}

/* ---------- Eine Teilabfrage: ein Suchbegriff in einer Postleitzahl, bis zu 2 Seiten ---------- */
function bildUrl(o) {
  const suche = x => {
    if (typeof x === "string") return /^http/.test(x) && /\.(png|jpe?g|webp|gif)(\?|$)/i.test(x) ? x : "";
    for (const v of (x && typeof x === "object" ? Object.values(x) : [])) { const r = suche(v); if (r) return r; }
    return "";
  };
  for (const k of ["images", "image", "imageUrl", "imageURL"]) { const r = suche(o[k]); if (r) return r; }
  return o.id && o.images ? `https://mg2de.b-cdn.net/api/v1/offers/${o.id}/images/default/0/small.webp` : "";
}
function link(o) {
  for (const k of ["url", "link", "shareUrl", "webUrl"]) if (typeof o[k] === "string" && o[k].startsWith("http")) return o[k];
  return o.id ? `https://www.marktguru.de/offers/${o.id}` : "";
}
const lokalDatum = s => { if (!s) return ""; const d = new Date(s); return isNaN(d) ? s.slice(0, 10) : berlin(d); };

async function teilAbfrage(env, plz, suche) {
  // eine Abfrage mit bis zu 250 Treffern: beim Blättern überschneiden sich die Seiten, eine zweite Seite brächte Doppelte, andere fehlten
  const j = await mgHole(env, SEARCH + "?" + new URLSearchParams({ as: "web", limit: "250", offset: "0", q: suche, zipCode: plz }));
  return (j.results || []).map(o => {
    const v = (o.validityDates || [{}])[0] || {};
    return { id: o.id, adv: (((o.advertisers || [{}])[0]) || {}).name || "?", name: (o.product || {}).name || "?", brand: markeVon(o),
      desc: o.description || "", price: o.price, alt: +o.oldPrice > +o.price ? +o.oldPrice : null, einheit: (((o.unit || {}).shortName) || "").toLowerCase(), volume: o.volume, quantity: o.quantity,
      von: lokalDatum(v.from), bis: lokalDatum(v.to), bild: bildUrl(o), link: link(o), kp: +(((o.categories || [])[0] || {}).parentId) || 0 };
  });
}

/* ---------- Alle Angebote eines Marktes (zum Durchstöbern) ----------
   Marktguru nennt die Märkte einer Postleitzahl (/offers/publishers). Alle Angebote eines Marktes liefert die Suche nach seinem Namen,
   eingeschränkt auf ihn (retailers=ID); ohne Suchwort gibt es nichts. */
const PUBLISHERS = "https://api.marktguru.de/api/v1/offers/publishers";
async function mgHole(env, url) {   // eine Abfrage mit den Schlüsseln der Seite, bei abgelaufenen Schlüsseln einmal neu holen
  let k = await schluessel(env), r;
  try { r = await http(url, { "x-apikey": k.api, "x-clientkey": k.client }); }
  catch (e) { if (e.status === 401 || e.status === 403) { k = await schluessel(env, true); r = await http(url, { "x-apikey": k.api, "x-clientkey": k.client }); } else throw e; }
  return r.json();
}
const markeVon = o => { const m = String((o.brand || {}).name || "").trim(); return /^thisisnobrand/i.test(m) ? "" : m; };   // REWE: Platzhalter statt leerer Marke
const haendlerId = o => String((((o.advertisers || [])[0]) || {}).id || "").replace(/\D/g, "");
function kompakt(o) {   // ein Angebot im selben Format wie die übrigen Angebote, dazu die Kategorie
  const v = (o.validityDates || [{}])[0] || {}, k = (o.categories || [])[0] || {};
  const x = { name: (o.product || {}).name || "?", brand: markeVon(o), desc: o.description || "", einheit: (((o.unit || {}).shortName) || "").toLowerCase(), volume: o.volume, quantity: o.quantity };
  const mg = mengenangabe(x), menge = mg ? mg[1] : null, st = mg ? mg[0] : null;
  return { id: o.id, marke: x.brand, produkt: x.name, beschreibung: x.desc.slice(0, 220), preis: o.price, preis_alt: +o.oldPrice > +o.price ? +o.oldPrice : null,
    art: mg ? mg[2] : null, liter: menge, stueck: st, ml: menge && st ? Math.round(menge * 1000 / st) : null, preis_pro_liter: o.price && menge ? Math.round(o.price / menge * 100) / 100 : null,
    gueltig_von: lokalDatum(v.from), gueltig_bis: lokalDatum(v.to), bild: bildUrl(o), link: link(o), kat: String(k.name || ""), kp: +k.parentId || 0 };
}
async function marktListe(env, plz, passt, ohne) {   // Märkte einer Postleitzahl mit der Zahl ihrer Angebote
  const j = await mgHole(env, PUBLISHERS + "?" + new URLSearchParams({ as: "web", zipCode: plz, limit: "60" }));
  const liste = (j.results || []).map(x => ({ id: String(x.id || "").replace(/\D/g, ""), name: String(x.name || "").trim(), plz }))
    .filter(x => x.id && x.name && (!passt || passt(x.name.toLowerCase())) && !(ohne || []).includes(x.id));
  const n = await parallel(liste.map(x => () => mgHole(env, SEARCH + "?" + new URLSearchParams({ as: "web", limit: "1", offset: "0", q: x.name, retailers: x.id, zipCode: plz })).then(r => r.totalResults || 0).catch(() => null)), 6);
  liste.forEach((x, i) => { x.n = n[i]; });
  return liste;
}
async function maerkteRegion(env, plz) {   // für die eigene Gegend kommen wie bei den Favoriten einzelne Märkte aus den Nachbar-Postleitzahlen dazu
  const key = "mkl2:" + plz, alt = await env.PV.get(key, "json");
  if (alt && Date.now() - alt.t < 12 * 3600e3) return alt.liste;
  let liste = await marktListe(env, plz);
  if (plz === PLZ) for (const [p2, passt] of [[PLZ2, n => PLZ2_MAERKTE.some(z => n.includes(z))], [PLZ3, n => PLZ3_MAERKTE.includes(n)]]) {
    try { liste = liste.concat(await marktListe(env, p2, passt, liste.map(x => x.id))); } catch (e) {}
  }
  liste = liste.filter(x => x.n !== 0);
  await env.PV.put(key, JSON.stringify({ t: Date.now(), liste }), { expirationTtl: 86400 });
  return liste;
}
async function marktAngebote(env, ctx, sp, ip) {
  const plz = sp.get("plz") || PLZ, id = String(sp.get("id") || "").replace(/\D/g, "");
  if (!plzOk(plz) || !id) throw Object.assign(new Error("Ungültige Anfrage"), { status: 400 });
  const key = "mk3:" + plz + ":" + id, alt = await env.PV.get(key, "json");
  if (alt && Date.now() - alt.t < 6 * 3600e3) return alt;
  if (begrenzt("mk:" + ip, 30) || !(await tagesOk(env, "markt", 400))) { if (alt) return alt; throw zuViel(); }
  const m = (await maerkteRegion(env, plz)).find(x => x.id === id);
  if (!m) throw Object.assign(new Error("Diesen Markt gibt es hier gerade nicht"), { status: 404 });
  // Die Reihenfolge der Treffer ist beim Blättern nicht fest (Seiten überschneiden sich), deshalb alles in einer Abfrage, höchstens 1000
  const teile = ctx.exports.Teil, lim = Math.min(1000, Math.max(100, (m.n || 0) + 50)), erste = await teile.marktSeite(m.plz, m.name, id, 0, lim);
  const rest = erste.total > lim && lim < 1000 ? [await teile.marktSeite(m.plz, m.name, id, 0, 1000).catch(e => ({ liste: [], fehler: String(e.message || e).slice(0, 80) }))] : [];
  const ids = new Set(), angebote = [], info = [];
  for (const s of [erste, ...rest]) { let neu = 0; for (const o of s.liste) if (!ids.has(o.id)) { ids.add(o.id); angebote.push(o); neu++; } info.push(s.fehler ? "F:" + s.fehler : s.roh + "/" + s.liste.length + "/" + neu); }
  const erg = { t: Date.now(), id, name: m.name, plz: m.plz, total: erste.total, seiten: info, angebote };
  await env.PV.put(key, JSON.stringify(erg), { expirationTtl: 86400 });
  return erg;
}

// Eigener Einstiegspunkt, damit jede Teilabfrage als eigener Aufruf mit eigenen Grenzen läuft.
// Ein Aufruf holt mehrere Artikel in einer Postleitzahl und sortiert unpassende Treffer gleich aus (spart Aufrufe und Rechenzeit im Hauptaufruf).
export class Teil extends WorkerEntrypoint {
  async hole(plz, suche) { return teilAbfrage(this.env, plz, suche); }
  async marktSeite(plz, name, id, offset, limit) {   // Angebote eines Marktes, schon verkleinert
    const j = await mgHole(this.env, SEARCH + "?" + new URLSearchParams({ as: "web", limit: String(limit), offset: String(offset), q: name, retailers: id, zipCode: plz }));
    const alle = j.results || [], passend = alle.filter(o => haendlerId(o) === id);
    return { total: j.totalResults || 0, roh: alle.length, liste: (passend.length || !alle.length ? passend : alle).map(kompakt) };
  }
  async marktNamen(plz, name, id) {   // nur Marken und Produktnamen eines Marktes (für „Meintest du …?“)
    const j = await mgHole(this.env, SEARCH + "?" + new URLSearchParams({ as: "web", limit: "1000", offset: "0", q: name, retailers: id, zipCode: plz }));
    const n = new Set();
    for (const o of j.results || []) if (haendlerId(o) === id) for (const x of [(o.brand || {}).name, (o.product || {}).name]) { const t = String(x || "").replace(/\s+/g, " ").trim(); if (t.length >= 3 && t.length <= 40) n.add(t); }
    return [...n];
  }
  async holeStapel(plz, auftraege, ohneFilterFallback) {
    return Promise.all(auftraege.map(async a => {
      const ids = new Set(), alle = [];
      for (const seite of await Promise.all(a.suchen.map(s => teilAbfrage(this.env, plz, s)))) for (const o of seite) if (!ids.has(o.id)) { ids.add(o.id); alle.push(o); }
      // Das Angebot muss zum Suchwort passen (z. B. "Milch"); ist zusätzlich ein bestimmtes Produkt gewählt (nur), zählt nur dessen Marke bzw. Name.
      // Ohne die Prüfung des Suchworts kämen bei "K-Classic" + "Milch" auch K-Classic-Käse und -Sahne mit.
      // "nur" nennt die Marke (alte Favoriten) oder ein bestimmtes Produkt aus Marke und Name ("Nivea Pflegedusche" statt aller Nivea-Produkte)
      const wort = a.wort || a.p, nurOk = nurPruefer(a.nur);
      let t = alle.filter(o => istProdukt(wort, o, a.aus) && nurOk(o));
      // Nichts Passendes: bei der Suche (locker) oder einem fest gewählten Produkt (nur) auch Wortanfänge und Schreibweisen
      // ohne Leerzeichen gelten lassen ("hidro" -> "Hidrofugal", "hidro fugal" -> "Hidrofugal", "coca cola" -> "Coca-Cola").
      if (!t.length && (a.locker || (a.nur && a.nur.length))) t = alle.filter(o => passtLocker(wort, o, a.aus) && nurOk(o));
      // Spar-Tipp: bei einer gewählten Marke bzw. einem Produkt auch dieselbe Sorte von anderen Marken (zum Vergleich, zählt nicht als Angebot des Favoriten)
      let andere = [];
      if (t.length && (a.nur || []).some(x => !/^sorte:/i.test(x))) {
        const sorten = new Set(t.map(o => sorteK(o.name, o.brand)));
        andere = alle.filter(o => !nurOk(o) && istProdukt(wort, o, a.aus) && sorten.has(sorteK(o.name, o.brand)));
      }
      return { t: !t.length && ohneFilterFallback ? alle : t, andere };
    }));
  }
}

/* ---------- Abfrage mehrerer Produkte, Aufbereitung wie im Python-Skript ---------- */
// Wörter, die bei Lebensmitteln fast immer ein anderes Produkt anzeigen (Süßes, Saisonware); gelten nicht, wenn sie selbst gesucht werden
const ESSEN_AUS = ["stollen", "spekulatius", "mäuse", "adventskalender", "lebkuchen", "nikolaus", "likör", "peanut", "erdnuss", "haselnuss", "milch reis", "milchreis"];
/* Passt ein Angebot zum gesuchten Artikel?
   Getränke (Liter): wie bisher, das Wort darf auch in der Beschreibung stehen ("oder Fanta ...").
   Lebensmittel (kg, Stück): nur im Namen oder der Marke, als eigenes Wort oder als Wortende ("Freilandeier", "Weizenmehl"), nicht als Wortanfang ("Buttergebäck") und nicht vor einem Bindestrich ("Butter-Mandel-Stollen"). */
function istProdukt(gruppe, o, extra) {
  const name = `${o.brand} ${o.name}`.toLowerCase(), alles = `${name} ${o.desc}`.toLowerCase();
  const mg = mengenangabe(o), fluessig = !mg || mg[2] === "l";
  let gefunden;
  if (KW[gruppe]) gefunden = KW[gruppe].some(k => alles.includes(k));
  else {
    const wort = (gruppe.toLowerCase().split(/\s+/).filter(Boolean)[0] || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    gefunden = fluessig ? new RegExp(wort + "(?:s|e|n)?(?![a-zäöüß])").test(alles) : new RegExp(wort + "(?:s|e|n)?(?![a-zäöüß-])").test(name);
  }
  const essen = fluessig ? [] : ESSEN_AUS.filter(x => !gruppe.toLowerCase().includes(x));
  return gefunden && ![...AUSSCHLUSS, ...extra, ...essen].some(x => alles.includes(x));
}

/* Lockere Prüfung (zweite Stufe, nur wenn die strenge nichts findet): jedes Wort des Suchbegriffs steht als Wortanfang im Angebot,
   oder ein Begriff aus mehreren Wörtern ohne Leerzeichen und Striche steckt zusammenhängend darin. Umlaute und Akzente zählen wie ihre Grundbuchstaben. */
const flach = t => String(t || "").toLowerCase().replace(/ß/g, "ss").replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
function passtLocker(gruppe, o, extra) {
  const name = `${o.brand} ${o.name}`, alles = `${name} ${o.desc}`;
  const mg = mengenangabe(o), fluessig = !mg || mg[2] === "l", text = flach(fluessig ? alles : name);
  const woerter = flach(gruppe).split(/[^a-z0-9]+/).filter(w => w.length >= 2), kompakt = woerter.join("");
  const gefunden = (woerter.length && woerter.every(w => new RegExp("(?:^|[^a-z0-9])" + w).test(text))) || (woerter.length > 1 && kompakt.length >= 4 && text.replace(/[^a-z0-9]/g, "").includes(kompakt));
  const essen = fluessig ? [] : ESSEN_AUS.filter(x => !gruppe.toLowerCase().includes(x));
  return !!gefunden && ![...AUSSCHLUSS, ...extra, ...essen].some(x => alles.toLowerCase().includes(x));
}
// Marke eines gewählten Produkts vergleichen, ohne dass Groß-/Kleinschreibung, Striche oder Umlaute stören ("Coca Cola" = "Coca-Cola")
const nurK = t => flach(t).replace(/[^a-z0-9]/g, "");
// ein bestimmtes Produkt (Marke und Name): "Deodorant" = "Deo", Zusätze wie XXL oder Vorteilspackung zählen nicht (nur die Größe ist anders)
const prodK = t => nurK(t).replace(/deodorant/g, "deo").replace(/xxl|familienpackung|vorteilspackung|vorteilspack|grosspackung/g, "");
/* Sorte über alle Marken ("XXL Rinderhackfleisch" = "Rinder-Hackfleisch"): Produktname ohne Marke, Größe und Füllwörter.
   Muss genau wie sorteK in der Seite rechnen (Test: tests/sorte.test.mjs). */
const SORTE_WEG = /(?<= )(?:xxl|xl|maxi|familienpackung|vorteilspack|vorteilspackung|grosspackung|premium|original|klassisch|classic|frisch|frische|frischer|gekuehlt|neu|je|ca|zum|braten|vom|von|aus|mit|und|oder|in|der|die|das|ein|eine)(?= )/g;
function sorteK(name, marke) {
  const ohne = s => s.replace(/ \d+(?: \d+)?(?: (?:x|g|kg|ml|l|cl|stk|stueck|er))?(?= )/g, " ").replace(SORTE_WEG, " ").replace(SORTE_WEG, " ");
  const voll = " " + flach(name).replace(/[^a-z0-9]+/g, " ").trim() + " ";
  let s = voll; for (const w of flach(marke).split(/[^a-z0-9]+/)) if (w.length >= 3) s = s.split(" " + w + " ").join(" ");
  let k = nurK(ohne(s)).replace(/deodorant/g, "deo");
  if (k.length < 5) k = nurK(ohne(voll)).replace(/deodorant/g, "deo");   // "Coca-Cola Zero": ohne Marke bliebe nur "zero", dann gehört die Marke dazu
  return k;
}
// "nur" eines Favoriten: Marke (alte Favoriten), Produkt (Marke und Name) oder "sorte:…" (eine Sorte über alle Marken)
function nurPruefer(nur) {
  const l = [...(nur || [])].map(String), sorten = l.filter(x => /^sorte:/i.test(x)).map(x => x.slice(6).toLowerCase()), rest = l.filter(x => !/^sorte:/i.test(x)).map(nurK);
  return o => !l.length || rest.includes(nurK(o.brand || o.name)) || rest.map(prodK).includes(prodK((o.brand || "") + (o.name || ""))) || sorten.includes(sorteK(o.name, o.brand));
}
// Suchbegriffe für Marktguru: aus mehreren Wörtern zusätzlich die zusammengeschriebene Form ("hidro fugal" -> "hidrofugal")
const varianten = s => { const z = s.replace(/[\s-]+/g, ""); return /[\s-]/.test(s.trim()) && z.length >= 4 ? [s, z] : [s]; };

async function parallel(aufgaben, n) {
  const erg = new Array(aufgaben.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, aufgaben.length) }, async () => { while (i < aufgaben.length) { const j = i++; erg[j] = await aufgaben[j](); } }));
  return erg;
}

async function abfragen(ctx, produkte, favInfo, extraAus, plzListe = [PLZ, PLZ2, PLZ3], streng = false, locker = false) {   // erste Postleitzahl = Hauptgebiet, die weiteren liefern nur ausgewählte Märkte dazu
  const HAUPT = plzListe[0];
  // produkte: Liste von Gruppennamen; favInfo: {name: {aus:[...], nur:Set}}
  // Je Postleitzahl werden die Artikel in Stapeln von höchstens 4 Suchbegriffen abgefragt (ein Aufruf je Stapel, wegen der Grenzen bei Cloudflare)
  const auftraege = [];
  for (const p of produkte) {
    const info = favInfo[p] || { aus: extraAus }, aus = info.aus && info.aus.length ? info.aus : extraAus;
    const nur = info.nur && info.nur.size ? [...info.nur] : [], basis = info.suche ? [info.suche] : (SUCHEN[p] || [p]);
    const suchen = (locker || nur.length) && !SUCHEN[p] ? [...new Set(basis.flatMap(varianten))] : basis;
    for (const plz of plzListe) auftraege.push({ p, plz, wort: info.suche || p, suchen, aus, nur, locker, roh: null });
  }
  const stapel = [];
  for (const plz of plzListe) {
    let akt = null, n = 0;
    for (const a of auftraege.filter(x => x.plz === plz)) {
      if (!akt || n + a.suchen.length > 4) { akt = { plz, liste: [] }; n = 0; stapel.push(akt); }
      akt.liste.push(a); n += a.suchen.length;
    }
  }
  const teile = ctx.exports.Teil;
  const fehlerListe = [];
  const einzeln = produkte.length === 1 && !streng;   // bei einer einzelnen Suche notfalls auch ungefilterte Treffer zeigen (außer "streng")
  const ergebnis = await parallel(stapel.map(st => async () => {
    try {
      const r = await teile.holeStapel(st.plz, st.liste.map(a => ({ p: a.p, wort: a.wort, suchen: a.suchen, aus: a.aus, nur: a.nur, locker: a.locker })), einzeln);
      st.liste.forEach((a, i) => { a.roh = Array.isArray(r[i]) ? r[i] : r[i].t; a.andere = (r[i] && r[i].andere) || []; });
      return true;
    } catch (e) { fehlerListe.push(`${st.liste.map(a => a.p).join("+")}/${st.plz}: ${e.message}`); return false; }
  }), GLEICHZEITIG);
  if (ergebnis.every(x => !x)) throw new Error("Marktguru nicht erreichbar: " + fehlerListe.slice(0, 2).join("; "));
  const jetzt = berlin(new Date(), true), ausgabe = [], alternativen = [];
  for (const p of produkte) {
    const ids = new Set(), treffer = [];
    for (const a of auftraege) {
      if (a.p !== p || a.plz !== HAUPT || !a.roh) continue;
      for (const o of a.roh) if (!ids.has(o.id)) { ids.add(o.id); treffer.push(o); }
    }
    const bekannt = new Set(treffer.map(o => o.id)), zweit = new Set();
    for (const a of auftraege) {
      if (a.p !== p || a.plz === HAUPT || !a.roh) continue;
      for (const o of a.roh) {
        const name = o.adv.trim().toLowerCase();
        const passt = a.plz === PLZ2 ? PLZ2_MAERKTE.some(z => name.includes(z)) : PLZ3_MAERKTE.includes(name) && !bekannt.has(o.id);
        const key = a.plz + "|" + o.id;
        if (passt && !zweit.has(key)) { zweit.add(key); treffer.push({ ...o, plz: a.plz }); }
      }
    }
    const info = favInfo[p] || { aus: extraAus, nur: new Set() };
    // Alternativen (dieselbe Sorte anderer Marken) für den Spar-Tipp, wie die Treffer aus der Hauptgegend plus PENNY bzw. REWE aus den Nachbar-Postleitzahlen
    const altIds = new Set();
    for (const a of auftraege) {
      if (a.p !== p || !a.andere || !a.andere.length) continue;
      for (const o of a.andere) {
        const name = o.adv.trim().toLowerCase(), key = a.plz + "|" + o.id;
        if (a.plz !== HAUPT && !(a.plz === PLZ2 ? PLZ2_MAERKTE.some(z => name.includes(z)) : PLZ3_MAERKTE.includes(name))) continue;
        if (altIds.has(key)) continue; altIds.add(key);
        const mg = mengenangabe(o), l = mg ? mg[1] : null, st = mg ? mg[0] : 1;
        if (!l || !o.price) continue;
        alternativen.push({ gruppe: p, bild: o.bild, marke: o.brand, link: o.link, markt: o.adv + (a.plz !== HAUPT ? ` (${a.plz})` : ""), produkt: o.name, beschreibung: o.desc, preis: o.price, preis_alt: o.alt || null,
          art: mg[2], liter: l, stueck: st, ml: Math.round(l * 1000 / st), preis_pro_liter: Math.round(o.price / l * 100) / 100, gueltig_von: o.von, gueltig_bis: o.bis });
      }
    }
    for (const o of treffer) {
      const mg = mengenangabe(o), l = mg ? mg[1] : null, st = mg ? mg[0] : 1, art = mg ? mg[2] : "l";
      const kandidat = (o.brand || o.name).trim().toLowerCase();
      let coke = true;   // passende Treffer sind schon im Teilaufruf ausgewählt
      if (info.nur && info.nur.size && !nurPruefer(info.nur)(o)) coke = false;
      ausgabe.push({ abgefragt: jetzt, gruppe: p, bild: o.bild, marke: o.brand, coke, link: o.link, markt: o.adv + (o.plz ? ` (${o.plz})` : ""), produkt: o.name,
        beschreibung: o.desc, preis: o.price, preis_alt: o.alt || null, art, liter: l, stueck: st, ml: l && st ? Math.round(l * 1000 / st) : null,
        preis_pro_liter: o.price && l ? Math.round(o.price / l * 100) / 100 : null, gueltig_von: o.von, gueltig_bis: o.bis, ...(o.kp ? { kp: o.kp } : {}) });
    }
  }
  let liste = ausgabe.some(x => x.coke) ? ausgabe.filter(x => x.coke) : ausgabe;
  const gesehen = new Set();
  liste = liste.filter(x => {
    if (x.beschreibung.toLowerCase().replace(/ß/g, "ss").includes("grosshändler")) return false;
    const k = [x.gruppe, x.markt, x.preis, x.liter, x.gueltig_bis].join("|");
    if (gesehen.has(k)) return false; gesehen.add(k); return true;
  });
  liste.sort((a, b) => a.gruppe.localeCompare(b.gruppe) || ((a.preis_pro_liter == null) - (b.preis_pro_liter == null)) || (a.preis_pro_liter || 0) - (b.preis_pro_liter || 0));
  return { liste, fehler: fehlerListe, alternativen };
}

/* ---------- Gespeicherte Daten (liegen im Cloudflare-Speicher KV) ---------- */
async function lade(env, name, typ) {
  const v = await env.PV.get(name, typ === "json" ? "json" : "text");
  if (v !== null) return v;
  return name === "favoriten" ? START_FAVS : typ === "json" ? (name === "angebote" ? [] : {}) : "";
}

function favAuswerten(favs) {
  const info = {}, alarm = {};
  for (const f of favs || []) {
    if (!f || !f.name || f.pause) continue;   // pausierte Favoriten werden nicht abgefragt
    info[f.name] = { aus: String(f.aus || "").split(",").map(w => w.trim().toLowerCase()).filter(Boolean), nur: new Set((f.nur || []).map(k => String(k).trim().toLowerCase())), suche: String(f.suche || "").replace(/[,|]/g, " ").trim().slice(0, 40) };
    const al = f.alarm;
    if (al && ["l", "stueck", "kg", "st"].includes(al.einheit) && +al.wert > 0) alarm[f.name] = { wert: +al.wert, einheit: al.einheit, ml: al.ml ? +al.ml : null };
  }
  return { info, alarm };
}

const de = x => x.toFixed(2).replace(".", ",");
const kurz = iso => iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.` : "";
const nochNicht = x => x.gueltig_von && tageBis(x.gueltig_von) > 0;
const abgelaufen = x => x.gueltig_bis && tageBis(x.gueltig_bis) < 0;

async function benachrichtige(env, liste, alarm) {
  if (!Object.keys(alarm).length) return [];
  if (!(env.NTFY_TOPIC || "").trim() && !(await pushAbos(env)).length) return [];   // kein Weg für Mitteilungen eingerichtet
  let gemeldet = await lade(env, "benachrichtigt", "json");
  const grenze = berlin(new Date(Date.now() - 60 * 864e5));
  gemeldet = Object.fromEntries(Object.entries(gemeldet || {}).filter(([, d]) => d >= grenze));
  const gesendet = [];
  for (const [gruppe, al] of Object.entries(alarm)) {
    const treffer = [];
    for (const x of liste) {
      if (x.gruppe !== gruppe || !x.preis || abgelaufen(x)) continue;
      if (al.ml && x.ml !== al.ml) continue;
      const art = x.art || "l";
      // l / kg / st: Preis je Liter, kg bzw. Stück (nur Angebote der passenden Art); stueck: Preis je Flasche/Dose (Getränke, alte Alarme)
      if (["l", "kg", "st"].includes(al.einheit) && art !== al.einheit) continue;
      const wert = al.einheit === "stueck" ? (x.stueck ? x.preis / x.stueck : null) : x.preis_pro_liter;
      if (wert != null && wert <= al.wert) treffer.push([wert, x]);
    }
    if (!treffer.length) continue;
    treffer.sort((a, b) => a[0] - b[0]);
    const [wert, x] = treffer[0];
    const sch = [gruppe, x.markt, x.preis, x.liter, x.gueltig_bis].join("|");
    if (gemeldet[sch]) continue;
    const einheit = { l: "€/l", kg: "€/kg" }[al.einheit] || "€/Stück";
    const gr = al.einheit === "kg" ? (x.ml ? ", " + x.ml + " g" : "") : al.einheit === "st" ? "" : (x.ml ? ", " + x.ml + " ml" : "");
    const wann = nochNicht(x) ? `Ab ${kurz(x.gueltig_von)}` : x.gueltig_bis ? `Bis ${kurz(x.gueltig_bis)}` : "";
    const text = `${x.markt}: ${de(wert)} ${einheit} (${x.stueck > 1 ? x.stueck + " × " : ""}${x.produkt}${gr} für ${de(x.preis)} €). ${wann}`.trim();
    if (await melden(env, { titel: `Preisalarm ${gruppe}: ${de(wert)} ${einheit}`, text, tag: "alarm:" + gruppe, url: "./#produkt/" + encodeURIComponent(gruppe), ntfyTag: "moneybag" })) { gemeldet[sch] = heute(); gesendet.push(text); }
  }
  await env.PV.put("benachrichtigt", JSON.stringify(gemeldet));
  return gesendet;
}

/* ---------- Wochenüberblick: montags nach dem Lauf eine Mitteilung mit den guten Angeboten der Favoriten ----------
   Gut heißt: mindestens 8 % unter dem eigenen Durchschnitt der letzten 8 Wochen (günstigstes Angebot je Tag) oder ein Angebot mit früherem Preis ("statt"). */
const ohneQ = x => String(x || "").replace(/^"|"$/g, "").replace(/""/g, '"');
async function wochenGut(env, liste) {
  const monate = (await verlaufMonate(env)).slice(-3), tag = heute(), grenze = berlin(new Date(Date.now() - 56 * 864e5));
  const text = (await Promise.all(monate.map(m => env.PV.get("verlauf:" + m)))).filter(Boolean).join("\n");
  const proTag = {};   // gruppe -> tag -> günstigster Preis je Einheit
  for (const z of text.split(/\r?\n/)) {
    const f = z.split(";"); if (f.length < 9) continue;
    const d = f[0], ppl = +f[5], bis = ohneQ(f[6]), von = ohneQ(f[7]), g = ohneQ(f.slice(8).join(";")) || "Coca-Cola";
    if (!(ppl > 0) || d < grenze || d >= tag || (bis && bis < d) || (von && von > d)) continue;
    const t = proTag[g] = proTag[g] || {}; if (!(t[d] <= ppl)) t[d] = ppl;
  }
  const beste = {};
  for (const x of liste) {
    if (!x.preis || !x.preis_pro_liter || abgelaufen(x) || nochNicht(x) || x.coke === false) continue;
    if (!beste[x.gruppe] || x.preis_pro_liter < beste[x.gruppe].preis_pro_liter) beste[x.gruppe] = x;
  }
  const gut = [];
  for (const [g, x] of Object.entries(beste)) {
    const tage = Object.values(proTag[g] || {}), avg = tage.length >= 3 ? tage.reduce((s, v) => s + v, 0) / tage.length : null;
    const r = avg ? x.preis_pro_liter / avg - 1 : null, statt = x.preis_alt > x.preis ? x.preis_alt : null;
    if ((r != null && r <= -0.08) || statt) gut.push({ g, x, r, statt, wert: r != null ? r : -(statt - x.preis) / statt });
  }
  return gut.sort((a, b) => a.wert - b.wert);
}
async function wochenUeberblick(env, liste, jetzt) {
  if (!jetzt) {
    if ((await env.PV.get("push:woche")) === "aus") return null;
    const wt = env.WOCHENTAG_TEST != null ? +env.WOCHENTAG_TEST : new Date(heute() + "T12:00:00Z").getUTCDay();
    if (wt !== 1 || (await env.PV.get("woche:gesendet")) === heute()) return null;   // montags, einmal
  }
  const gut = await wochenGut(env, liste);
  if (!gut.length && !jetzt) return null;
  const teil = ({ g, x, r, statt }) => `${g} ${de(x.preis)} € bei ${markenKern(x.markt)}` + (r != null && r <= -0.08 ? ` (−${Math.round(-r * 100)} %)` : statt ? ` (statt ${de(statt)} €)` : "");
  const text = gut.length ? gut.slice(0, 6).map(teil).join(" · ") + (gut.length > 6 ? ` · und ${gut.length - 6} weitere` : "") : "Diese Woche ist bei deinen Favoriten nichts besonders günstig.";
  const titel = gut.length ? `Diese Woche günstig: ${gut.length} ${gut.length === 1 ? "Favorit" : "Favoriten"}` : "Wochenüberblick";
  const ok = await melden(env, { titel, text, tag: "woche", url: "./#angebote", ntfyTag: "shopping_cart" });
  if (ok && !jetzt) await env.PV.put("woche:gesendet", heute(), { expirationTtl: 8 * 864e5 });
  return ok ? text : null;
}

function csvFeld(v) { const s = v == null ? "" : String(v); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }

const KOPF = "datum;markt;produkt;liter;preis;preis_pro_liter;gueltig_bis;gueltig_von;gruppe";
async function verlaufMonate(env) {
  return (await env.PV.get("verlauf:monate", "json")) || [];
}
async function verlaufCsv(env) {
  const monate = await verlaufMonate(env);
  const teile = await Promise.all(monate.map(x => env.PV.get("verlauf:" + x)));
  return [KOPF, ...teile.filter(Boolean)].join("\n") + "\n";
}

async function aktualisieren(env, ctx) {
  const favs = await lade(env, "favoriten", "json");
  const { info, alarm } = favAuswerten(favs);
  const produkte = Object.keys(info);
  if (!produkte.length) return { anzahl: 0, alarm: [] };
  const { liste, fehler: f, alternativen } = await abfragen(ctx, produkte, info, []);
  if (!liste.length) throw new Error("Marktguru hat für keines der Produkte Angebote geliefert. Die bisherigen Daten bleiben unverändert." + (f.length ? " " + f[0] : ""));
  await env.PV.put("angebote", JSON.stringify(liste));
  await env.PV.put("alternativen", JSON.stringify(alternativen || []));   // für den Spar-Tipp
  // Verlauf: je Monat ein Speicherblock, damit nicht jedes Mal die ganze Datei neu geschrieben wird.
  // Höchstens ein Eintrag pro Tag (ein neuer Lauf am selben Tag ersetzt die Zeilen dieses Tages).
  const tag = heute(), monat = tag.slice(0, 7), monate = await verlaufMonate(env);
  const alt = (await env.PV.get("verlauf:" + monat)) || "";
  const rest = alt.split(/\r?\n/).filter(z => z.trim() && !z.startsWith(tag + ";"));
  const neu = liste.map(x => [tag, x.markt, x.produkt, x.liter, x.preis, x.preis_pro_liter, x.gueltig_bis, x.gueltig_von, x.gruppe].map(csvFeld).join(";"));
  await env.PV.put("verlauf:" + monat, [...rest, ...neu].join("\n"));
  if (!monate.includes(monat)) { monate.push(monat); await env.PV.put("verlauf:monate", JSON.stringify(monate)); }
  try { await entfernungenPflegen(env, liste.map(x => x.markt)); } catch (e) { /* Entfernungen sind nur eine Zugabe */ }
  const gesendet = await benachrichtige(env, liste, alarm);
  const stand = { zeit: berlin(new Date(), true), anzahl: liste.length, fehler: f.length };
  await env.PV.put("stand", JSON.stringify(stand));
  return { ...stand, alarm: gesendet };
}


/* ---------- Entfernung zu den Märkten (OpenStreetMap, Luftlinie ab Postleitzahl-Mitte, einmal geholt und 30 Tage gemerkt) ---------- */
const OSM_UA = { "User-Agent": "preisvergleich-privat/1.0 (privates Hobbyprojekt)" };
const markenKern = m => m.replace(/\s*\(\d+\)\s*$/, "").trim();
function markenRegex(m) {   // Suchmuster für den Namen im Kartenmaterial
  const k = markenKern(m).toLowerCase();
  const w = k.split(/\s+/)[0];
  if (["rewe", "edeka", "lidl", "kaufland", "penny", "rossmann", "trinkgut", "famila", "marktkauf", "norma", "globus", "combi", "nahkauf", "müller"].includes(w)) return w;   // z.B. "REWE Dortmund" -> rewe
  if (k.startsWith("aldi")) return k.includes("nord") ? "ALDI N" : "ALDI S";
  if (k.startsWith("netto")) return "Netto";
  if (k.startsWith("edeka")) return "EDEKA";
  return k.replace(/[^a-z0-9äöüß ]/g, ".").trim();
}
const rad = x => x * Math.PI / 180;
const luftlinie = (a, b, c, d) => { const h = Math.sin(rad(c - a) / 2) ** 2 + Math.cos(rad(a)) * Math.cos(rad(c)) * Math.sin(rad(d - b) / 2) ** 2; return 12742 * Math.asin(Math.sqrt(h)); };
async function overpass(abfrage) {
  let letzter;
  for (const host of ["https://overpass-api.de/api/interpreter"]) {
    try {
      const r = await fetch(host, { method: "POST", headers: { ...OSM_UA, "Content-Type": "application/x-www-form-urlencoded" }, body: "data=" + encodeURIComponent(abfrage), signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const j = await r.json();
        if (!(j.elements || []).length && j.remark) { letzter = new Error("Overpass: " + j.remark); continue; }
        return j;
      }
      letzter = new Error("Overpass HTTP " + r.status);
    } catch (e) { letzter = e; }
  }
  throw letzter;
}
// Ausweichweg, falls Overpass nicht antwortet: Nominatim, ein Markt nach dem anderen (höchstens 1 Anfrage pro Sekunde)
// Alle gefundenen Filialen (die 40 nächsten zur Mitte) werden gespeichert, damit jede Person die Entfernung ab ihrer eigenen Adresse im Browser rechnen kann.
function filialenErgebnis(fil, mitte) {
  if (!fil.length) return { km: null };
  fil.sort((a, b) => luftlinie(mitte.lat, mitte.lon, a[0], a[1]) - luftlinie(mitte.lat, mitte.lon, b[0], b[1]));
  const f = fil[0];
  return { km: Math.round(luftlinie(mitte.lat, mitte.lon, f[0], f[1]) * 10) / 10, adresse: f[2], filialen: fil.slice(0, 40).map(x => [Math.round(x[0] * 1e5) / 1e5, Math.round(x[1] * 1e5) / 1e5, x[2]]) };
}
async function ueberNominatim(namen, mitte) {
  const erg = {}, d = 0.22;   // etwa 15 bis 25 km um die Mitte
  for (const n of namen) {
    erg[n] = { km: null }; const fil = [];
    try {
      const u = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(markenKern(n))}&format=json&limit=40&bounded=1&viewbox=${mitte.lon - d},${mitte.lat + d * .65},${mitte.lon + d},${mitte.lat - d * .65}`;
      const r = await fetch(u, { headers: OSM_UA });
      if (r.ok) for (const e of await r.json()) {
        if (e.class !== "shop") continue;
        fil.push([+e.lat, +e.lon, (e.display_name || "").split(",").slice(0, 3).join(",").trim()]);
      }
    } catch (e) { /* nächster Markt */ }
    erg[n] = filialenErgebnis(fil, mitte);
    await new Promise(r => setTimeout(r, 1100));
  }
  return erg;
}
async function entfernungenBerechnen(env, maerkte, plz = PLZ) {
  const mk = plz === PLZ ? "mitte" : "mitte:" + plz;
  let mitte = await env.PV.get(mk, "json");
  if (!mitte) {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?postalcode=${plz}&country=de&format=json&limit=1`, { headers: OSM_UA });
    const j = r.ok ? await r.json() : [];
    if (!j.length) throw new Error("Postleitzahl nicht gefunden");
    mitte = { lat: +j[0].lat, lon: +j[0].lon };
    await env.PV.put(mk, JSON.stringify(mitte));
  }
  const namen = [...new Set(maerkte.map(markenKern))].filter(Boolean);
  // erst nach Ladentyp filtern (schnell), den Markennamen prüfen wir danach selbst
  const q = `[out:json][timeout:20];nwr["shop"~"^(supermarket|beverages|variety_store|chemist|wholesale)$"](around:15000,${mitte.lat},${mitte.lon});out center tags 1500;`;
  let daten = null, ueberKarte = true;
  try { daten = await overpass(q); } catch (e) { ueberKarte = false; }
  if (!ueberKarte) return await ueberNominatim(namen, mitte);
  const erg = {};
  for (const n of namen) {
    const re = new RegExp(markenRegex(n), "i");
    const fil = [];
    for (const e of daten.elements || []) {
      const t = e.tags || {};
      if (!re.test([t.name, t.brand, t.operator].filter(Boolean).join(" "))) continue;
      const lat = e.lat ?? (e.center || {}).lat, lon = e.lon ?? (e.center || {}).lon;
      if (lat == null) continue;
      fil.push([lat, lon, [t["addr:street"], t["addr:housenumber"]].filter(Boolean).join(" ") + (t["addr:city"] ? ", " + t["addr:city"] : "")]);
    }
    erg[n] = filialenErgebnis(fil, mitte);
  }
  return erg;
}

// Fehlende oder veraltete Märkte nachladen (mit Filialen 30 Tage gültig, ohne Treffer nur 1 Tag, damit nicht bei jedem Lauf neu gesucht wird)
async function entfernungenPflegen(env, maerkte, plz = PLZ) {
  const ek = plz === PLZ ? "entfernungen" : "entf:" + plz;
  const alt = (await env.PV.get(ek, "json")) || {}, jetzt = Date.now();
  const fehlt = [...new Set(maerkte.map(markenKern))].filter(m => m && m.length < 40 && (!alt[m] || (alt[m].km != null && !alt[m].filialen) || jetzt - (alt[m].t || 0) > ((alt[m].filialen || []).length ? 30 : 1) * 864e5)).slice(0, 12);
  if (fehlt.length) {
    const neu = await entfernungenBerechnen(env, fehlt, plz);
    for (const [m, v] of Object.entries(neu)) alt[m] = { ...v, t: jetzt };
    await env.PV.put(ek, JSON.stringify(alt));
  }
  return alt;
}

/* ---------- Angebote für eine beliebige Postleitzahl (öffentlich, 3 Stunden zwischengespeichert) ---------- */
const plzOk = s => /^\d{5}$/.test(s) && +s >= 1001 && +s <= 99998;
// Schutz der öffentlichen Abfragen: höchstens 10 neue Abfragen je Besucher und 10 Minuten, insgesamt 300 neue Abfragen am Tag (schont Marktguru und das kostenlose Schreibkontingent)
const proBesucher = new Map();
function besucherOk(ip) {
  const jetzt = Date.now(), l = (proBesucher.get(ip) || []).filter(t => jetzt - t < 600e3);
  if (l.length >= 10) return false;
  l.push(jetzt); proBesucher.set(ip, l);
  if (proBesucher.size > 500) proBesucher.clear();
  return true;
}
async function tagesOk(env, art, max) {
  const k = "tag:" + art + ":" + heute(), n = +((await env.PV.get(k)) || 0);
  if (n >= max) return false;
  await env.PV.put(k, String(n + 1), { expirationTtl: 172800 });
  return true;
}
const zuViel = () => Object.assign(new Error("Im Moment gibt es zu viele neue Abfragen. Bitte in ein paar Minuten noch einmal versuchen."), { status: 429 });
async function regionAngebote(env, ctx, sp, ip) {
  const plz = sp.get("plz") || "";
  if (!plzOk(plz)) throw Object.assign(new Error("Ungültige Postleitzahl"), { status: 400 });
  const begriffe = [...new Set((sp.get("q") || "").split("|").map(x => x.replace(/,/g, " ").trim()).filter(x => x && x.length <= 40))].slice(0, 6);
  if (!begriffe.length) throw Object.assign(new Error("Bitte einen Suchbegriff angeben"), { status: 400 });
  const roh = new TextEncoder().encode(begriffe.map(x => x.toLowerCase()).sort().join("|"));
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", roh))].slice(0, 8).map(b => b.toString(16).padStart(2, "0")).join("");
  const streng = sp.get("streng") === "1", locker = sp.get("locker") === "1", key = "reg:" + plz + ":" + hash + (streng ? ":s" : "") + (locker ? ":l" : ""), frisch = sp.get("neu") === "1";
  const alt = await env.PV.get(key, "json");
  if (alt && Date.now() - alt.t < (frisch ? 15 * 60e3 : 3 * 3600e3)) return alt.liste;
  if (!besucherOk(ip) || !(await tagesOk(env, "region", 300))) throw zuViel();
  const { info } = favAuswerten(await lade(env, "favoriten", "json"));
  const { liste } = await abfragen(ctx, begriffe, info, [], [plz], streng, locker);
  await env.PV.put(key, JSON.stringify({ t: Date.now(), liste }), { expirationTtl: 86400 });
  return liste;
}

/* ---------- Namen aller Angebote einer Gegend (für „Meintest du …?“ bei Tippfehlern), einen Tag gespeichert ---------- */
async function namenRegion(env, ctx, plz, ip, neu) {
  const key = "namen:" + plz, alt = await env.PV.get(key, "json");
  if (!neu && alt && Date.now() - alt.t < 24 * 3600e3) return alt;
  if (ip && (begrenzt("nm:" + ip, 6) || !(await tagesOk(env, "namen", 40)))) { if (alt) return alt; throw zuViel(); }
  const maerkte = (await maerkteRegion(env, plz)).slice(0, 30), teile = ctx.exports.Teil;
  const listen = await parallel(maerkte.map(m => () => teile.marktNamen(m.plz, m.name, m.id).catch(() => [])), 4);
  const z = new Map();
  for (const l of listen) for (const n of l) { const k = n.toLowerCase(); const e = z.get(k); if (e) e[1]++; else z.set(k, [n, 1]); }
  const erg = { t: Date.now(), plz, namen: [...z.values()].sort((a, b) => b[1] - a[1]).slice(0, 5000).map(x => x[0]) };
  if (!erg.namen.length && alt) return alt;
  await env.PV.put(key, JSON.stringify(erg), { expirationTtl: 3 * 86400 });
  return erg;
}

/* ---------- Benutzerkonten (ohne E-Mail) ----------
   Der Browser rechnet aus Passwort und Benutzername mit PBKDF2 einen Schlüssel aus (dk); der Server speichert nur eine Prüfsumme davon.
   Vergisst jemand das Passwort, bekommt der Betreiber eine Nachricht (ntfy) und erzeugt in der Seite einen Einmal-Code. */
const sha256hex = async t => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)))].map(b => b.toString(16).padStart(2, "0")).join("");
const zufallHex = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, "0")).join("");
const gleich = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
const grenzen = new Map();
function begrenzt(schluessel, max, fenster = 600e3) {   // true = zu viele Versuche (gilt je Rechenzentrum, grober Schutz gegen Raten)
  const jetzt = Date.now(), l = (grenzen.get(schluessel) || []).filter(t => jetzt - t < fenster);
  if (l.length >= max) return true;
  l.push(jetzt); grenzen.set(schluessel, l);
  if (grenzen.size > 2000) grenzen.clear();
  return false;
}
const NAME_RE = /^[a-z0-9_.-]{3,24}$/, DK_RE = /^[0-9a-f]{64}$/, CODE_ZEICHEN = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const nameVon = x => String(x || "").trim().toLowerCase();
const konto = (status, text) => Object.assign(new Error(text), { status });
async function sitzungNeu(env, name, gen) {
  const token = zufallHex(32);
  await env.PV.put("s:" + await sha256hex(token), JSON.stringify({ name, gen, t: Date.now() }), { expirationTtl: 90 * 86400 });
  return token;
}
async function sitzungPruefen(env, req) {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!/^[0-9a-f]{64}$/.test(token)) throw konto(401, "Bitte neu anmelden");
  const s = await env.PV.get("s:" + await sha256hex(token), "json");
  const u = s && await env.PV.get("u:" + s.name, "json");
  if (!u || u.gen !== s.gen) throw konto(401, "Bitte neu anmelden");
  return { name: s.name, u, token };
}
const FELDER = ["ort", "km", "zettel", "richt", "frei", "extra", "haken", "wahl", "kaeufe", "aus", "favs"];
function datenPruefen(d) {   // nur erwartete Felder und Größen werden gespeichert
  const o = {}, obj = x => x && typeof x === "object" && !Array.isArray(x), text = (x, n) => typeof x === "string" && x.length > 0 && x.length <= n;
  if (!obj(d)) return o;
  if (d.ort && Number.isFinite(+d.ort.lat) && Number.isFinite(+d.ort.lon)) o.ort = { lat: +d.ort.lat, lon: +d.ort.lon, name: String(d.ort.name || "").slice(0, 120), plz: /^\d{5}$/.test(d.ort.plz) ? d.ort.plz : "", angebote: d.ort.angebote !== false };
  if (Number.isFinite(+d.km) && d.km !== null && +d.km >= 0 && +d.km < 5) o.km = +d.km;
  if (obj(d.zettel)) {   // Einkaufsliste: Artikel -> Menge in Liter, kg oder Stück
    o.zettel = {};
    for (const [k, v] of Object.entries(d.zettel).slice(0, 150)) if (k.length <= 60 && Number.isFinite(+v) && +v > 0 && +v <= 500) o.zettel[k] = +v;
  }
  if (obj(d.richt)) {   // Normalpreise: Artikel -> Euro je Liter / kg / Stück
    o.richt = {};
    for (const [k, v] of Object.entries(d.richt).slice(0, 150)) if (k.length <= 60 && Number.isFinite(+v) && +v > 0 && +v <= 1000) o.richt[k] = Math.round(+v * 1e4) / 1e4;
  }
  if (obj(d.frei)) {   // Artikel ohne Angebot: Name -> Einheit
    o.frei = {};
    for (const [k, v] of Object.entries(d.frei).slice(0, 150)) if (k.length <= 60 && ["l", "kg", "st"].includes(v)) o.frei[k] = v;
  }
  if (obj(d.wahl)) {   // Einkaufsliste: Artikel -> selbst gewählter Markt
    o.wahl = {};
    for (const [k, v] of Object.entries(d.wahl).slice(0, 150)) if (k.length <= 60 && text(v, 60)) o.wahl[k] = v;
  }
  if (Array.isArray(d.kaeufe)) {   // abgehakte Einkäufe für die Ersparnis (höchstens 1000)
    const geld = x => Number.isFinite(+x) && +x >= 0 && +x < 10000 ? Math.round(+x * 100) / 100 : null;
    o.kaeufe = d.kaeufe.filter(x => x && text(x.k, 140) && /^\d{4}-\d\d-\d\d$/.test(x.d) && geld(x.p) != null).slice(-1000)
      .map(x => ({ k: x.k, d: x.d, n: String(x.n || "").slice(0, 60), ...(text(x.z, 60) ? { z: x.z } : {}), m: String(x.m || "").slice(0, 60), p: geld(x.p), r: x.r == null ? null : geld(x.r) }));
  }
  if (Array.isArray(d.extra)) o.extra = d.extra.filter(x => text(x, 40)).slice(0, 100);   // von Hand notierte Artikel
  if (obj(d.haken)) {   // beim Einkaufen abgehakt
    o.haken = {};
    for (const k of Object.keys(d.haken).slice(0, 300)) if (k.length <= 130 && d.haken[k]) o.haken[k] = 1;
  }
  if (Array.isArray(d.aus)) o.aus = d.aus.filter(x => text(x, 60)).slice(0, 80);   // ausgeblendete Märkte
  if (Array.isArray(d.favs)) o.favs = d.favs.filter(f => f && text(f.name, 40)).slice(0, 80).map(f => ({ name: f.name, aus: "", nur: (Array.isArray(f.nur) ? f.nur : []).filter(x => text(x, 60)).slice(0, 10), ...(text(f.suche, 40) ? { suche: f.suche } : {}), ...(text(f.bild, 400) && /^https:\/\//.test(f.bild) ? { bild: f.bild } : {}), ...(f.pause === true ? { pause: true } : {}) }));   // eigene Favoriten (ohne Zugangscode)
  return o;
}
async function kontoRoute(req, env, p) {
  const ip = req.headers.get("CF-Connecting-IP") || "?";
  const koerper = async () => { try { const b = await req.json(); return b && typeof b === "object" ? b : {}; } catch (e) { return {}; } };
  if (p === "/konto/neu" && req.method === "POST") {
    const b = await koerper(), name = nameVon(b.name);
    if (!NAME_RE.test(name)) throw konto(400, "Der Benutzername darf 3 bis 24 Zeichen haben: Buchstaben a bis z, Ziffern, Punkt, Strich, Unterstrich.");
    if (!DK_RE.test(b.dk || "")) throw konto(400, "Ungültige Anfrage");
    if (begrenzt("neu:" + ip, 5) || !(await tagesOk(env, "konto", 100))) throw zuViel();
    if (await env.PV.get("u:" + name)) throw konto(409, "Diesen Benutzernamen gibt es schon.");
    const salz = zufallHex(16);
    await env.PV.put("u:" + name, JSON.stringify({ salz, hash: await sha256hex(b.dk + salz), gen: 1, t: Date.now(), daten: {} }));
    return { token: await sitzungNeu(env, name, 1), name };
  }
  if (p === "/konto/login" && req.method === "POST") {
    const b = await koerper(), name = nameVon(b.name);
    if (begrenzt("login:" + ip, 10) || begrenzt("loginname:" + name, 10)) throw zuViel();
    const u = NAME_RE.test(name) && DK_RE.test(b.dk || "") ? await env.PV.get("u:" + name, "json") : null;
    if (!u || !gleich(u.hash, await sha256hex(b.dk + u.salz))) throw konto(401, "Benutzername oder Passwort stimmt nicht.");
    return { token: await sitzungNeu(env, name, u.gen), name };
  }
  if (p === "/konto/daten" && req.method === "GET") { const { name, u } = await sitzungPruefen(env, req); return { name, daten: u.daten || {} }; }
  if (p === "/konto/daten" && req.method === "PUT") {
    const { name, u } = await sitzungPruefen(env, req), b = await koerper();
    if (begrenzt("daten:" + name, 60)) throw zuViel();
    // Nur die mitgeschickten Felder ändern sich; ein Feld mit ungültigem Wert (z. B. null) wird gelöscht. So überschreibt eine ältere, noch zwischengespeicherte Fassung der Seite nichts, was sie nicht kennt.
    const neu = datenPruefen(b.daten), d = { ...(u.daten || {}) };
    delete d.eink;
    for (const k of FELDER) if (b.daten && typeof b.daten === "object" && k in b.daten) { if (k in neu) d[k] = neu[k]; else delete d[k]; }
    u.daten = d;
    await env.PV.put("u:" + name, JSON.stringify(u));
    return { name, daten: u.daten };
  }
  if (p === "/konto/logout" && req.method === "POST") {
    const { token } = await sitzungPruefen(env, req);
    await env.PV.delete("s:" + await sha256hex(token));
    return { ok: true };
  }
  if (p === "/konto/loeschen" && req.method === "POST") {
    const { name, u } = await sitzungPruefen(env, req), b = await koerper();
    if (!DK_RE.test(b.dk || "") || !gleich(u.hash, await sha256hex(b.dk + u.salz))) throw konto(401, "Das Passwort stimmt nicht.");
    await env.PV.delete("u:" + name);   // Sitzungen werden damit ungültig (Konto existiert nicht mehr)
    return { ok: true };
  }
  if (p === "/konto/vergessen" && req.method === "POST") {
    const b = await koerper(), name = nameVon(b.name), antwortText = { ok: true, hinweis: "Wenn es dieses Konto gibt, wurde der Betreiber benachrichtigt. Er meldet sich bei dir mit einem Code." };
    if (begrenzt("vergessen:" + ip, 5)) throw zuViel();
    if (!NAME_RE.test(name) || !(await env.PV.get("u:" + name))) return antwortText;
    const liste = (await env.PV.get("anfragen", "json")) || {}, jetzt = Date.now();
    if (liste[name] && jetzt - liste[name] < 12 * 3600e3) return antwortText;   // höchstens eine Nachricht je 12 Stunden
    if (!(await tagesOk(env, "vergessen", 50))) throw zuViel();
    liste[name] = jetzt;
    for (const k of Object.keys(liste)) if (jetzt - liste[k] > 7 * 864e5) delete liste[k];
    await env.PV.put("anfragen", JSON.stringify(liste));
    // der automatische Test nach dem Hochladen (X-Wartung) prüft nur den Ablauf und soll keine Mitteilung auslösen
    const test = req.headers.get("X-Wartung") && env.WARTUNG && req.headers.get("X-Wartung") === env.WARTUNG;
    if (!test) await ntfy(env, "Passwort vergessen", `Benutzer „${name}“ möchte ein neues Passwort. Prüfe, ob die Person wirklich du kennst, und erzeuge in der Seite unter Konto einen Code.`, "key");
    return antwortText;
  }
  if (p === "/konto/anfragen" && req.method === "GET") {
    if (!(await berechtigt(req, env))) throw konto(401, "Zugangscode fehlt oder ist falsch");
    const liste = (await env.PV.get("anfragen", "json")) || {}, jetzt = Date.now();
    return Object.entries(liste).filter(([, t]) => jetzt - t < 7 * 864e5).sort((a, b) => b[1] - a[1]).map(([name, t]) => ({ name, t }));
  }
  if (p === "/konto/code" && req.method === "POST") {
    if (!(await berechtigt(req, env))) throw konto(401, "Zugangscode fehlt oder ist falsch");
    const name = nameVon((await koerper()).name);
    if (!NAME_RE.test(name) || !(await env.PV.get("u:" + name))) throw konto(404, "Dieses Konto gibt es nicht.");
    const code = Array.from(crypto.getRandomValues(new Uint8Array(8)), b => CODE_ZEICHEN[b % CODE_ZEICHEN.length]).join("");
    await env.PV.put("code:" + name, JSON.stringify({ hash: await sha256hex(code + name), versuche: 0 }), { expirationTtl: 24 * 3600 });
    return { code, gueltig: "24 Stunden, einmal benutzbar" };
  }
  if (p === "/konto/neues-passwort" && req.method === "POST") {
    const b = await koerper(), name = nameVon(b.name), code = String(b.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (begrenzt("reset:" + ip, 10)) throw zuViel();
    const c = NAME_RE.test(name) && DK_RE.test(b.dk || "") ? await env.PV.get("code:" + name, "json") : null, u = c && await env.PV.get("u:" + name, "json");
    if (!c || !u || c.versuche >= 5) throw konto(401, "Der Code ist ungültig oder abgelaufen.");
    if (!gleich(c.hash, await sha256hex(code + name))) {
      c.versuche++;
      await env.PV.put("code:" + name, JSON.stringify(c), { expirationTtl: 24 * 3600 });
      throw konto(401, "Der Code ist ungültig oder abgelaufen.");
    }
    u.salz = zufallHex(16); u.hash = await sha256hex(b.dk + u.salz); u.gen = (u.gen || 1) + 1;   // alle alten Anmeldungen werden ungültig
    await env.PV.put("u:" + name, JSON.stringify(u));
    await env.PV.delete("code:" + name);
    const liste = (await env.PV.get("anfragen", "json")) || {};
    if (liste[name]) { delete liste[name]; await env.PV.put("anfragen", JSON.stringify(liste)); }
    return { token: await sitzungNeu(env, name, u.gen), name };
  }
  throw konto(404, "Unbekannte Adresse");
}

/* ---------- Schreibrechte: Zugangscode (Secret ZUGANG), die App merkt ihn sich nach der ersten Eingabe ---------- */
async function berechtigt(req, env) {
  const w = req.headers.get("X-Wartung");  // nur für den automatischen Test nach dem Hochladen
  if (w && env.WARTUNG && w === env.WARTUNG) return true;
  const t = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!t || !env.ZUGANG) return false;
  const h = async x => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(x)));
  const [x, y] = [await h(t), await h(env.ZUGANG)];
  let d = 0; for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

/* ---------- Mitteilungen: Web-Push (App auf dem Home-Bildschirm, iPhone ab iOS 16.4) und ntfy ----------
   Web-Push nach RFC 8291 (Inhalt verschlüsselt, aes128gcm) und RFC 8292 (VAPID). Das Schlüsselpaar entsteht beim ersten Mal und liegt im Speicher (KV). */
const b64u = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const vonB64u = t => Uint8Array.from(atob(String(t).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(t).length + 3) % 4)), c => c.charCodeAt(0));
const verbinde = (...l) => { const n = l.reduce((s, x) => s + x.length, 0), r = new Uint8Array(n); let i = 0; for (const x of l) { r.set(x, i); i += x.length; } return r; };
const txt = t => new TextEncoder().encode(t);
async function vapid(env) {
  const alt = await env.PV.get("push:vapid", "json");
  if (alt && alt.pub && alt.jwk) return alt;
  const k = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const neu = { pub: b64u(await crypto.subtle.exportKey("raw", k.publicKey)), jwk: await crypto.subtle.exportKey("jwk", k.privateKey) };
  await env.PV.put("push:vapid", JSON.stringify(neu));
  return neu;
}
async function hkdf(salt, ikm, info, laenge) {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, laenge * 8));
}
async function verschluesseln(abo, inhalt, fest) {   // RFC 8291: ein Datensatz, Kopf mit Salz, Satzgröße und öffentlichem Schlüssel des Servers (fest: nur für den Test mit den Werten aus dem RFC)
  const ua = vonB64u(abo.keys.p256dh), auth = vonB64u(abo.keys.auth);
  const ich = fest ? fest.ich : await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const meinPub = new Uint8Array(await crypto.subtle.exportKey("raw", ich.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", ua, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const geheim = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, ich.privateKey, 256));
  const ikm = await hkdf(auth, geheim, verbinde(txt("WebPush: info\0"), ua, meinPub), 32);
  const salz = fest ? fest.salz : crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salz, ikm, txt("Content-Encoding: aes128gcm\0"), 16), nonce = await hkdf(salz, ikm, txt("Content-Encoding: nonce\0"), 12);
  const k = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const chiffre = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, k, verbinde(txt(inhalt), new Uint8Array([2]))));
  const kopf = new Uint8Array(21); kopf.set(salz, 0); new DataView(kopf.buffer).setUint32(16, 4096); kopf[20] = 65;
  return verbinde(kopf, meinPub, chiffre);
}
async function vapidKopf(env, endpoint) {   // RFC 8292: signierter Token für den Push-Dienst (Apple, Google, Mozilla)
  const v = await vapid(env), aud = new URL(endpoint).origin;
  const teil = x => b64u(txt(JSON.stringify(x)));
  const daten = teil({ typ: "JWT", alg: "ES256" }) + "." + teil({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: APP_URL.replace(/\/$/, "") });
  const key = await crypto.subtle.importKey("jwk", v.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, txt(daten));
  return `vapid t=${daten}.${b64u(sig)}, k=${v.pub}`;
}
async function pushEins(env, abo, nachricht) {
  const r = await fetch(abo.endpoint, { method: "POST", body: await verschluesseln(abo, JSON.stringify(nachricht)),
    headers: { Authorization: await vapidKopf(env, abo.endpoint), TTL: "86400", Urgency: "normal", "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream" } });
  return r.status;
}
const pushAbos = async env => (await env.PV.get("push:abos", "json")) || [];
async function pushAlle(env, nachricht) {   // an alle Geräte; abgemeldete (404, 410) fliegen raus
  const abos = await pushAbos(env);
  if (!abos.length) return false;
  const st = await Promise.all(abos.map(a => pushEins(env, a, nachricht).catch(() => 0)));
  const weg = abos.filter((a, i) => st[i] === 404 || st[i] === 410);
  if (weg.length) await env.PV.put("push:abos", JSON.stringify(abos.filter(a => !weg.includes(a))));
  return st.some(x => x >= 200 && x < 300);
}
async function ntfyAn(env) { return (await env.PV.get("push:ntfy")) !== "aus"; }
// eine Mitteilung über alle eingerichteten Wege; true, wenn mindestens einer sie angenommen hat
async function melden(env, { titel, text, tag, prio, url, ntfyTag }) {
  let ok = false;
  try { ok = await pushAlle(env, { titel, text: text.slice(0, 300), tag, url: url || "./" }); } catch (e) { /* ntfy versucht es trotzdem */ }
  const thema = (env.NTFY_TOPIC || "").trim();
  if (thema && await ntfyAn(env)) {
    try {
      const r = await fetch("https://ntfy.sh", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: thema, title: titel, message: text.slice(0, 300), tags: [ntfyTag || "bell"], priority: prio || 3, click: new URL(url || "./", APP_URL).href }) });
      ok = ok || r.ok;
    } catch (e) { /* nächster Versuch beim nächsten Lauf */ }
  }
  return ok;
}
async function pushRoute(req, env, p) {
  const ohne = x => x && typeof x.endpoint === "string" && /^https:\/\//.test(x.endpoint) && x.endpoint.length < 1000;
  if (p === "/push/schluessel") return { key: (await vapid(env)).pub };
  if (p === "/push/status") {
    const abos = await pushAbos(env);
    return { geraete: abos.length, namen: abos.map(a => a.geraet || "Gerät"), ntfy: !!(env.NTFY_TOPIC || "").trim(), ntfyAn: await ntfyAn(env), wocheAn: (await env.PV.get("push:woche")) !== "aus" };
  }
  if (p === "/push/abo" && req.method === "POST") {
    const b = await req.json().catch(() => null);
    if (!ohne(b) || !b.keys || typeof b.keys.p256dh !== "string" || typeof b.keys.auth !== "string" || b.keys.p256dh.length > 200 || b.keys.auth.length > 60) throw konto(400, "Ungültige Anmeldung für Mitteilungen");
    const abos = (await pushAbos(env)).filter(a => a.endpoint !== b.endpoint);
    abos.push({ endpoint: b.endpoint, keys: { p256dh: b.keys.p256dh, auth: b.keys.auth }, geraet: String(b.geraet || "Gerät").slice(0, 40), t: Date.now() });
    await env.PV.put("push:abos", JSON.stringify(abos.slice(-10)));
    return { ok: true, geraete: Math.min(abos.length, 10) };
  }
  if (p === "/push/abo" && req.method === "DELETE") {
    const b = await req.json().catch(() => null), abos = await pushAbos(env);
    await env.PV.put("push:abos", JSON.stringify(abos.filter(a => !b || a.endpoint !== b.endpoint)));
    return { ok: true };
  }
  if (p === "/push/test" && req.method === "POST") {
    const b = await req.json().catch(() => null), abo = (await pushAbos(env)).find(a => b && a.endpoint === b.endpoint);
    if (!abo) throw konto(404, "Dieses Gerät ist nicht angemeldet. Schalte die Mitteilungen aus und wieder ein.");
    const st = await pushEins(env, abo, { titel: "Preisvergleich", text: "So sehen die Mitteilungen aus. Preisalarme kommen jetzt auf dieses Gerät.", tag: "test", url: "./#alarm" });
    if (st < 200 || st >= 300) throw konto(400, "Der Push-Dienst hat die Mitteilung abgelehnt (" + st + ").");
    return { ok: true };
  }
  if (p === "/push/woche" && req.method === "POST") {   // Wochenüberblick an/aus, oder mit {jetzt:true} gleich senden
    const b = await req.json().catch(() => ({}));
    if (b && b.jetzt) {
      const t = await wochenUeberblick(env, (await lade(env, "angebote", "json")) || [], true);
      if (!t) throw konto(400, "Es ist kein Weg für Mitteilungen eingerichtet.");
      return { ok: true, text: t };
    }
    await env.PV.put("push:woche", b && b.an === false ? "aus" : "an");
    return { wocheAn: b && b.an !== false };
  }
  if (p === "/push/ntfy" && req.method === "POST") {
    const b = await req.json().catch(() => ({}));
    await env.PV.put("push:ntfy", b && b.an === false ? "aus" : "an");
    return { ntfyAn: await ntfyAn(env) };
  }
  throw konto(404, "Unbekannte Adresse");
}
async function ntfy(env, titel, text, tag) {   // Hinweise an den Betreiber (z. B. Passwort vergessen): über alle Wege
  await melden(env, { titel, text, tag: "hinweis", ntfyTag: tag || "bell", url: "./#mehr" });
}
async function meldeFehler(env, text) {
  await melden(env, { titel: "Preislauf fehlgeschlagen", text, tag: "fehler", prio: 4, ntfyTag: "warning" });
}

export default {
  async fetch(req, env, ctx) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(req.url), p = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (p.startsWith("/konto/")) return antwort(await kontoRoute(req, env, p));
      if (p.startsWith("/push/")) {
        if (!(await berechtigt(req, env))) return fehler("Zugangscode fehlt oder ist falsch", 401);
        return antwort(await pushRoute(req, env, p));
      }
      if (req.method === "GET") {
        if (p === "/angebote.json") return antwort(JSON.stringify(await lade(env, "angebote", "json")));
        if (p === "/alternativen.json") return antwort((await env.PV.get("alternativen")) || "[]");
        if (p === "/favoriten.json") return antwort(JSON.stringify(await lade(env, "favoriten", "json")));
        if (p === "/verlauf.csv") return antwort(await verlaufCsv(env), "text/csv; charset=utf-8");
        if (p === "/entfernungen") {
          const plz = url.searchParams.get("plz") || "";
          if (!plz || plz === PLZ) return antwort((await env.PV.get("entfernungen", "json")) || {});
          if (!plzOk(plz)) return fehler("Ungültige Postleitzahl", 400);
          const gewollt = (url.searchParams.get("m") || "").split("|").map(x => x.trim()).filter(Boolean).slice(0, 12);
          // Die Berechnung dauert bis zu 20 Sekunden: sie läuft im Hintergrund weiter, die Antwort enthält, was schon bekannt ist (die App fragt nach)
          const stand = (await env.PV.get("entf:" + plz, "json")) || {};
          const fehlt = gewollt.map(markenKern).filter(m => !stand[m]);
          if (fehlt.length && !(await env.PV.get("sperre:" + plz)) && besucherOk(req.headers.get("CF-Connecting-IP") || "?") && await tagesOk(env, "entf", 100)) {
            await env.PV.put("sperre:" + plz, "1", { expirationTtl: 60 });
            ctx.waitUntil(entfernungenPflegen(env, gewollt, plz).catch(() => {}));
          }
          return antwort(stand);
        }
        if (p === "/maerkte") { const plz = url.searchParams.get("plz") || PLZ; if (!plzOk(plz)) return fehler("Ungültige Postleitzahl", 400); return antwort(await maerkteRegion(env, plz)); }
        if (p === "/markt") return antwort(await marktAngebote(env, ctx, url.searchParams, req.headers.get("CF-Connecting-IP") || "?"));
        if (p === "/region") return antwort(await regionAngebote(env, ctx, url.searchParams, req.headers.get("CF-Connecting-IP") || "?"));
        if (p === "/namen") {
          const plz = url.searchParams.get("plz") || PLZ;
          if (!plzOk(plz)) return fehler("Ungültige Postleitzahl", 400);
          return antwort(await namenRegion(env, ctx, plz, req.headers.get("CF-Connecting-IP") || "?"));
        }
        if (p === "/korrekturen.json") return antwort((await env.PV.get("korrekturen", "json")) || {});
        if (p === "/status") return antwort({ ok: true, dienst: "preisvergleich", stand: await env.PV.get("stand", "json") });
        return env.ASSETS.fetch(req);  // die Seite selbst (index.html, Symbole, ...)
      }
      if (!(await berechtigt(req, env))) return fehler("Zugangscode fehlt oder ist falsch", 401);
      if (p === "/favoriten.json" && (req.method === "PUT" || req.method === "POST")) {
        const liste = await req.json();
        if (!Array.isArray(liste) || liste.some(f => !f || typeof f.name !== "string")) return fehler("Ungültige Favoritenliste", 400);
        await env.PV.put("favoriten", JSON.stringify(liste, null, 2));
        return antwort(liste);
      }
      if (p === "/korrekturen" && req.method === "POST") {
        // Korrekturen auffälliger Preise (Preis, Stückzahl, Größe, "passt so", "ausgeblendet"): geteilt zwischen allen Geräten mit Zugangscode
        const b = await req.json(), alt = (await env.PV.get("korrekturen", "json")) || {}, jetzt = Date.now();
        const zahl = x => Number.isFinite(x) && x > 0 && x < 1e6;
        for (const [k, v] of Object.entries(b.set || {}).slice(0, 80)) {
          if (typeof k !== "string" || k.length > 300 || !v || typeof v !== "object") continue;
          if (v.ok === true) alt[k] = { ok: true, t: jetzt };
          else if (v.aus === true) alt[k] = { aus: true, t: jetzt };
          else if (zahl(v.preis) && zahl(v.stueck) && zahl(v.ml)) alt[k] = { preis: v.preis, stueck: v.stueck, ml: v.ml, t: jetzt };
        }
        for (const k of (Array.isArray(b.del) ? b.del : []).slice(0, 200)) delete alt[k];
        const grenze = jetzt - 120 * 864e5;
        for (const [k, v] of Object.entries(alt)) if ((v.t || 0) < grenze) delete alt[k];
        if (Object.keys(alt).length > 1500) return fehler("Zu viele Korrekturen", 400);
        await env.PV.put("korrekturen", JSON.stringify(alt));
        return antwort(alt);
      }
      if (p === "/suche" && req.method === "POST") {
        // ein oder mehrere Suchbegriffe, getrennt durch "|" (bis zu 8, z. B. für den Import einer Einkaufsliste)
        const qs = [...new Set((url.searchParams.get("q") || "").split("|").map(x => x.replace(/,/g, " ").trim()).filter(Boolean))];
        if (!qs.length || qs.some(x => x.length > 60)) return fehler("Bitte einen Suchbegriff angeben", 400);
        if (qs.length > 8) return fehler("Höchstens 8 Suchbegriffe auf einmal", 400);
        const aus = (url.searchParams.get("aus") || "").split(",").map(w => w.trim().toLowerCase()).filter(Boolean);
        const { liste } = await abfragen(ctx, qs, {}, aus, undefined, url.searchParams.get("streng") === "1", url.searchParams.get("locker") === "1");
        return antwort(liste);
      }
      if (p === "/entfernungen" && req.method === "POST") {
        const gewollt = (url.searchParams.get("m") || "").split("|").map(x => x.trim()).filter(Boolean).slice(0, 30);
        return antwort(await entfernungenPflegen(env, gewollt));
      }
      if (p === "/aktualisieren" && req.method === "POST") return antwort(await aktualisieren(env, ctx));
      return fehler("Unbekannte Adresse", 404);
    } catch (e) {
      return fehler(e.message || String(e), [400, 401, 404, 409, 429].includes(e.status) ? e.status : 500);
    }
  },
  async scheduled(event, env, ctx) {
    try {
      await aktualisieren(env, ctx);
      // Wochenüberblick nur beim täglichen Lauf (nicht beim Neu-Holen von Hand oder beim Test nach dem Hochladen)
      try { await wochenUeberblick(env, (await lade(env, "angebote", "json")) || []); } catch (e) { /* nur eine Zugabe */ }
    }
    catch (e) { await meldeFehler(env, "Die tägliche Aktualisierung bei Cloudflare ist fehlgeschlagen: " + (e.message || e)); throw e; }
    finally { try { await namenRegion(env, ctx, PLZ, "", true); } catch (e) { /* nur eine Zugabe */ } }
  },
};
