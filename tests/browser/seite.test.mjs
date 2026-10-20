// Ende-zu-Ende: die echte Seite im Browser gegen den echten Worker-Code (Marktguru nachgebaut).
// Braucht Playwright mit Chromium (in der Pipeline installiert); ohne wird übersprungen.
import test from "node:test";
import assert from "node:assert/strict";
import { umgebung, browserStarten, playwright } from "./lib.mjs";

const ok = !!playwright();
const t = (name, fn) => test(name, { skip: !ok && "Playwright nicht installiert", timeout: 120000 }, fn);

async function mitSeite(opts, fn) {
  const u = await umgebung(opts);
  await u.KV.put("favoriten", JSON.stringify([{ name: "Eier", aus: "" }, { name: "Reis", aus: "" }, { name: "Äpfel", aus: "" }]));
  await u.A("/aktualisieren", "POST");
  const s = await browserStarten(u, opts);
  try { await s.oeffnen(); await fn(s, u); }
  finally { await s.b.close(); }
}
const klick = async (p, sel) => { await p.evaluate(s => document.querySelector(s).click(), sel); await p.waitForTimeout(1200); };

t("Alle Tabs laden ohne Fehler", async () => {
  await mitSeite({}, async ({ p, fehler }) => {
    for (const id of ["#tabFav", "#tabEinkauf", "#tabEinkaufen", "#tabImport", "#tabJetzt"]) { await p.click(id); await p.waitForTimeout(300); }
    await p.click("#tabMehr"); await p.click("#tabSpaeter"); await p.click("#tabMehr"); await p.click("#tabUebersicht");
    assert.deepEqual(fehler, []);
  });
});

t("Konto anlegen funktioniert (Dialog, Passwortprüfung)", async () => {
  await mitSeite({ code: "" }, async ({ p, fehler }) => {
    await p.click("#kontoBtn"); await p.click("#kModen [data-m=neu]");
    await p.fill("#kName", "Anna"); await p.fill("#kPw", "geheim123"); await p.fill("#kPw2", "falsch123"); await p.click("#kGo");
    assert.match(await p.textContent("#kInfo"), /überein|gleich/i);
    await p.fill("#kPw2", "geheim123"); await p.click("#kGo"); await p.waitForTimeout(1500);
    assert.equal((await p.textContent("#kWer")).trim().toLowerCase(), "anna");
    assert.deepEqual(fehler, []);
  });
});

t("Import: Liste einfügen, suchen, auf die Liste, Favorit, ohne Angebot; Tab und Scrollposition bleiben", async () => {
  await mitSeite({}, async ({ p, fehler }, u) => {
    await p.click("#tabImport");
    await p.fill("#impText", "Milch\n2 kg Äpfel\nButter\nSalz");
    await p.click("#impBtn"); await p.waitForTimeout(2500);
    const it = await p.evaluate(() => imp.items.map(i => [i.name, i.status, i.roh.length]));
    assert.deepEqual(it.map(x => x[0]), ["Milch", "Äpfel", "Butter", "Salz"]);
    assert.ok(it[0][2] > 0 && it[3][2] === 0, JSON.stringify(it));
    // keine doppelte Kachel „Äpfel“ neben „Alle Marken“
    const apfel = await p.evaluate(() => [...document.querySelectorAll("#impseite .fv-grp")][1].querySelectorAll(".kachel b").length && [...document.querySelectorAll("#impseite .fv-grp")][1].innerText.replace(/\s+/g, " "));
    assert.ok(/Alle Marken/.test(apfel) && /Ohne Angebot/.test(apfel) && !/Äpfel\s+\d+ Angebot/.test(apfel), apfel);
    await klick(p, '[data-ia="0"]');                                   // Milch: günstigstes aller Marken
    const bi = await p.evaluate(() => imp.items.findIndex(i => i.name === "Butter"));
    await p.evaluate(i => document.querySelector(`[data-il="${i}|1"]`).scrollIntoView({ block: "center" }), bi);
    const y0 = await p.evaluate(() => Math.round(scrollY));
    await p.click(`[data-il="${bi}|1"]`);
    const spur = [];
    for (let i = 0; i < 8; i++) { await p.waitForTimeout(150); spur.push(await p.evaluate(() => tab + "@" + Math.round(scrollY))); }
    assert.ok(spur.every(x => x === "import@" + y0), `Tab oder Scroll gesprungen: ${spur.join(" ")} (vorher ${y0})`);
    const si = await p.evaluate(() => imp.items.findIndex(i => i.name === "Salz"));
    await klick(p, `[data-io="${si}"]`);
    const z = await p.evaluate(() => ({ zettel, frei }));
    assert.ok(z.zettel.Milch > 0 && z.zettel["Salz"] > 0 && Object.keys(z.zettel).length === 3, JSON.stringify(z));
    assert.equal(z.frei.Salz, "st");
    assert.deepEqual(fehler, []);
  });
});

t("Einkaufen: nach Markt, abhaken bleibt gespeichert; Export nur mit Namen", async () => {
  await mitSeite({}, async ({ p, fehler }) => {
    await p.click("#tabImport");
    await p.fill("#impText", "Milch\nÄpfel\nSalz");
    await p.click("#impBtn"); await p.waitForTimeout(2500);
    await klick(p, '[data-ia="0"]'); await klick(p, '[data-ia="1"]');
    const si = await p.evaluate(() => imp.items.findIndex(i => i.name === "Salz"));
    await klick(p, `[data-io="${si}"]`);
    await p.click("#tabEinkaufen"); await p.waitForTimeout(400);
    const gr = await p.$$eval("#hakenseite .hk-g", e => e.map(x => x.innerText.replace(/\s+/g, " ")));
    assert.ok(gr.length === 3 && gr.some(x => /Äpfel/.test(x)) && gr.some(x => /Milch/.test(x)) && /Egal wo.*Salz/.test(gr[2]), JSON.stringify(gr));
    await p.click("#hakenseite .hk >> nth=0"); await p.waitForTimeout(300);
    assert.match(await p.textContent("#hakenseite .ek-s"), /1 von 3/);
    await p.reload(); await p.waitForTimeout(1500); await p.click("#tabEinkaufen");
    assert.match(await p.textContent("#hakenseite .ek-s"), /1 von 3/, "Haken bleibt nach Neuladen");
    await p.click("#tabEinkauf"); await p.waitForTimeout(400);
    const text = await p.$eval("#expText", e => e.value);
    assert.match(text, /^Äpfel \(\w+\)$/m); assert.match(text, /^Salz$/m);
    assert.doesNotMatch(text, /×|\d\s?(kg|l|g)\b/, "keine Mengen im Export");
    assert.deepEqual(fehler, []);
  });
});

t("Import per Link (#import=) startet die Suche", async () => {
  const u = await umgebung({});
  await u.KV.put("favoriten", "[]");
  const s = await browserStarten(u);
  try {
    await s.oeffnen("#import=" + encodeURIComponent("Reis\nMilch"));
    await s.p.waitForTimeout(2500);
    assert.equal(await s.p.evaluate(() => tab), "import");
    assert.deepEqual(await s.p.evaluate(() => imp.items.map(i => [i.name, i.status])), [["Reis", "fertig"], ["Milch", "fertig"]]);
    assert.equal(await s.p.evaluate(() => location.hash), "");
  } finally { await s.b.close(); }
});

t("Preisalarm: Lebensmittel-Alarm und Meldung für die Liste", async () => {
  await mitSeite({}, async ({ p, fehler }, u) => {
    // Alarm für Gewichts-Artikel auf der Aktuell-Seite
    await p.click("#tabJetzt"); await p.selectOption("#fProdukt", "Äpfel"); await p.waitForTimeout(400);
    assert.equal(await p.$eval("#alarmRow", e => !e.hidden), true, "Alarmzeile bei Äpfeln sichtbar");
    assert.deepEqual(await p.$$eval("#alarmEinheit option", e => e.map(x => x.value)), ["kg"]);
    await p.fill("#alarmWert", "1,50"); await p.click("#alarmSave"); await p.waitForTimeout(1200);
    const fav = JSON.parse(u.store.get("favoriten")).find(f => f.name === "Äpfel");
    assert.deepEqual(fav.alarm, { wert: 1.5, einheit: "kg", ml: null });
    // Meldung für die Liste
    await p.click("#tabImport"); await p.fill("#impText", "Milch"); await p.click("#impBtn"); await p.waitForTimeout(2000);
    await klick(p, '[data-ia="0"]');
    await p.click("#tabEinkauf"); await p.waitForTimeout(400);
    await p.click("#listeAlarm"); await p.waitForTimeout(1200);
    const milch = JSON.parse(u.store.get("favoriten")).find(f => f.name === "Milch");
    assert.equal(milch.alarm.liste, true); assert.equal(milch.alarm.einheit, "l");
    await p.click("#listeAlarm"); await p.waitForTimeout(1200);
    assert.equal(JSON.parse(u.store.get("favoriten")).find(f => f.name === "Milch").alarm, undefined);
    assert.deepEqual(fehler, []);
  });
});
