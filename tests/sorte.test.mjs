// Sorten über alle Marken: Seite und Worker rechnen denselben Schlüssel (sonst fände der tägliche Lauf andere Angebote als die Suche)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { wurzel } from "./browser/lib.mjs";

const html = fs.readFileSync(path.join(wurzel, "index.html"), "utf8");
const stueck = (von, bis) => { const a = html.indexOf(von), b = html.indexOf(bis, a); assert.ok(a > 0 && b > a, von); return html.slice(a, b); };
const seite = new Function(stueck("const flachT=", "\n") + "\n" + stueck("const nurK=", "\n") + "\n" + stueck("const SORTE_WEG=", "// \"nur\" eines Favoriten") + "\nreturn sorteK;")();
const q = fs.readFileSync(path.join(wurzel, "worker/src/index.js"), "utf8").replace(/^import \{ WorkerEntrypoint \} from "cloudflare:workers";/m, "class WorkerEntrypoint{}") + "\nexport { sorteK };";
const datei = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pv-sorte-")), "w.mjs"); fs.writeFileSync(datei, q);
const { sorteK: worker } = await import(pathToFileURL(datei).href);

const FAELLE = [
  ["Rinder-Hackfleisch", "Meine Metzgerei", "rinderhackfleisch"], ["Rinderhackfleisch XXL", "Meine Metzgerei", "rinderhackfleisch"], ["XXL Rinderhackfleisch", "Metzgerfrisch", "rinderhackfleisch"],
  ["Rinder-Hackfleisch", "Metzgerei Wilhelm Brandenburg", "rinderhackfleisch"], ["Gemischt-Hackfleisch", "Gut Ponholz", "gemischthackfleisch"], ["Hackfleisch", "Mühlenhof", "hackfleisch"],
  ["Schweinehackfleisch", "K-Purland", "schweinehackfleisch"], ["Deodorant-Spray", "Hidrofugal", "deospray"], ["Deospray", "Hidrofugal", "deospray"], ["Deo Roll-on", "Hidrofugal", "deorollon"],
  ["Coca-Cola Zero", "Coca-Cola", "cocacolazero"], ["Pepsi Zero", "Pepsi", "pepsizero"], ["Frische Vollmilch 3,5 %", "Milbona", "vollmilch"], ["Butter", "", "butter"],
];
test("Sorte: gleiche Ware über Marken hinweg, Marke bleibt, wenn sonst nichts übrig wäre", () => {
  for (const [n, m, k] of FAELLE) assert.equal(seite(n, m), k, n + " / " + m);
});
test("Sorte: Seite und Worker rechnen gleich", () => {
  for (const [n, m] of FAELLE) assert.equal(worker(n, m), seite(n, m), n);
});
