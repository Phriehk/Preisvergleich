// Automatische Tests für die Mengen- und Verpackungserkennung (App und Server).
// Aufruf: node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const grab = (src, from, to) => { const a = src.indexOf(from); assert.ok(a >= 0, "Nicht gefunden: " + from); const b = src.indexOf(to, a + from.length); assert.ok(b > a, "Ende nicht gefunden: " + to); return src.slice(a, b); };

// ---- App (index.html) ----
const re = html.match(/const RE1=.*?;\n?/s)[0].replace(/\n/g, "");
const appCode = re + grab(html, "function mengeAusText(t){", "// Verpackung") + grab(html, "function formVon", "\n}\n") + "\n}\n;({menge:mengeAusText,formVon})";
const app = vm.runInNewContext(appCode);

// ---- Server (worker/src/index.js) ----
const w = fs.readFileSync(new URL("../worker/src/index.js", import.meta.url), "utf8");
const srv = vm.runInNewContext(grab(w, "/* ---------- Mengen ---------- */", "/* ---------- Eine Teilabfrage") + ";({menge,mengenangabe})");

test("App: Mengen", () => {
  const f = (t) => { const m = app.menge(t); return m && [m.stueck, m.ml]; };
  assert.deepEqual(f("6x0.5 l zzgl. 1.50 Pfand"), [6, 500]);
  assert.deepEqual(f("12 x 1,0 l Kasten"), [12, 1000]);
  assert.deepEqual(f("je 1,5-l-PET-Fl."), [1, 1500]);
  assert.deepEqual(f("0,5l Dose"), [1, 500]);
  assert.deepEqual(f("330 ml"), [1, 330]);
  assert.deepEqual(f("2 Liter Flasche"), [1, 2000]);
  assert.deepEqual(f("1,5 ltr"), [1, 1500]);
  assert.deepEqual(f("24 x 33 cl"), [24, 330]);
  assert.deepEqual(f("1,25i Flasche"), [1, 1250]);
  assert.equal(app.menge("versch. Sorten"), null);
});

test("Server: Mengen", () => {
  assert.deepEqual([...srv.menge("6x0.5 l zzgl. 1.50 Pfand")], [6, 3]);
  assert.deepEqual([...srv.menge("je 1,5-l-PET-Fl.")], [1, 1.5]);
  assert.deepEqual([...srv.menge("24 x 33 cl")], [24, 7.92]);
  assert.deepEqual([...srv.menge("2 Liter")], [1, 2]);
  assert.equal(srv.menge("versch. Sorten"), null);
  // Strukturierte Angaben von Marktguru haben Vorrang
  assert.deepEqual([...srv.mengenangabe({ einheit: "l", volume: 0.5, quantity: 6 })], [6, 3, "l"]);
  assert.deepEqual([...srv.mengenangabe({ einheit: "l", volume: 1.5, quantity: 0 })], [1, 1.5, "l"]);
  assert.deepEqual([...srv.mengenangabe({ desc: "12 x 1,0 l", name: "Cola" })], [12, 12, "l"]);
});

test("Server: Lebensmittel (Gewicht und Stück)", () => {
  const m = (o) => { const r = srv.mengenangabe(o); return r && [...r]; };
  assert.deepEqual(m({ desc: "250-g-Packung (1 kg = 7,96)", name: "Butter" }), [1, 0.25, "kg"]);
  assert.deepEqual(m({ desc: "2 x 250 g", name: "Butter" }), [2, 0.5, "kg"]);
  assert.deepEqual(m({ desc: "1,5-kg-Beutel", name: "Äpfel" }), [1, 1.5, "kg"]);
  assert.deepEqual(m({ desc: "500 Gramm", name: "Nudeln" }), [1, 0.5, "kg"]);
  assert.deepEqual(m({ desc: "je 100 g 0,89 €", name: "Salami", einheit: "" }), null);   // Grundpreis ist keine Packung
  assert.deepEqual(m({ einheit: "g", volume: 250, quantity: 1, desc: "", name: "Butter" }), [1, 0.25, "kg"]);
  assert.deepEqual(m({ einheit: "kg", desc: "lose", name: "Äpfel" }), [1, 1, "kg"]);
  assert.deepEqual(m({ desc: "10 Stück, Größe M", name: "Eier" }), [10, 10, "st"]);
  assert.deepEqual(m({ desc: "6er Packung", name: "Eier" }), [6, 6, "st"]);
  assert.deepEqual(m({ einheit: "stk", quantity: 10, desc: "", name: "Eier" }), [10, 10, "st"]);
  assert.deepEqual(m({ desc: "1 l", name: "Milch" }), [1, 1, "l"]);   // Flüssigkeiten behalten Vorrang
  assert.equal(m({ desc: "versch. Sorten", name: "Joghurt" }), null);
});

test("Verpackung: Einweg, Dose, PET", () => {
  assert.equal(app.formVon("0,5l Dose zzgl. 0,25 Pfand", 500, "Fanta", 1), "Dose");
  assert.equal(app.formVon("6x0.5 l zzgl. 1.50 Pfand", 500, "Fanta", 6), "PET-Einweg");
  assert.equal(app.formVon("je 1,5-l-PET-Fl. zzgl. 0.25 Pfand", 1500, "Fanta", 1), "PET-Einweg");
  assert.equal(app.formVon("0,33 l Einweg", 330, "Cola", 1), "Dose");
  assert.equal(app.formVon("", 250, "Red Bull", 1), "Dose");
});

test("Verpackung: Mehrweg und Glas", () => {
  assert.equal(app.formVon("12 x 0,7 l Glas Mehrweg Kasten zzgl. 3.30 Pfand", 700, "Mineralwasser", 12), "Glas-Mehrweg");
  assert.equal(app.formVon("12 x 1,0 l PET Mehrweg Kasten zzgl. 3.30 Pfand", 1000, "Mineralwasser", 12), "PET-Mehrweg");
  assert.equal(app.formVon("0,33 l Glas Einweg zzgl. 0,25 Pfand", 330, "Bier", 1), "Glas-Einweg");
});

test("Verpackung: Karton", () => {
  assert.equal(app.formVon("Tetra Pak 1 l", 1000, "Saft", 1), "Karton");
  assert.equal(app.formVon("Orangensaft Karton pfandfrei", 1000, "Saft", 1), "Karton");
});

test("Server: passt das Angebot zum Artikel?", () => {
  const code = grab(w, "const KW =", "\n") + grab(w, "const AUSSCHLUSS", "\n") + grab(w, "/* ---------- Mengen ---------- */", "/* ---------- Eine Teilabfrage") + grab(w, "// Wörter, die bei Lebensmitteln", "async function parallel") + ";({istProdukt})";
  const { istProdukt } = vm.runInNewContext(code);
  const ja = (g, o) => assert.equal(istProdukt(g, { brand: "", desc: "", ...o }, []), true, g + ": " + JSON.stringify(o));
  const nein = (g, o) => assert.equal(istProdukt(g, { brand: "", desc: "", ...o }, []), false, g + ": " + JSON.stringify(o));
  ja("Butter", { name: "Butter", desc: "250-g-Packung" });
  ja("Butter", { name: "Original Irische Butter", desc: "250 g" });
  ja("Eier", { name: "Freilandeier", desc: "10 Stück" });
  ja("Mehl", { name: "Weizenmehl", desc: "1-kg-Packung" });
  ja("Milch", { name: "H-Milch", desc: "1-l-Packung" });
  nein("Butter", { name: "Butter-Mandel-Stollen", desc: "750-g-Packung" });
  nein("Butter", { name: "Buttergebäck", desc: "200 g" });
  nein("Butter", { name: "Peanut-Butter", desc: "454g" });
  nein("Milch", { name: "Milch-Mäuse", desc: "210-g-Packung" });
  nein("Milch", { name: "Milch Reis", desc: "200 g" });
  nein("Reis", { name: "Preiselbeeren", desc: "400 g, App-Preis 1,79 €" });
  nein("Reis", { name: "Kekse", desc: "Preis 1,29 € 200 g" });
  ja("Milchreis", { name: "Milchreis", desc: "1 kg" });
  // Getränke: das Wort darf in der Beschreibung stehen
  ja("Fanta", { name: "Cola", brand: "Coca-Cola", desc: "oder Fanta Versch. Sorten; 18 x 0,33 l" });
  ja("Coca-Cola", { name: "Cola", brand: "Coca-Cola", desc: "6 x 0,5 l" });
});
