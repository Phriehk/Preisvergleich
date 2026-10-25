// Preisalarm: Lebensmittel (kg, Stück) und Meldung für die Liste, gegen den echten Worker-Code mit nachgebautem Marktguru
import test from "node:test";
import assert from "node:assert/strict";
import { umgebung } from "./browser/lib.mjs";

test("Alarm für Gewicht (€/kg) und Stück meldet nur passende Angebote", async () => {
  const u = await umgebung({ geraet: true });
  await u.KV.put("favoriten", JSON.stringify([
    { name: "Äpfel", aus: "", alarm: { wert: 2, einheit: "kg", ml: null } },
    { name: "Eier", aus: "", alarm: { wert: 0.3, einheit: "st", ml: null } },
    { name: "Reis", aus: "", alarm: { wert: 0.5, einheit: "kg", ml: null } },   // zu niedrig: Reis kostet ab 1,78 €/kg
  ]));
  const r = await (await u.A("/aktualisieren", "POST")).json();
  assert.equal(r.fehler, 0);
  const titel = (await u.mitteilungen()).map(n => n.titel).sort();
  assert.equal(titel.length, 2, JSON.stringify(titel));
  assert.ok(titel.some(t => /Äpfel.*€\/kg/.test(t)), JSON.stringify(titel));
  assert.ok(titel.some(t => /Eier.*€\/Stück/.test(t)), JSON.stringify(titel));
});

test("Alarm 'Liste' (hoher Wert) meldet jedes Angebot, ein zweiter Lauf meldet nichts doppelt", async () => {
  const u = await umgebung({ geraet: true });
  await u.KV.put("favoriten", JSON.stringify([{ name: "Milch", aus: "", alarm: { wert: 9999, einheit: "l", ml: null, liste: true } }]));
  await u.A("/aktualisieren", "POST");
  assert.equal((await u.mitteilungen()).length, 1);
  await u.A("/aktualisieren", "POST");
  assert.equal((await u.mitteilungen()).length, 1, "dasselbe Angebot nicht noch einmal melden");
});

test("Alter Getränke-Alarm (€ je Flasche) funktioniert weiter", async () => {
  const u = await umgebung({ geraet: true });
  await u.KV.put("favoriten", JSON.stringify([{ name: "Milch", aus: "", alarm: { wert: 1, einheit: "stueck", ml: null } }]));
  await u.A("/aktualisieren", "POST");
  const m = await u.mitteilungen();
  assert.equal(m.length, 1);
  assert.match(m[0].titel, /€\/Stück/);
  assert.equal(u.ntfy.length, 0, "kein ntfy mehr");
});
