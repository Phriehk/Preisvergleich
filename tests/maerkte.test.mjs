// Märkte unter „Nach Markt“: nur Lebensmittel und Drogerie, dm aus der Nachbar-Postleitzahl, Märkte bleiben, wenn Marktguru sie kurz nicht nennt
import test from "node:test";
import assert from "node:assert/strict";
import { umgebung, DATEN, O } from "./browser/lib.mjs";

test("Märkte: ohne Baumärkte, mit dm aus 47137, Kaufland bleibt, wenn Marktguru es kurz nicht nennt", async () => {
  const opts = { daten: { ...DATEN, schrauben: [O("OBI", "Schrauben", "Fischer", "100 Stück", 4.99)], zahnpasta: [O("dm-drogerie markt", "Zahnpasta", "Balea", "75 ml", 0.65)] }, nurPlz: { "dm-drogerie markt": "47137" } };
  const u = await umgebung(opts);
  const namen = l => l.map(m => m.name + (m.plz !== "47178" ? ` (${m.plz})` : "") + "=" + m.n);
  let l = await (await u.A("/maerkte?plz=47178")).json();
  assert.ok(!namen(l).some(x => /OBI/.test(x)), "kein Baumarkt: " + namen(l));
  assert.ok(namen(l).includes("dm-drogerie markt (47137)=1"), namen(l).join(", "));
  assert.ok(namen(l).includes("Kaufland=2"), namen(l).join(", "));
  // Sonntag: Marktguru nennt Kaufland nicht, die Angebote gibt es aber
  opts.verlagOhne = new Set(["Kaufland"]);
  u.store.delete("mkl4:47178");
  l = await (await u.A("/maerkte?plz=47178")).json();
  assert.ok(namen(l).includes("Kaufland=2"), "Kaufland bleibt: " + namen(l).join(", "));
  const r = await (await u.A("/markt?plz=47178&id=126654")).json();
  assert.equal(r.angebote.length, 2);
  // Favoriten finden dm-Angebote aus 47137
  await u.KV.put("favoriten", JSON.stringify([{ name: "Zahnpasta", aus: "" }]));
  await u.A("/aktualisieren", "POST");
  const a = JSON.parse(u.store.get("angebote"));
  assert.deepEqual(a.map(x => x.markt), ["dm-drogerie markt (47137)"]);
});

test("REWE kommt aus Meiderich (47137): Verlauf und Korrekturen mit dem alten Namen werden einmal umbenannt", async () => {
  const u = await umgebung({ nurPlz: { REWE: "47137" } });
  await u.KV.put("favoriten", JSON.stringify([{ name: "Butter", aus: "" }]));
  await u.KV.put("verlauf:monate", JSON.stringify(["2026-10"]));
  await u.KV.put("verlauf:2026-10", "2026-10-20;REWE (47053);Butter;0.5;3.49;6.98;2026-10-25;2026-10-19;Butter\n2026-10-20;Lidl;Butter;0.25;1.99;7.96;;;Butter");
  await u.KV.put("korrekturen", JSON.stringify({ "Butter|REWE (47053)|Butter|||3.49|2|250": { ok: true, t: Date.now() } }));
  await u.A("/aktualisieren", "POST");
  const v = u.store.get("verlauf:2026-10").split("\n");
  assert.equal(v[0], "2026-10-20;REWE (47137);Butter;0.5;3.49;6.98;2026-10-25;2026-10-19;Butter");
  assert.ok(v.some(z => z.startsWith("2026-10-20;Lidl;")));
  assert.deepEqual(Object.keys(JSON.parse(u.store.get("korrekturen"))), ["Butter|REWE (47137)|Butter|||3.49|2|250"]);
  assert.ok(JSON.parse(u.store.get("angebote")).some(x => x.markt === "REWE (47137)"), "REWE-Angebote aus 47137");
  assert.ok(!JSON.parse(u.store.get("angebote")).some(x => /47053/.test(x.markt)));
  // nur einmal: ein späterer alter Eintrag (z. B. aus einer Sicherung) bleibt, wie er ist
  await u.KV.put("verlauf:2026-10", "2026-10-21;REWE (47053);Butter");
  await u.A("/aktualisieren", "POST");
  assert.match(u.store.get("verlauf:2026-10"), /^2026-10-21;REWE \(47053\);Butter/);
});
