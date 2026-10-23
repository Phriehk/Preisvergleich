// Mitteilungen per Web-Push: Anmeldung, verschlüsselter Inhalt (RFC 8291) und VAPID-Token (RFC 8292), gegen den echten Worker-Code
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { umgebung, wurzel } from "./browser/lib.mjs";

const b64u = b => Buffer.from(b).toString("base64url");
const vonB64u = t => new Uint8Array(Buffer.from(t, "base64url"));
const verbinde = (...l) => new Uint8Array(Buffer.concat(l.map(x => Buffer.from(x))));
async function hkdf(salt, ikm, info, n) {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, n * 8));
}
// So wie ein Browser: eigenes Schlüsselpaar und Geheimnis, damit die Nachricht entschlüsselt werden kann
async function geraet() {
  const k = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", k.publicKey)), auth = crypto.getRandomValues(new Uint8Array(16));
  return { k, pub, auth, abo: { endpoint: "https://push.example/" + b64u(auth), keys: { p256dh: b64u(pub), auth: b64u(auth) } } };
}
async function entschluesseln(g, body) {
  body = new Uint8Array(body);
  const salz = body.slice(0, 16), rs = new DataView(body.buffer, body.byteOffset).getUint32(16), idlen = body[20], serverPub = body.slice(21, 21 + idlen), chiffre = body.slice(21 + idlen);
  assert.equal(rs, 4096); assert.equal(idlen, 65);
  const sk = await crypto.subtle.importKey("raw", serverPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const geheim = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: sk }, g.k.privateKey, 256));
  const ikm = await hkdf(g.auth, geheim, verbinde(Buffer.from("WebPush: info\0"), g.pub, serverPub), 32);
  const cek = await hkdf(salz, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16), nonce = await hkdf(salz, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);
  const k = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const klar = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, k, chiffre));
  assert.equal(klar[klar.length - 1], 2, "Trennzeichen für den letzten Datensatz");
  return JSON.parse(Buffer.from(klar.slice(0, -1)).toString("utf8"));
}
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

test("Preisalarm geht per Push an alle Geräte, ntfy lässt sich abschalten, abgemeldete Geräte fliegen raus", async () => {
  const u = await umgebung({ ntfy: true }), a = await geraet(), b = await geraet();
  for (const g of [a, b]) await u.A("/push/abo", "POST", JSON.stringify(g.abo));
  await u.A("/push/ntfy", "POST", JSON.stringify({ an: false }));
  await u.KV.put("favoriten", JSON.stringify([{ name: "Milch", aus: "", alarm: { wert: 9999, einheit: "l", ml: null } }]));
  await u.A("/aktualisieren", "POST");
  assert.equal(u.ntfy.length, 0, "ntfy ist aus");
  assert.equal(u.push.length, 2);
  const n = await entschluesseln(a, u.push.find(x => x.url === a.abo.endpoint).body);
  assert.match(n.titel, /^Preisalarm Milch: 0,89 €\/l/); assert.match(n.text, /Lidl/); assert.equal(n.url, "./#produkt/Milch"); assert.equal(n.tag, "alarm:Milch");
  // ein Gerät hat sich abgemeldet (410): es wird entfernt, ntfy wieder an
  u.push.status = 410; await u.A("/push/ntfy", "POST", JSON.stringify({ an: true }));
  await u.KV.put("favoriten", JSON.stringify([{ name: "Eier", aus: "", alarm: { wert: 9999, einheit: "st", ml: null } }]));
  await u.A("/aktualisieren", "POST");
  assert.equal(u.ntfy.length, 1, "ntfy wieder an");
  assert.equal((await (await u.A("/push/status")).json()).geraete, 0, "abgemeldete Geräte entfernt");
});

test("Ohne Push-Geräte und ohne ntfy wird nichts als gemeldet vermerkt", async () => {
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
