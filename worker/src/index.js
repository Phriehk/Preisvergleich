// Preisvergleich-Server bei Cloudflare: fragt Marktguru direkt ab (Suche, tägliche Aktualisierung, Preisalarm per ntfy).
// Gleiche Logik wie test_marktguru.py. Jede Teilabfrage (ein Suchbegriff in einer Postleitzahl) läuft als eigener
// Aufruf, damit die Grenzen des kostenlosen Tarifs (10 ms Rechenzeit, 50 Abrufe je Aufruf) eingehalten werden.
import { WorkerEntrypoint } from "cloudflare:workers";

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

/* ---------- Gespeicherte Daten (liegen im Cloudflare-Speicher KV) ---------- */
async function lade(env, name, typ) {
  const v = await env.PV.get(name, typ === "json" ? "json" : "text");
  if (v !== null) return v;
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
  const key = "reg:" + plz + ":" + hash, frisch = sp.get("neu") === "1";
  const alt = await env.PV.get(key, "json");
  if (alt && Date.now() - alt.t < (frisch ? 15 * 60e3 : 3 * 3600e3)) return alt.liste;
  if (!besucherOk(ip) || !(await tagesOk(env, "region", 300))) throw zuViel();
  const { info } = favAuswerten(await lade(env, "favoriten", "json"));
  const { liste } = await abfragen(ctx, begriffe, info, [], [plz]);
  await env.PV.put(key, JSON.stringify({ t: Date.now(), liste }), { expirationTtl: 86400 });
  return liste;
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
function datenPruefen(d) {   // nur erwartete Felder und Größen werden gespeichert
  const o = {};
  if (d && d.ort && Number.isFinite(+d.ort.lat) && Number.isFinite(+d.ort.lon)) o.ort = { lat: +d.ort.lat, lon: +d.ort.lon, name: String(d.ort.name || "").slice(0, 120), plz: /^\d{5}$/.test(d.ort.plz) ? d.ort.plz : "", angebote: d.ort.angebote !== false };
  if (d && Number.isFinite(+d.km) && +d.km >= 0 && +d.km < 5) o.km = +d.km;
  if (d && Array.isArray(d.eink)) o.eink = d.eink.filter(x => typeof x === "string" && x.length < 300).slice(0, 100);
  if (d && d.zettel && typeof d.zettel === "object" && !Array.isArray(d.zettel)) {   // Einkaufszettel: Favorit -> Liter
    o.zettel = {};
    for (const [k, v] of Object.entries(d.zettel).slice(0, 60)) if (k.length <= 60 && Number.isFinite(+v) && +v > 0 && +v <= 500) o.zettel[k] = +v;
  }
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
    u.daten = datenPruefen(b.daten);
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
    await ntfy(env, "Passwort vergessen", `Benutzer „${name}“ möchte ein neues Passwort. Prüfe, ob die Person wirklich du kennst, und erzeuge in der Seite unter Konto einen Code.`, "key");
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

async function ntfy(env, titel, text, tag) {
  const thema = (env.NTFY_TOPIC || "").trim();
  if (!thema) return;
  try {
    await fetch("https://ntfy.sh", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic: thema, title: titel, message: text.slice(0, 300), tags: [tag || "bell"], priority: 3, click: APP_URL }) });
  } catch (e) { /* die Anfrage bleibt trotzdem in der Liste */ }
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
      if (p.startsWith("/konto/")) return antwort(await kontoRoute(req, env, p));
      if (req.method === "GET") {
        if (p === "/angebote.json") return antwort(JSON.stringify(await lade(env, "angebote", "json")));
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
        if (p === "/region") return antwort(await regionAngebote(env, ctx, url.searchParams, req.headers.get("CF-Connecting-IP") || "?"));
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
      return fehler(e.message || String(e), [400, 401, 404, 409, 429].includes(e.status) ? e.status : 500);
    }
  },
  async scheduled(event, env, ctx) {
    try { await aktualisieren(env, ctx); }
    catch (e) { await meldeFehler(env, "Die tägliche Aktualisierung bei Cloudflare ist fehlgeschlagen: " + (e.message || e)); throw e; }
  },
};
