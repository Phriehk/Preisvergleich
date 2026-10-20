// Zuordnung von Angeboten zu Favoriten im täglichen Lauf (echter Worker-Code, Marktguru nachgebaut)
import test from "node:test";
import assert from "node:assert/strict";
import { umgebung } from "./browser/lib.mjs";

const V = [{ from: "2026-10-19T00:00:00Z", to: "2099-10-25T21:59:00Z" }];
let nr = 500;
const O = (adv, name, brand, desc, price, unit, volume, quantity) => ({ id: ++nr, advertisers: [{ name: adv }], product: { name }, brand: { name: brand }, description: desc, price, unit: unit ? { shortName: unit } : undefined, volume, quantity, validityDates: V });
const daten = {
  milch: [O("Kaufland", "H-Vollmilch", "K-Classic", "3,5 % Fett je 1-l-Packg.", 0.79, "l", 1, 1), O("Kaufland", "Saure Sahne", "K-Classic", "200 g", 0.49, "g", 200, 1),
    O("Kaufland", "Hirtenkäse", "K-Classic", "aus Kuhmilch, je 250-g-Packg.", 1.19, "g", 250, 1), O("Lidl", "Milch", "Milbona", "1 l", 0.89, "l", 1, 1)],
  "monster energy": [O("PENNY", "Energy Drink", "Monster Energy", "je 0,5 l zzgl. 0.25 Pfand", 0.99, "l", 0.5, 1), O("ALDI SÜD", "Monster Jam Truck", "Spin Master", "Details im Prospekt", 4.99),
    O("PENNY", "Robby Monster Backe Früchte-Quark", "Ehrmann", "je 90 g", 0.55, "g", 90, 1)],
  monster: [],
};

test("Gewähltes Produkt (nur) muss trotzdem zum Suchwort passen: K-Classic H-Vollmilch ohne Käse und Sahne", async () => {
  const u = await umgebung({ daten });
  await u.KV.put("favoriten", JSON.stringify([{ name: "K-Classic H-Vollmilch", aus: "", nur: ["k-classic"], suche: "Milch" }]));
  await u.A("/aktualisieren", "POST");
  const a = JSON.parse(u.store.get("angebote"));
  assert.deepEqual([...new Set(a.map(x => x.produkt))], ["H-Vollmilch"]);
});

test("Monster Energy: nur der Energy Drink, kein Spielzeug und kein Quark", async () => {
  const u = await umgebung({ daten });
  await u.KV.put("favoriten", JSON.stringify([{ name: "Monster Energy", aus: "" }]));
  await u.A("/aktualisieren", "POST");
  const a = JSON.parse(u.store.get("angebote"));
  assert.deepEqual([...new Set(a.map(x => x.produkt))], ["Energy Drink"]);
});
