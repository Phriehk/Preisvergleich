// Prospekte als PDF: die Seite liest Name, Preis und früheren Preis (pdf.js), der Server merkt sich die früheren Preise als Normalpreise
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { umgebung, wurzel, PDFJS_DIR, pdfMachen, prospektSeiten } from "./browser/lib.mjs";

const html = fs.readFileSync(path.join(wurzel, "index.html"), "utf8");
const a = html.indexOf("const PR_P1="), b = html.indexOf("</script>", a);
const { prospektSeite, prospektKopf } = new Function(html.slice(a, b) + "\nreturn {prospektSeite, prospektKopf};")();

async function lies(daten) {   // wie in der Seite: Textstücke je Seite mit Lage und Schriftgröße
  const pdfjs = await import(pathToFileURL(path.join(PDFJS_DIR, "legacy/build/pdf.mjs")).href);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(daten), isEvalSupported: false, disableFontFace: true }).promise, aus = [];
  let text = "";
  for (let s = 1; s <= doc.numPages; s++) {
    const pg = await doc.getPage(s), H = pg.getViewport({ scale: 1 }).height;
    const it = (await pg.getTextContent()).items.filter(i => i.str && i.str.trim()).map(i => ({ s: i.str.trim(), x: i.transform[4], y: H - i.transform[5], h: Math.hypot(i.transform[2], i.transform[3]), w: i.width, f: i.fontName }));
    text += it.map(i => i.s).join(" ") + " ";
    aus.push(...prospektSeite(it, s));
  }
  return { angebote: aus, kopf: prospektKopf(text, "2026-10-25") };
}

test("PDF lesen: Preis zum Grundpreis, früherer Preis mit Prozent, UVP, Markt und Gültigkeit", { skip: !PDFJS_DIR && "pdf.js nicht installiert" }, async () => {
  const { angebote, kopf } = await lies(pdfMachen(prospektSeiten("PENNY", new Date("2026-10-26T12:00:00"))));
  assert.deepEqual(kopf, { markt: "PENNY", von: "2026-10-26", bis: "2026-10-31" });
  const k = x => `${x.name} ${x.preis}${x.statt ? (x.uvp ? " UVP " : " statt ") + x.statt : ""}${x.sicher ? " ✓" : ""}${x.stattSicher ? " ✓" : ""}`;
  assert.deepEqual(angebote.map(k).sort(), [
    "Milka Schokolade 0.95 UVP 1.99 ✓ ✓",
    "Weihenstephan Butter 1.79 statt 2.49 ✓ ✓",
    "Weihenstephan Butter 2.49 ✓",
    "Zewa Toilettenpapier 6.99 UVP 8.39 ✓",   // ohne Grundpreis: Preis nur aus der Lage, der frühere Preis über die Prozente bestätigt
  ]);
  assert.equal(angebote.find(x => x.preis === 1.79).rest, "gesalzen, gekühlt 250 g (7.16 / kg)");
});

test("Kopf: Markt und Gültigkeit in verschiedenen Schreibweisen", () => {
  assert.deepEqual(prospektKopf("MONTAG, 26.10. – SAMSTAG, 31.10. 2026 Alle Filialangebote auch unter filiale.kaufland.de", "2026-10-25"), { markt: "Kaufland", von: "2026-10-26", bis: "2026-10-31" });
  assert.deepEqual(prospektKopf("Montag 26.10. – Samstag 31.10.26 ... netto-online.de", "2026-10-25"), { markt: "Netto Marken-Discount", von: "2026-10-26", bis: "2026-10-31" });
  assert.deepEqual(prospektKopf("44. Woche 2026. Gültig ab 26.10.2026 REWE REWE", "2026-10-25"), { markt: "REWE", von: "2026-10-26", bis: "2026-10-31" });
  assert.deepEqual(prospektKopf("Gültig von Mo. 28.12. – Sa. 2.1. ALDI SÜD", "2026-12-27"), { markt: "ALDI SÜD", von: "2026-12-28", bis: "2027-01-02" });
  assert.equal(prospektKopf("nur Text", "2026-10-25").markt, "");
});

test("Server: Prospekt speichern, Normalpreise je Favorit, Angebote ergänzen, entfernen; nur mit Code", async () => {
  const u = await umgebung({});
  await u.KV.put("favoriten", JSON.stringify([{ name: "Butter", aus: "" }, { name: "Schokolade", aus: "" }, { name: "Eier", aus: "" }]));
  await u.A("/aktualisieren", "POST");
  const h = new Date().toISOString().slice(0, 10), bis = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
  const body = { markt: "PENNY", von: h, bis, angebote: [
    { t: "Weihenstephan Butter", q: "gesalzen, gekühlt 250 g (7.16 / kg)", p: 1.79, alt: 2.49 },
    { t: "Milka Schokolade", q: "versch. Sorten 100 g (9.50 / kg)", p: 0.95, alt: 1.99, uvp: 1 },
    { t: "Zewa Toilettenpapier", q: "16 x 150 Blatt", p: 6.99 }, { t: "x", p: 1 }, { t: "Ohne Preis", p: 0 }] };
  const ohne = await u.H.fetch(new Request("https://preise.phriehk.workers.dev/prospekt", { method: "POST", body: JSON.stringify(body) }), u.env, u.ctx);
  assert.equal(ohne.status, 401);
  const r = await (await u.A("/prospekt", "POST", JSON.stringify(body))).json();
  assert.equal(r.markt, "PENNY"); assert.equal(r.angebote, 3); assert.equal(r.statt, 2);
  assert.equal(r.gruppen, 2, "Butter und Schokolade"); assert.ok(r.ergaenzt >= 1, JSON.stringify(r));
  const np = JSON.parse(u.store.get("normalpreise"));
  const butter = np.find(x => x.gruppe === "Butter" && x.quelle === "prospekt"), schoko = np.find(x => x.gruppe === "Schokolade");
  assert.deepEqual([butter.markt, butter.preis, butter.liter, butter.art], ["PENNY", 2.49, 0.25, "kg"]);
  assert.deepEqual([schoko.preis, schoko.uvp, schoko.marke], [1.99, 1, ""]);
  assert.ok(!np.some(x => x.gruppe === "Eier"));
  // das PENNY-Angebot (Marktguru: Weihenstephan Butter 1,79 €) hat jetzt den früheren Preis
  const ang = JSON.parse(u.store.get("angebote")).find(x => x.markt === "PENNY" && x.produkt === "Butter");
  assert.equal(ang.preis_alt, 2.49);
  // auch unter „Nach Markt“ und beim nächsten täglichen Lauf
  const mk = await (await u.A("/markt?plz=47178&id=126765")).json();
  assert.equal(mk.angebote.find(x => x.produkt === "Butter").preis_alt, 2.49);
  const st = await (await u.A("/aktualisieren", "POST")).json();
  assert.ok(st.normal && st.normal.prospekte === 1, JSON.stringify(st.normal));
  assert.equal(JSON.parse(u.store.get("angebote")).find(x => x.markt === "PENNY" && x.produkt === "Butter").preis_alt, 2.49);
  // Liste der Prospekte, Entfernen
  const l = await (await u.A("/prospekte")).json();
  assert.deepEqual(l.map(x => [x.markt, x.statt, x.von]), [["PENNY", 2, h]]);
  const weg = await (await u.A("/prospekt?markt=PENNY", "DELETE")).json();
  assert.deepEqual(weg, []);
  assert.ok(!JSON.parse(u.store.get("normalpreise")).some(x => x.quelle === "prospekt"));
  // ungültige Daten
  const f = await u.A("/prospekt", "POST", JSON.stringify({ markt: "", angebote: [] }));
  assert.equal(f.status, 400);
});
