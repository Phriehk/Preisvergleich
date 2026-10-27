// Kassenbon mit Google Cloud Vision: Server reicht das Bild mit geheimem Schlüssel weiter (Monatsgrenze), die Seite setzt die Zeilen aus den Wörtern zusammen
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { umgebung, wurzel, visionAntwort } from "./browser/lib.mjs";

const html = fs.readFileSync(path.join(wurzel, "index.html"), "utf8");
const a = html.indexOf("function bonZeilenAusWoertern("), b = html.indexOf("\n/* ---------- Prospekt als PDF", a);
const bonZeilenAusWoertern = new Function(html.slice(a, b) + "\nreturn bonZeilenAusWoertern;")();
const bild = "A".repeat(4000);   // Base64 eines Bildes (Inhalt egal, Google ist nachgebaut)

test("Zeilen aus Wörtern: Name und Preis wieder in einer Zeile, auch schräg und spaltenweise geliefert", () => {
  const z = ["ALDI SUED", "KERRYGOLD BUTTER|1,99 A", "FREILAND-EIER|2,29 A", "SUMME|4,28"];
  assert.equal(bonZeilenAusWoertern(visionAntwort(z).responses[0].textAnnotations), "ALDI SUED\nKERRYGOLD BUTTER 1,99 A\nFREILAND-EIER 2,29 A\nSUMME 4,28");
  assert.equal(bonZeilenAusWoertern(visionAntwort(z, { schraeg: -0.05 }).responses[0].textAnnotations).split("\n")[1], "KERRYGOLD BUTTER 1,99 A");
  // Komma als eigenes Wort direkt am Betrag: ohne Leerzeichen
  const ta = [{ description: "x" }, ...[["MILCH", 40, 120], ["0", 600, 50], [",", 618, 14], ["99", 632, 36]].map(([d, x, w]) => ({ description: d, boundingPoly: { vertices: [{ x, y: 100 }, { x: x + w, y: 100 }, { x: x + w, y: 130 }, { x, y: 130 }] } }))];
  assert.equal(bonZeilenAusWoertern(ta), "MILCH 0,99");
  assert.equal(bonZeilenAusWoertern([{ description: "nur Text" }]), "nur Text");
  assert.equal(bonZeilenAusWoertern([]), "");
});

test("Server: nur mit Code, ohne Schlüssel 501, Bild geprüft, Schlüssel bleibt geheim, Monatsgrenze", async () => {
  const ohne = await umgebung({});
  assert.equal((await ohne.A("/bon/text", "POST", bild)).status, 501);
  assert.equal((await ohne.A("/status")).status, 200);
  assert.equal((await (await ohne.A("/status")).json()).vision, false);
  const u = await umgebung({ vision: visionAntwort(["KERRYGOLD BUTTER|1,99 A"]) });
  assert.equal((await (await u.A("/status")).json()).vision, true);
  const fremd = await u.H.fetch(new Request("https://angebote.vergleichen.workers.dev/bon/text", { method: "POST", body: bild }), u.env, u.ctx);
  assert.equal(fremd.status, 401);
  assert.equal((await u.A("/bon/text", "POST", "kein-bild")).status, 400);
  assert.equal(u.vision.length, 0, "ungültige Bilder gehen nicht an Google");
  const r = await u.A("/bon/text", "POST", bild);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.responses[0].textAnnotations.length, 5);
  assert.match(u.vision[0].url, /^https:\/\/vision\.googleapis\.com\/v1\/images:annotate\?key=vision-schluessel&fields=/);
  const anfrage = JSON.parse(u.vision[0].body);
  assert.equal(anfrage.requests[0].image.content, bild); assert.equal(anfrage.requests[0].features[0].type, "DOCUMENT_TEXT_DETECTION");
  assert.ok(!JSON.stringify(j).includes("vision-schluessel"));
  const monat = new Date().toISOString().slice(0, 7);
  assert.equal(u.store.get("vision:" + monat), "1");
  // Fehler bei Google: verständliche Meldung
  u.vision.status = 400;
  const f = await u.A("/bon/text", "POST", bild);
  assert.equal(f.status, 502); assert.match((await f.json()).fehler, /Schlüssel/);
  u.vision.status = 0;
  // Monatsgrenze (kostenloser Rahmen)
  u.store.set("vision:" + monat, "900");
  const g = await u.A("/bon/text", "POST", bild);
  assert.equal(g.status, 429); assert.match((await g.json()).fehler, /auf dem Gerät/);
});
