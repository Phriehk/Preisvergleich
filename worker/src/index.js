// Preisvergleich-Server bei Cloudflare: fragt Marktguru direkt ab (Suche, tägliche Aktualisierung, Preisalarm per ntfy).
// Gleiche Logik wie test_marktguru.py. Jede Teilabfrage (ein Suchbegriff in einer Postleitzahl) läuft als eigener
// Aufruf, damit die Grenzen des kostenlosen Tarifs (10 ms Rechenzeit, 50 Abrufe je Aufruf) eingehalten werden.
import { WorkerEntrypoint } from "cloudflare:workers";

const REPO = "Phriehk/Preisvergleich";
const RAW = `https://raw.githubusercontent.com/${REPO}/main/`;
const APP_URL = "https://preise.phriehk.workers.dev/";
const UA = { "User-Agent": "Mozilla/5.0 (privates Testprojekt)" };
const SEARCH = "https://api.marktguru.de/api/v1/offers/search";
const PLZ = "47178", PLZ2 = "46535", PLZ2_MAERKTE = ["penny", "thomas philipps"], PLZ3 = "47053", PLZ3_MAERKTE = ["rewe"];
const SUCHEN = { "Coca-Cola": ["Coca-Cola", "Coca Cola", "Cola"], "Red Bull": ["Red Bull"], "Monster Energy": ["Monster Energy", "Monster"] };
const KW = { "Coca-Cola": ["coca"], "Red Bull": ["red bull", "redbull"], "Monster Energy": ["monster"] };
const AUSSCHLUSS = ["munch", "mash"];
const START_FAVS = [{ name: "Coca-Cola", aus: "" }, { name: "Red Bull", aus: "" }, { name: "Monster Energy", aus: "" }];
const GLEICHZEITIG = 4;

/* ---------- Hilfen ---------- */
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS", "Access-Control-Allow-Headers": "Authorization,Content-Type,X-Wartung", "Access-Control-Max-Age": "86400" };
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
async function schluessel(env, neu) {
  if (!neu) { const k = await env.PV.get("keys", "json"); if (k && Date.now() - k.t < 864e5) return k; }
  const html = await (await http("https://www.marktguru.de")).text();
  const api = html.match(/"apiKey"\s*:\s*"([^"]+)"/), client = html.match(/"clientKey"\s*:\s*"([^"]+)"/);
  if (!api || !client) throw new Error("Schlüssel auf marktguru.de nicht gefunden - die Seite hat sich vermutlich geändert.");
  const k = { api: api[1], client: client[1], t: Date.now() };
  await env.PV.put("keys", JSON.stringify(k));
  return k;
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
function mengenangabe(o) {
  if (o.einheit === "l" && o.volume > 0) { const n = o.quantity >= 1 ? Math.floor(o.quantity) : 1; return [n, Math.round(n * o.volume * 1e4) / 1e4]; }
  return menge(o.desc) || menge(o.name);
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
  let k = await schluessel(env), aus = [];
  for (const offset of [0, 100]) {
    const url = SEARCH + "?" + new URLSearchParams({ as: "web", limit: "100", offset: String(offset), q: suche, zipCode: plz });
    let r;
    try { r = await http(url, { "x-apikey": k.api, "x-clientkey": k.client }); }
    catch (e) { if (e.status === 401 || e.status === 403) { k = await schluessel(env, true); r = await http(url, { "x-apikey": k.api, "x-clientkey": k.client }); } else throw e; }
    const seite = (await r.json()).results || [];
    for (const o of seite) {
      const v = (o.validityDates || [{}])[0] || {};
      aus.push({ id: o.id, adv: (((o.advertisers || [{}])[0]) || {}).name || "?", name: (o.product || {}).name || "?", brand: (o.brand || {}).name || "",
        desc: o.description || "", price: o.price, einheit: (((o.unit || {}).shortName) || "").toLowerCase(), volume: o.volume, quantity: o.quantity,
        von: lokalDatum(v.from), bis: lokalDatum(v.to), bild: bildUrl(o), link: link(o) });
    }
    if (seite.length < 100) break;
  }
  return aus;
}

// Eigener Einstiegspunkt, damit jede Teilabfrage als eigener Aufruf mit eigenen Grenzen läuft
export class Teil extends WorkerEntrypoint {
  async hole(plz, suche) { return teilAbfrage(this.env, plz, suche); }
}

/* ---------- Abfrage mehrerer Produkte, Aufbereitung wie im Python-Skript ---------- */
function istProdukt(gruppe, text, extra) {
  const t = text.toLowerCase();
  let gefunden;
  if (KW[gruppe]) gefunden = KW[gruppe].some(k => t.includes(k));
  else {
    const wort = (gruppe.toLowerCase().split(/\s+/).filter(Boolean)[0] || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    gefunden = new RegExp(wort + "(?:s|e|n)?(?![a-zäöüß])").test(t);
  }
  return gefunden && ![...AUSSCHLUSS, ...extra].some(x => t.includes(x));
}

async function parallel(aufgaben, n) {
  const erg = new Array(aufgaben.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, aufgaben.length) }, async () => { while (i < aufgaben.length) { const j = i++; erg[j] = await aufgaben[j](); } }));
  return erg;
}

async function abfragen(ctx, produkte, favInfo, extraAus, plzListe = [PLZ, PLZ2, PLZ3]) {   // erste Postleitzahl = Hauptgebiet, die weiteren liefern nur ausgewählte Märkte dazu
  const HAUPT = plzListe[0];
  // produkte: Liste von Gruppennamen; favInfo: {name: {aus:[...], nur:Set}}
  const jobs = [];
  for (const p of produkte) for (const s of (SUCHEN[p] || [p])) for (const plz of plzListe) jobs.push({ p, s, plz });
  const teile = ctx.exports.Teil;
  const fehlerListe = [];
  const roh = await parallel(jobs.map(j => async () => {
    try { return await teile.hole(j.plz, j.s); } catch (e) { fehlerListe.push(`${j.s}/${j.plz}: ${e.message}`); return null; }
  }), GLEICHZEITIG);
  if (roh.every(x => x === null)) throw new Error("Marktguru nicht erreichbar: " + fehlerListe.slice(0, 2).join("; "));
  const jetzt = berlin(new Date(), true), ausgabe = [];
  for (const p of produkte) {
    const ids = new Set(), treffer = [];
    jobs.forEach((j, i) => {
      if (j.p !== p || j.plz !== HAUPT || !roh[i]) return;
      for (const o of roh[i]) if (!ids.has(o.id)) { ids.add(o.id); treffer.push(o); }
    });
    const bekannt = new Set(treffer.map(o => o.id)), zweit = new Set();
    jobs.forEach((j, i) => {
      if (j.p !== p || j.plz === HAUPT || !roh[i]) return;
      for (const o of roh[i]) {
        const name = o.adv.trim().toLowerCase();
        const passt = j.plz === PLZ2 ? PLZ2_MAERKTE.some(z => name.includes(z)) : PLZ3_MAERKTE.includes(name) && !bekannt.has(o.id);
        const key = j.plz + "|" + o.id;
        if (passt && !zweit.has(key)) { zweit.add(key); treffer.push({ ...o, plz: j.plz }); }
      }
    });
    const info = favInfo[p] || { aus: extraAus, nur: new Set() };
    for (const o of treffer) {
      const mg = mengenangabe(o), l = mg ? mg[1] : null, st = mg ? mg[0] : 1;
      const kandidat = (o.brand || o.name).trim().toLowerCase();
      let coke = istProdukt(p, `${o.brand} ${o.name} ${o.desc}`, info.aus.length ? info.aus : extraAus);
      if (info.nur.size && !info.nur.has(kandidat)) coke = false;
      ausgabe.push({ abgefragt: jetzt, gruppe: p, bild: o.bild, marke: o.brand, coke, link: o.link, markt: o.adv + (o.plz ? ` (${o.plz})` : ""), produkt: o.name,
        beschreibung: o.desc, preis: o.price, liter: l, stueck: st, ml: l && st ? Math.round(l * 1000 / st) : null,
        preis_pro_liter: o.price && l ? Math.round(o.price / l * 100) / 100 : null, gueltig_von: o.von, gueltig_bis: o.bis });
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
  return { liste, fehler: fehlerListe };
}

/* ---------- Gespeicherte Daten (beim ersten Start aus dem GitHub-Repository übernommen) ---------- */
async function lade(env, name, typ) {
  let v = await env.PV.get(name, typ === "json" ? "json" : "text");
  if (v !== null) return v;
  const datei = { favoriten: "favoriten.json", angebote: "angebote.json", benachrichtigt: "benachrichtigt.json" }[name];
  try {
    const r = await fetch(RAW + datei, { headers: UA });
    if (r.ok) { const t = await r.text(); await env.PV.put(name, t); return typ === "json" ? JSON.parse(t) : t; }
  } catch (e) { /* weiter mit Standardwert */ }
  return name === "favoriten" ? START_FAVS : typ === "json" ? (name === "angebote" ? [] : {}) : "";
}

function favAuswerten(favs) {
  const info = {}, alarm = {};
  for (const f of favs || []) {
    if (!f || !f.name) continue;
    info[f.name] = { aus: String(f.aus || "").split(",").map(w => w.trim().toLowerCase()).filter(Boolean), nur: new Set((f.nur || []).map(k => String(k).trim().toLowerCase())) };
    const al = f.alarm;
    if (al && ["l", "stueck"].includes(al.einheit) && +al.wert > 0) alarm[f.name] = { wert: +al.wert, einheit: al.einheit, ml: al.ml ? +al.ml : null };
  }
  return { info, alarm };
}

const de = x => x.toFixed(2).replace(".", ",");
const kurz = iso => iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.` : "";
const nochNicht = x => x.gueltig_von && tageBis(x.gueltig_von) > 0;
const abgelaufen = x => x.gueltig_bis && tageBis(x.gueltig_bis) < 0;

async function benachrichtige(env, liste, alarm) {
  const thema = (env.NTFY_TOPIC || "").trim();
  if (!thema || !Object.keys(alarm).length) return [];
  let gemeldet = await lade(env, "benachrichtigt", "json");
  const grenze = berlin(new Date(Date.now() - 60 * 864e5));
  gemeldet = Object.fromEntries(Object.entries(gemeldet || {}).filter(([, d]) => d >= grenze));
  const gesendet = [];
  for (const [gruppe, al] of Object.entries(alarm)) {
    const treffer = [];
    for (const x of liste) {
      if (x.gruppe !== gruppe || !x.preis || abgelaufen(x)) continue;
      if (al.ml && x.ml !== al.ml) continue;
      const wert = al.einheit === "l" ? x.preis_pro_liter : (x.stueck ? x.preis / x.stueck : null);
      if (wert != null && wert <= al.wert) treffer.push([wert, x]);
    }
    if (!treffer.length) continue;
    treffer.sort((a, b) => a[0] - b[0]);
    const [wert, x] = treffer[0];
    const sch = [gruppe, x.markt, x.preis, x.liter, x.gueltig_bis].join("|");
    if (gemeldet[sch]) continue;
    const einheit = al.einheit === "l" ? "€/l" : "€/Stück";
    const wann = nochNicht(x) ? `Ab ${kurz(x.gueltig_von)}` : x.gueltig_bis ? `Bis ${kurz(x.gueltig_bis)}` : "";
    const text = `${x.markt}: ${de(wert)} ${einheit} (${x.stueck > 1 ? x.stueck + " × " : ""}${x.produkt}${x.ml ? ", " + x.ml + " ml" : ""} für ${de(x.preis)} €). ${wann}`.trim();
    try {
      const r = await fetch("https://ntfy.sh", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: thema, title: `Preisalarm ${gruppe}: ${de(wert)} ${einheit}`, message: text, tags: ["moneybag"], priority: 3, click: APP_URL }) });
      if (r.ok) { gemeldet[sch] = heute(); gesendet.push(text); }
    } catch (e) { /* nächster Lauf versucht es erneut */ }
  }
  await env.PV.put("benachrichtigt", JSON.stringify(gemeldet));
  return gesendet;
}

function csvFeld(v) { const s = v == null ? "" : String(v); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }

const KOPF = "datum;markt;produkt;liter;preis;preis_pro_liter;gueltig_bis;gueltig_von;gruppe";
async function verlaufMonate(env) {
  let m = await env.PV.get("verlauf:monate", "json");
  if (m) return m;
  let alt = "";  // erster Start: bisherigen Verlauf aus dem GitHub-Repository übernehmen
  try { const r = await fetch(RAW + "verlauf.csv", { headers: UA }); if (r.ok) alt = await r.text(); } catch (e) { /* ohne alten Verlauf weiter */ }
  await env.PV.put("verlauf:alt", alt.split(/\r?\n/).filter(z => z.trim() && !z.startsWith("datum;")).join("\n"));
  m = ["alt"];
  await env.PV.put("verlauf:monate", JSON.stringify(m));
  return m;
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
  const { liste, fehler: f } = await abfragen(ctx, produkte, info, []);
  if (!liste.length) throw new Error("Marktguru hat für keines der Produkte Angebote geliefert. Die bisherigen Daten bleiben unverändert." + (f.length ? " " + f[0] : ""));
  await env.PV.put("angebote", JSON.stringify(liste));
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
  for (const host of ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter", "https://overpass.private.coffee/api/interpreter"]) {
    try {
      const r = await fetch(host, { method: "POST", headers: { ...OSM_UA, "Content-Type": "application/x-www-form-urlencoded" }, body: "data=" + encodeURIComponent(abfrage) });
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
async function regionAngebote(env, ctx, sp) {
  const plz = sp.get("plz") || "";
  if (!plzOk(plz)) throw Object.assign(new Error("Ungültige Postleitzahl"), { status: 400 });
  const begriffe = [...new Set((sp.get("q") || "").split("|").map(x => x.replace(/,/g, " ").trim()).filter(x => x && x.length <= 40))].slice(0, 6);
  if (!begriffe.length) throw Object.assign(new Error("Bitte einen Suchbegriff angeben"), { status: 400 });
  const roh = new TextEncoder().encode(begriffe.map(x => x.toLowerCase()).sort().join("|"));
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", roh))].slice(0, 8).map(b => b.toString(16).padStart(2, "0")).join("");
  const key = "reg:" + plz + ":" + hash, frisch = sp.get("neu") === "1";
  const alt = await env.PV.get(key, "json");
  if (alt && Date.now() - alt.t < (frisch ? 15 * 60e3 : 3 * 3600e3)) return alt.liste;
  const { info } = favAuswerten(await lade(env, "favoriten", "json"));
  const { liste } = await abfragen(ctx, begriffe, info, [], [plz]);
  await env.PV.put(key, JSON.stringify({ t: Date.now(), liste }), { expirationTtl: 86400 });
  return liste;
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

async function meldeFehler(env, text) {
  const thema = (env.NTFY_TOPIC || "").trim();
  if (!thema) return;
  try {
    await fetch("https://ntfy.sh", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic: thema, title: "Preislauf fehlgeschlagen", message: text.slice(0, 300), tags: ["warning"], priority: 4, click: APP_URL }) });
  } catch (e) { /* mehr kann nicht getan werden */ }
}

export default {
  async fetch(req, env, ctx) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(req.url), p = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (req.method === "GET") {
        if (p === "/angebote.json") return antwort(JSON.stringify(await lade(env, "angebote", "json")));
        if (p === "/favoriten.json") return antwort(JSON.stringify(await lade(env, "favoriten", "json")));
        if (p === "/verlauf.csv") return antwort(await verlaufCsv(env), "text/csv; charset=utf-8");
        if (p === "/entfernungen") {
          const plz = url.searchParams.get("plz") || "";
          if (!plz || plz === PLZ) return antwort((await env.PV.get("entfernungen", "json")) || {});
          if (!plzOk(plz)) return fehler("Ungültige Postleitzahl", 400);
          const gewollt = (url.searchParams.get("m") || "").split("|").map(x => x.trim()).filter(Boolean).slice(0, 12);
          return antwort(gewollt.length ? await entfernungenPflegen(env, gewollt, plz) : ((await env.PV.get("entf:" + plz, "json")) || {}));
        }
        if (p === "/region") return antwort(await regionAngebote(env, ctx, url.searchParams));
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
      if (p === "/suche" && req.method === "POST") {
        const q = (url.searchParams.get("q") || "").replace(/,/g, " ").trim();
        if (!q || q.length > 60) return fehler("Bitte einen Suchbegriff angeben", 400);
        const aus = (url.searchParams.get("aus") || "").split(",").map(w => w.trim().toLowerCase()).filter(Boolean);
        const { liste } = await abfragen(ctx, [q], {}, aus);
        return antwort(liste);
      }
      if (p === "/entfernungen" && req.method === "POST") {
        const gewollt = (url.searchParams.get("m") || "").split("|").map(x => x.trim()).filter(Boolean).slice(0, 30);
        return antwort(await entfernungenPflegen(env, gewollt));
      }
      if (p === "/aktualisieren" && req.method === "POST") return antwort(await aktualisieren(env, ctx));
      return fehler("Unbekannte Adresse", 404);
    } catch (e) {
      return fehler(e.message || String(e), e.status === 400 ? 400 : 500);
    }
  },
  async scheduled(event, env, ctx) {
    try { await aktualisieren(env, ctx); }
    catch (e) { await meldeFehler(env, "Die tägliche Aktualisierung bei Cloudflare ist fehlgeschlagen: " + (e.message || e)); throw e; }
  },
};
