// PENNY von penny.de: frühere Preise bzw. UVP und App-Preise zu den Marktguru-Angeboten von PENNY
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { umgebung, wurzel } from "./browser/lib.mjs";

const q = fs.readFileSync(path.join(wurzel, "worker/src/index.js"), "utf8").replace(/^import \{ WorkerEntrypoint \} from "cloudflare:workers";/m, "class WorkerEntrypoint{}") + "\nexport { pennyKachel, pennyErgaenzen, isoWoche };";
const datei = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pv-penny-")), "w.mjs"); fs.writeFileSync(datei, q);
const W = await import(pathToFileURL(datei).href);
const kachel = (title, price, mehr = {}) => ({ title, price, quantity: "je 250 g", primaryType: "offer", uuid: title, ...mehr });

test("Kachel: UVP, Streichpreis, angezeigter Originalpreis, App-Preis, Hinweise ohne Preis", () => {
  assert.deepEqual(W.pennyKachel(kachel("JACOBS Auslese Kaffee*", "5.77", { quantity: "je 500 g", listPrice: "8.99", benefitPrice: "5.49²", primaryType: "promoPlus", linkHref: "/angebote/top-angebote/jacobs~mgnlArea=main~" }), "top-angebote"),
    { t: "JACOBS Auslese Kaffee", q: "je 500 g", p: 5.77, alt: 8.99, uvp: 1, app: 5.49, k: "top-angebote", l: "https://www.penny.de/angebote/top-angebote/jacobs" });
  assert.deepEqual(W.pennyKachel(kachel("MILPRIMA Saure Sahne*", "0.39²", { crossOutPrice: "0.59", listPrice: "0.00" }), "milprima"), { t: "MILPRIMA Saure Sahne", q: "je 250 g", p: 0.39, alt: 0.59, k: "milprima" });
  assert.equal(W.pennyKachel(kachel("Butter*", "1.79", { showOriginalPrice: true, originalPrice: "2.19", originalPriceType: "uvp" }), "k").uvp, 1);
  assert.equal(W.pennyKachel(kachel("Butter*", "1.79", { showOriginalPrice: false, originalPrice: "2.19" }), "k").alt, undefined, "nur angezeigte Originalpreise zählen");
  assert.equal(W.pennyKachel(kachel("Zitronen*", "1.29", { actionPrice: true }), "k").alt, undefined);
  assert.equal(W.pennyKachel({ title: "Maggi-Sortiment 25% Rabatt", primaryType: "contentTeaser" }, "k"), null);
  assert.equal(W.pennyKachel(kachel("Ohne Preis*", null), "k"), null);
  assert.equal(W.isoWoche("2026-10-26"), "2026-44"); assert.equal(W.isoWoche("2026-11-01"), "2026-44"); assert.equal(W.isoWoche("2027-01-01"), "2026-53"); assert.equal(W.isoWoche(""), "");
});

test("Ergänzen: nur PENNY, gleicher Preis (auch App-Preis) und passender Name; bei Gleichstand mit verschiedenen Preisen nichts", () => {
  const penny = { t: Date.now(), wochen: {
    "2026-44": [{ t: "JACOBS Auslese Kaffee", q: "je 500 g", p: 5.77, alt: 8.99, uvp: 1, app: 5.49 }, { t: "MILPRIMA Fettarmer Joghurt", q: "je 250 g", p: 0.45, alt: 0.59 },
      { t: "MILPRIMA Joghurt mild", q: "je 500 g", p: 0.45, alt: 0.79 }, { t: "WEIHENSTEPHAN Butter", q: "je 250 g", p: 1.79, alt: 2.29 }, { t: "WEIHENSTEPHAN Butter", q: "je 250 g", p: 1.79, alt: 2.49 }],
    "2026-45": [{ t: "JACOBS Auslese Kaffee", q: "je 500 g", p: 5.99, alt: 8.99, uvp: 1 }] } };
  const l = [
    { markt: "PENNY", marke: "Jacobs", produkt: "Auslese Kaffee", beschreibung: "je 500 g", preis: 5.77, gueltig_von: "2026-10-26" },
    { markt: "PENNY (46535)", marke: "Jacobs", produkt: "Auslese Kaffee", beschreibung: "je 500 g", preis: 5.49, gueltig_von: "2026-10-26" },   // Marktguru zeigt den App-Preis
    { markt: "PENNY", marke: "Jacobs", produkt: "Auslese Kaffee", beschreibung: "je 500 g", preis: 5.99, gueltig_von: "2026-11-02" },
    { markt: "PENNY", marke: "Jacobs", produkt: "Auslese Kaffee", beschreibung: "je 500 g", preis: 5.99, gueltig_von: "2026-10-26" },   // Preis der anderen Woche
    { markt: "Lidl", marke: "Jacobs", produkt: "Auslese Kaffee", beschreibung: "je 500 g", preis: 5.77, gueltig_von: "2026-10-26" },
    { markt: "PENNY", marke: "Milprima", produkt: "Fettarmer Joghurt", beschreibung: "je 250 g", preis: 0.45, gueltig_von: "2026-10-26" },
    { markt: "PENNY", marke: "Milprima", produkt: "Joghurt", beschreibung: "je 500 g", preis: 0.45, gueltig_von: "2026-10-26" },   // Menge entscheidet
    { markt: "PENNY", marke: "Weihenstephan", produkt: "Butter", beschreibung: "250 g", preis: 1.79, gueltig_von: "2026-10-26" },   // zwei gleich gute mit verschiedenen Preisen
    { markt: "PENNY", marke: "Kerrygold", produkt: "Butter", beschreibung: "250 g", preis: 1.79, preis_alt: 1.99, gueltig_von: "2026-10-26" },
    { markt: "PENNY", marke: "Lindt", produkt: "Excellence", beschreibung: "100 g", preis: 1.79, gueltig_von: "2026-10-26" },
  ];
  assert.equal(W.pennyErgaenzen(l, penny), 5);
  assert.deepEqual([l[0].preis_alt, l[0].alt_uvp, l[0].preis_app], [8.99, 1, 5.49]);
  assert.deepEqual([l[1].preis_alt, l[1].alt_uvp, l[1].preis_app], [8.99, 1, undefined], "App-Preis schon der Preis");
  assert.equal(l[2].preis_alt, 8.99, "nächste Woche");
  assert.equal(l[3].preis_alt, undefined, "in dieser Woche kostet er 5,77");
  assert.equal(l[4].preis_alt, undefined, "anderer Markt");
  assert.deepEqual([l[5].preis_alt, l[6].preis_alt], [0.59, 0.79]);
  assert.equal(l[7].preis_alt, undefined, "unklar");
  assert.equal(l[8].preis_alt, 1.99, "Marktguru-Preis bleibt"); assert.equal(l[9].preis_alt, undefined);
  assert.equal(W.pennyErgaenzen([{ marke: "Milprima", produkt: "Fettarmer Joghurt", beschreibung: "je 250 g", preis: 0.45 }], penny, true), 1, "Ansicht eines Marktes: alle sind PENNY, ohne Datum alle Wochen");
  assert.equal(W.pennyErgaenzen(l, null), 0);
});

test("Holen: Woche, Kategorien und Region von penny.de, gespeichert; Fehler lassen die Marktguru-Angebote unberührt", async () => {
  const u = await umgebung({ penny: { kuehlregal: [kachel("WEIHENSTEPHAN Butter*", "1.79", { listPrice: "2.49", benefitPrice: "1.59²", primaryType: "promoPlus" })], "obst-und-gemuese": [kachel("Äpfel*", "1.99", { quantity: "je kg" })] } });
  await u.KV.put("favoriten", JSON.stringify([{ name: "Butter", aus: "" }, { name: "Äpfel", aus: "" }]));
  const r = await (await u.A("/aktualisieren", "POST")).json();
  assert.equal(r.penny.angebote, 2); assert.ok(r.penny.ergaenzt >= 1, JSON.stringify(r.penny));
  assert.ok(u.pennyAbrufe.some(x => x.includes("/2026-44/kuehlregal?region=15A-09-33")) && u.pennyAbrufe.some(x => x.includes("/2026-45/")));
  const a = JSON.parse(u.store.get("angebote")), b = a.find(x => x.markt === "PENNY" && x.produkt === "Butter");
  assert.deepEqual([b.preis_alt, b.alt_uvp, b.preis_app], [2.49, 1, 1.59]);
  assert.ok(a.filter(x => x.markt !== "PENNY" && !/^PENNY/.test(x.markt)).every(x => !x.alt_uvp && !x.preis_app));
  // zweiter Lauf am selben Tag: kein neuer Abruf bei penny.de
  const n = u.pennyAbrufe.length; await u.A("/aktualisieren", "POST"); assert.equal(u.pennyAbrufe.length, n);
  // penny.de nicht erreichbar: Angebote kommen trotzdem
  const v = await umgebung({});
  await v.KV.put("favoriten", JSON.stringify([{ name: "Butter", aus: "" }]));
  const r2 = await (await v.A("/aktualisieren", "POST")).json();
  assert.ok(r2.anzahl > 0 && r2.penny.fehler, JSON.stringify(r2));
});
