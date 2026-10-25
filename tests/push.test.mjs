// Mitteilungen per Web-Push: Anmeldung, verschlüsselter Inhalt (RFC 8291) und VAPID-Token (RFC 8292), gegen den echten Worker-Code
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { umgebung, wurzel, geraet, entschluesseln } from "./browser/lib.mjs";

const b64u = b => Buffer.from(b).toString("base64url");
const vonB64u = t => new Uint8Array(Buffer.from(t, "base64url"));
async function tokenPruefen(kopf, endpoint) {
  const m = kopf.match(/^vapid t=([^,]+), k=(.+)$/); assert.ok(m, kopf);
  const [h, c, sig] = m[1].split("."), claims = JSON.parse(Buffer.from(c, "base64url").toString());
  assert.equal(JSON.parse(Buffer.from(h, "base64url").toString()).alg, "ES256");
  assert.equal(claims.aud, new URL(endpoint).origin);
  assert.ok(claims.exp > Date.now() / 1000 && claims.exp <= Date.now() / 1000 + 24 * 3600, "höchstens 24 Stunden gültig");
  assert.match(claims.sub, /^https:\/\//);
  const pub = await crypto.subtle.importKey("raw", vonB64u(m[2]), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  assert.ok(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, vonB64u(sig), Buffer.from(h + "." + c)), "Signatur stimmt");
  return m[2];
}

test("Gerät anmelden, Testmitteilung kommt verschlüsselt und signiert an", async () => {
  const u = await umgebung(), g = await geraet();
  assert.equal((await u.H.fetch(new Request("https://preise.phriehk.workers.dev/push/schluessel"), u.env, u.ctx)).status, 401, "nur mit Zugangscode");
  const { key } = await (await u.A("/push/schluessel")).json();
  assert.equal(vonB64u(key).length, 65);
  assert.equal((await (await u.A("/push/schluessel")).json()).key, key, "der Schlüssel bleibt gleich");
  assert.equal((await (await u.A("/push/abo", "POST", JSON.stringify({ ...g.abo, geraet: "iPhone" }))).json()).geraete, 1);
  assert.deepEqual((await (await u.A("/push/status")).json()).namen, ["iPhone"]);
  const r = await u.A("/push/test", "POST", JSON.stringify({ endpoint: g.abo.endpoint }));
  assert.equal(r.status, 200, await r.text());
  assert.equal(u.push.length, 1);
  const { headers, body } = u.push[0];
  assert.equal(headers["Content-Encoding"], "aes128gcm"); assert.ok(+headers.TTL > 0);
  assert.equal(await tokenPruefen(headers.Authorization, g.abo.endpoint), key);
  const n = await entschluesseln(g, body);
  assert.equal(n.titel, "Preisvergleich"); assert.match(n.text, /Preisalarme/); assert.equal(n.url, "./#alarm");
  await u.A("/push/abo", "DELETE", JSON.stringify({ endpoint: g.abo.endpoint }));
  assert.equal((await (await u.A("/push/status")).json()).geraete, 0);
});

test("Preisalarm geht per Push an alle Geräte, abgemeldete Geräte fliegen raus, nichts geht an ntfy", async () => {
  const u = await umgebung({}), a = await geraet(), b = await geraet();
  for (const g of [a, b]) await u.A("/push/abo", "POST", JSON.stringify(g.abo));
  await u.KV.put("favoriten", JSON.stringify([{ name: "Milch", aus: "", alarm: { wert: 9999, einheit: "l", ml: null } }]));
  await u.A("/aktualisieren", "POST");
  assert.equal(u.push.length, 2);
  const n = await entschluesseln(a, u.push.find(x => x.url === a.abo.endpoint).body);
  assert.match(n.titel, /^Preisalarm Milch: 0,89 €\/l/); assert.match(n.text, /Lidl/); assert.equal(n.url, "./#produkt/Milch"); assert.equal(n.tag, "alarm:Milch");
  // die Geräte haben sich abgemeldet (410): sie werden entfernt
  u.push.status = 410;
  await u.KV.put("favoriten", JSON.stringify([{ name: "Eier", aus: "", alarm: { wert: 9999, einheit: "st", ml: null } }]));
  await u.A("/aktualisieren", "POST");
  assert.equal((await (await u.A("/push/status")).json()).geraete, 0, "abgemeldete Geräte entfernt");
  assert.equal((await u.A("/push/ntfy", "POST", "{}")).status, 404, "ntfy gibt es nicht mehr");
  assert.equal(u.ntfy.length, 0);
});

test("Ohne Push-Geräte wird nichts als gemeldet vermerkt", async () => {
  const u = await umgebung();
  await u.KV.put("favoriten", JSON.stringify([{ name: "Milch", aus: "", alarm: { wert: 9999, einheit: "l", ml: null } }]));
  const r = await (await u.A("/aktualisieren", "POST")).json();
  assert.deepEqual(r.alarm || [], []);
  const g = await geraet(); await u.A("/push/abo", "POST", JSON.stringify(g.abo));
  await u.A("/aktualisieren", "POST");
  assert.equal(u.push.length, 1, "sobald ein Gerät angemeldet ist, kommt die Meldung");
});

test("Verschlüsselung entspricht dem Beispiel aus RFC 8291 (Anhang A)", async () => {
  // Worker-Code laden und die Verschlüsselung für den Test sichtbar machen
  const q = fs.readFileSync(path.join(wurzel, "worker/src/index.js"), "utf8")
    .replace(/^import \{ WorkerEntrypoint \} from "cloudflare:workers";/m, "class WorkerEntrypoint{}") + "\nexport { verschluesseln };";
  const datei = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pv-push-")), "w.mjs"); fs.writeFileSync(datei, q);
  const { verschluesseln } = await import(pathToFileURL(datei).href);
  const asPub = vonB64u("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8");
  const jwk = { kty: "EC", crv: "P-256", d: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw", x: b64u(asPub.slice(1, 33)), y: b64u(asPub.slice(33)) };
  const priv = await crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const pub = await crypto.subtle.importKey("raw", asPub, { name: "ECDH", namedCurve: "P-256" }, true, []);
  const abo = { endpoint: "https://push.example/rfc", keys: { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" } };
  const body = await verschluesseln(abo, "When I grow up, I want to be a watermelon", { ich: { privateKey: priv, publicKey: pub }, salz: vonB64u("DGv6ra1nlYgDCS1FRnbzlw") });
  assert.equal(b64u(body), "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN");
});

test("Hintergrunddienst (sw.js): Mitteilung zeigen, Tipp darauf öffnet die App am richtigen Ort", async () => {
  const h = {}, gezeigt = [], nachrichten = [], geoeffnet = [];
  const self = { addEventListener: (t, f) => { h[t] = f; }, skipWaiting() {}, registration: { scope: "https://preise.phriehk.workers.dev/", showNotification: async (t, o) => { gezeigt.push([t, o]); } },
    clients: { fenster: [], matchAll: async () => self.clients.fenster, openWindow: async u => { geoeffnet.push(u); } } };
  new Function("self", "caches", "location", fs.readFileSync(path.join(wurzel, "sw.js"), "utf8"))(self, {}, { origin: "https://preise.phriehk.workers.dev" });
  let warte;
  h.push({ data: { json: () => ({ titel: "Preisalarm Milch: 0,89 €/l", text: "Lidl: …", tag: "alarm:Milch", url: "./#produkt/Milch" }) }, waitUntil: p => { warte = p; } });
  await warte;
  assert.equal(gezeigt[0][0], "Preisalarm Milch: 0,89 €/l"); assert.equal(gezeigt[0][1].tag, "alarm:Milch"); assert.equal(gezeigt[0][1].data.url, "./#produkt/Milch");
  // App geschlossen: neues Fenster am Ziel
  h.notificationclick({ notification: { data: gezeigt[0][1].data, close() {} }, waitUntil: p => { warte = p; } }); await warte;
  assert.deepEqual(geoeffnet, ["https://preise.phriehk.workers.dev/#produkt/Milch"]);
  // App offen: nach vorne holen und hinwechseln
  self.clients.fenster = [{ url: "https://preise.phriehk.workers.dev/#angebote", focus: async () => {}, postMessage: m => nachrichten.push(m) }];
  h.notificationclick({ notification: { data: gezeigt[0][1].data, close() {} }, waitUntil: p => { warte = p; } }); await warte;
  assert.deepEqual(nachrichten, [{ typ: "oeffnen", url: "https://preise.phriehk.workers.dev/#produkt/Milch" }]);
  // ohne lesbaren Inhalt trotzdem eine Mitteilung (iOS verlangt bei jedem Push eine)
  h.push({ data: null, waitUntil: p => { warte = p; } }); await warte;
  assert.equal(gezeigt[1][0], "Preisvergleich");
});

test("„Passwort vergessen“ meldet sich beim Betreiber, nur nicht beim automatischen Test nach dem Hochladen", async () => {
  const u = await umgebung({ geraet: true }); u.env.WARTUNG = "testschluessel";
  const R = (pfad, body, kopf = {}) => u.H.fetch(new Request("https://preise.phriehk.workers.dev" + pfad, { method: "POST", headers: { "Content-Type": "application/json", ...kopf }, body: JSON.stringify(body) }), u.env, u.ctx);
  for (const n of ["test1", "anna"]) assert.equal((await R("/konto/neu", { name: n, dk: "a".repeat(64) })).status, 200);
  await R("/konto/vergessen", { name: "test1" }, { "X-Wartung": "testschluessel" });
  assert.equal((await u.mitteilungen()).length, 0, "Test: keine Mitteilung");
  await R("/konto/vergessen", { name: "anna" });
  const m = await u.mitteilungen();
  assert.equal(m.length, 1); assert.equal(m[0].titel, "Passwort vergessen"); assert.match(m[0].text, /anna/); assert.equal(m[0].url, "./#mehr");
});

test("Wochenüberblick: montags einmal die guten Angebote (unter dem Durchschnitt oder mit „statt“-Preis), abschaltbar", async () => {
  const u = await umgebung(), g = await geraet();
  await u.A("/push/abo", "POST", JSON.stringify(g.abo));
  await u.KV.put("favoriten", JSON.stringify([{ name: "Butter", aus: "" }, { name: "Milch", aus: "" }, { name: "Eier", aus: "" }]));
  // Verlauf: Butter kostete zuletzt etwa 9 €/kg, Eier wie jetzt
  const zeilen = {};
  for (let k = 2; k <= 12; k++) {
    const d = new Date(Date.now() - k * 864e5).toISOString().slice(0, 10);
    (zeilen[d.slice(0, 7)] = zeilen[d.slice(0, 7)] || []).push(`${d};PENNY;Butter;0.25;2.25;9;;;Butter`, `${d};ALDI SÜD;Freiland-Eier;10;2.29;0.229;;;Eier`);
  }
  for (const [m, z] of Object.entries(zeilen)) await u.KV.put("verlauf:" + m, z.join("\n"));
  await u.KV.put("verlauf:monate", JSON.stringify(Object.keys(zeilen).sort()));
  const lauf = () => u.H.scheduled({}, u.env, u.ctx);   // der tägliche Lauf
  u.env.WOCHENTAG_TEST = 3;   // Mittwoch: kein Überblick
  await lauf();
  assert.equal(u.push.length, 0);
  u.env.WOCHENTAG_TEST = 1;   // Montag
  await lauf();
  assert.equal(u.push.length, 1);
  const n = await entschluesseln(g, u.push[0].body);
  assert.equal(n.titel, "Diese Woche günstig: 2 Favoriten"); assert.equal(n.url, "./#angebote");
  assert.match(n.text, /Butter 3,49 € bei REWE \(−22 %\)/); assert.match(n.text, /Milch 0,89 € bei Lidl \(statt 1,09 €\)/); assert.doesNotMatch(n.text, /Eier/);
  await lauf();
  assert.equal(u.push.length, 1, "nur einmal am Montag");
  // abschalten; „jetzt senden“ geht trotzdem
  assert.equal((await (await u.A("/push/woche", "POST", JSON.stringify({ an: false }))).json()).wocheAn, false);
  assert.equal((await (await u.A("/push/status")).json()).wocheAn, false);
  await u.KV.delete("woche:gesendet"); await lauf();
  assert.equal(u.push.length, 1, "aus");
  assert.equal((await u.A("/push/woche", "POST", JSON.stringify({ jetzt: true }))).status, 200);
  assert.equal(u.push.length, 2);
});
