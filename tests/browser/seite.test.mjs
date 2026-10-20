// Ende-zu-Ende: die echte Seite im Browser gegen den echten Worker-Code (Marktguru nachgebaut).
// Braucht Playwright mit Chromium (in der Pipeline installiert); ohne wird übersprungen.
import test from "node:test";
import assert from "node:assert/strict";
import { umgebung, browserStarten, playwright } from "./lib.mjs";

const ok = !!playwright();
const t = (name, fn) => test(name, { skip: !ok && "Playwright nicht installiert", timeout: 120000 }, fn);

async function mitSeite(opts, fn) {
  const u = await umgebung(opts);
  await u.KV.put("favoriten", JSON.stringify(opts.favs || [{ name: "Eier", aus: "" }, { name: "Reis", aus: "" }, { name: "Äpfel", aus: "" }]));
  await u.A("/aktualisieren", "POST");
  const s = await browserStarten(u, opts);
  try { await s.oeffnen(opts.hash || ""); await fn(s, u); }
  finally { await s.b.close(); }
}
const klick = async (p, sel) => { await p.evaluate(s => document.querySelector(s).click(), sel); await p.waitForTimeout(900); };
const bereich = async (p, v) => { await p.click(`#leiste [data-v="${v}"]`); await p.waitForTimeout(300); };
const suche = async (p, text) => { await bereich(p, "suchen"); await p.fill("#sucheText", text); await p.click('[data-aktion="suchen"]'); await p.waitForFunction(() => !S.suche.laeuft, null, { timeout: 15000 }); await p.waitForTimeout(200); };

t("Alle Bereiche laden ohne Fehler, auch die Produktseite und die alte Version", async () => {
  await mitSeite({}, async ({ p, fehler }) => {
    assert.deepEqual(await p.$$eval(".produkt h3", e => e.map(x => x.textContent)), ["Äpfel", "Eier", "Reis"]);
    for (const v of ["suchen", "liste", "einkaufen", "mehr", "angebote"]) await bereich(p, v);
    await p.click('.produkt[data-p="Eier"]'); await p.waitForTimeout(300);
    assert.equal(await p.textContent("#titel"), "Eier");
    assert.ok(await p.$$eval("tbody tr", e => e.length) >= 2);
    await p.click('[data-seg="sort2"][data-wert="preis"]');
    await p.goBack(); await p.waitForTimeout(300);
    assert.equal(await p.textContent("#titel"), "Angebote");
    await p.goto("https://preise.phriehk.workers.dev/alt.html"); await p.waitForTimeout(1500);
    assert.match(await p.textContent("body"), /alte Version/);
    assert.deepEqual(fehler, []);
  });
});

t("Konto anlegen: Passwortprüfung, Anmeldung, Abgleich ohne Datenverlust für die alte Version", async () => {
  await mitSeite({ code: "" }, async ({ p, fehler }, u) => {
    await bereich(p, "mehr");
    await p.click('[data-seg="kMode"][data-wert="neu"]');
    await p.fill("#kName", "Anna"); await p.fill("#kPw", "geheim123"); await p.fill("#kPw2", "falsch123"); await p.click("#kGo");
    assert.match(await p.textContent("#kInfo"), /nicht gleich/);
    await p.fill("#kPw2", "geheim123"); await p.click("#kGo");
    await p.waitForSelector("#kWer", { timeout: 15000 });
    assert.equal((await p.textContent("#kWer")).trim(), "anna");
    // eine eigene Notiz landet im Konto ...
    await bereich(p, "einkaufen");
    await p.fill("#extraName", "Zahnpasta"); await p.press("#extraName", "Enter"); await p.waitForTimeout(2200);
    let d = JSON.parse(u.store.get("u:anna")).daten;
    assert.deepEqual(d.extra, ["Zahnpasta"]);
    // ... und bleibt, wenn die alte Seite nur ihre Felder schickt
    const tok = await p.evaluate(() => konto.token);
    await u.H.fetch(new Request("https://preise.phriehk.workers.dev/konto/daten", { method: "PUT", headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" }, body: JSON.stringify({ daten: { ort: null, km: 0.3, zettel: { Eier: 6 }, richt: {}, frei: {} } }) }), u.env, u.ctx);
    d = JSON.parse(u.store.get("u:anna")).daten;
    assert.deepEqual(d.extra, ["Zahnpasta"]); assert.deepEqual(d.zettel, { Eier: 6 });
    assert.deepEqual(fehler, []);
  });
});

t("Suchen: Liste einfügen, auf die Liste, Favorit, ohne Angebot; Ansicht und Scrollposition bleiben", async () => {
  await mitSeite({}, async ({ p, fehler }, u) => {
    await suche(p, "Milch\n2 kg Äpfel\nButter\nSalz");
    const it = await p.evaluate(() => S.suche.items.map(i => [i.name, i.status, i.roh.length]));
    assert.deepEqual(it.map(x => x[0]), ["Milch", "Äpfel", "Butter", "Salz"]);
    assert.ok(it[0][2] > 0 && it[3][2] === 0, JSON.stringify(it));
    const apfel = await p.evaluate(() => [...document.querySelectorAll("#ansicht .gruppe")][1].innerText.replace(/\s+/g, " "));
    assert.ok(/Alle Marken/.test(apfel) && /Ohne Angebot/.test(apfel), apfel);
    await klick(p, '[data-ia="0"]');                                    // Milch: günstigstes aller Marken
    const bi = await p.evaluate(() => S.suche.items.findIndex(i => i.name === "Butter"));
    await p.evaluate(i => document.querySelector(`[data-il="${i}|1"]`).scrollIntoView({ block: "center", behavior: "instant" }), bi);
    await p.waitForTimeout(500);
    const y0 = await p.evaluate(() => Math.round(scrollY));
    await p.evaluate(i => document.querySelector(`[data-il="${i}|1"]`).click(), bi);
    const spur = [];
    for (let i = 0; i < 8; i++) { await p.waitForTimeout(150); spur.push(await p.evaluate(() => S.v + "@" + Math.round(scrollY))); }
    assert.ok(spur.every(x => { const [v, y] = x.split("@"); return v === "suchen" && Math.abs(+y - y0) < 150; }), `gesprungen: ${spur.join(" ")} (vorher ${y0})`);
    await klick(p, `[data-io="${await p.evaluate(() => S.suche.items.findIndex(i => i.name === "Salz"))}"]`);
    const z = await p.evaluate(() => ({ zettel, frei }));
    assert.ok(z.zettel.Milch > 0 && z.zettel.Salz > 0 && Object.keys(z.zettel).length === 3, JSON.stringify(z));
    assert.equal(z.frei.Salz, "st");
    const server = JSON.parse(u.store.get("favoriten")).map(f => f.name);
    assert.ok(server.includes("Milch") && !server.includes("Salz"), JSON.stringify(server));
    assert.deepEqual(fehler, []);
  });
});

t("Einkaufen: nach Markt, abhaken bleibt nach Neuladen, eigene Artikel, Abgehakte entfernen; Export nur mit Namen", async () => {
  await mitSeite({}, async ({ p, fehler }, u) => {
    await suche(p, "Milch\nÄpfel\nSalz");
    await klick(p, '[data-ia="0"]'); await klick(p, '[data-ia="1"]');
    await klick(p, `[data-io="${await p.evaluate(() => S.suche.items.findIndex(i => i.name === "Salz"))}"]`);
    await bereich(p, "einkaufen");
    await p.fill("#extraName", "Batterien"); await p.click('[data-aktion="extraHinzu"]'); await p.waitForTimeout(200);
    const gr = await p.$$eval(".haken-gruppe", e => e.map(x => x.innerText.replace(/\s+/g, " ")));
    assert.ok(gr.length === 4 && gr.some(x => /Äpfel/.test(x)) && gr.some(x => /Milch/.test(x)) && /Egal wo.*Salz/.test(gr[2]) && /Sonstiges.*Batterien/.test(gr[3]), JSON.stringify(gr));
    await p.click(".haken label >> nth=0"); await p.waitForTimeout(300);
    assert.match(await p.textContent(".box-kopf h2"), /1 von 4/);
    await u.A("/aktualisieren", "POST");   // der Server kennt die neuen Favoriten
    await p.reload(); await p.waitForFunction(() => offers.some(o => o.gruppe === "Milch"), null, { timeout: 15000 });
    await bereich(p, "einkaufen");
    assert.match(await p.textContent(".box-kopf h2"), /1 von 4/, "Haken bleibt nach Neuladen");
    await bereich(p, "liste");
    await p.click("details[data-merk] summary"); await p.waitForTimeout(200);
    const text = await p.$eval("#expText", e => e.value);
    assert.match(text, /^Äpfel \(\w+\)$/m); assert.match(text, /^Salz$/m); assert.match(text, /^Batterien$/m);
    assert.doesNotMatch(text, /×|\d\s?(kg|l|g)\b/, "keine Mengen im Export");
    await bereich(p, "einkaufen");
    await p.click('[data-aktion="abgehakteWeg"]'); await p.waitForTimeout(300);
    assert.match(await p.textContent(".box-kopf h2"), /0 von 3/);
    assert.deepEqual(fehler, []);
  });
});

t("Import per Link (#import=) öffnet die Suche und startet sie", async () => {
  await mitSeite({ hash: "#import=" + encodeURIComponent("Reis\nMilch") }, async ({ p, fehler }) => {
    await p.waitForFunction(() => S.suche.items.length === 2 && !S.suche.laeuft, null, { timeout: 15000 });
    assert.equal(await p.evaluate(() => S.v), "suchen");
    assert.deepEqual(await p.evaluate(() => S.suche.items.map(i => [i.name, i.status])), [["Reis", "fertig"], ["Milch", "fertig"]]);
    assert.equal(await p.evaluate(() => location.hash), "#suchen");
    assert.deepEqual(fehler, []);
  });
});

t("Preisalarm: eigener Bereich, je Artikel ein- und ausschalten, Wunschpreis oder jedes Angebot", async () => {
  await mitSeite({}, async ({ p, fehler }, u) => {
    const fav = n => JSON.parse(u.store.get("favoriten")).find(f => f.name === n);
    await bereich(p, "alarm");
    assert.match(await p.textContent(".box-kopf h2"), /0 von 3 an/);
    await p.click('[data-al-an="Äpfel"]'); await p.waitForTimeout(1100);
    assert.deepEqual(fav("Äpfel").alarm, { wert: 9999, einheit: "kg", ml: null });
    await p.click('[data-al-modus="Äpfel"][data-wert="preis"]'); await p.waitForTimeout(200);
    const w = p.locator('[data-al-wert="Äpfel"]'); await w.fill("1,50"); await w.press("Enter"); await p.waitForTimeout(1100);
    assert.equal(fav("Äpfel").alarm.wert, 1.5);
    assert.deepEqual(await p.$$eval('[data-al-einheit="Äpfel"] option', e => e.map(x => x.value)), ["kg"]);
    await p.click('[data-al-an="Eier"]'); await p.waitForTimeout(1100);
    assert.match(await p.textContent(".box-kopf h2"), /2 von 3 an/);
    await p.click('[data-al-an="Äpfel"]'); await p.waitForTimeout(1100);
    assert.equal(fav("Äpfel").alarm, undefined, "ausgeschaltet");
    // Alle Artikel der Liste auf einmal
    await bereich(p, "angebote"); await p.click('.produkt[data-p="Reis"] .p-plus');
    await bereich(p, "alarm"); await p.click('[data-aktion="alarmListe"]'); await p.waitForTimeout(1100);
    assert.equal(fav("Reis").alarm.wert, 9999);
    // auch auf der Produktseite
    await bereich(p, "angebote"); await p.click('.produkt[data-p="Eier"]'); await p.waitForTimeout(300);
    assert.ok(await p.$('[data-al-an="Eier"]:checked'));
    assert.deepEqual(fehler, []);
  });
});

t("Liste: alte Mengen werden ganze Stück, Vergleich auch ohne Markt mit allen Artikeln", async () => {
  await mitSeite({ favs: [{ name: "Butter", aus: "" }, { name: "Eier", aus: "" }, { name: "Äpfel", aus: "" }] }, async ({ p, fehler }) => {
    await p.evaluate(() => { localStorage.setItem("pv-zettel", JSON.stringify({ Butter: 0.6, Eier: 10, "Äpfel": 1, "Alt|1250": 2 })); });
    await p.reload(); await p.waitForTimeout(1500); await bereich(p, "liste");
    assert.equal(await p.evaluate(() => zettel.Butter), 0.5, "0,6 kg werden 2 Stück à 250 g");
    assert.match(await p.textContent("#ansicht"), /alter Eintrag ohne Favorit \(Alt\)/);
    const bon = (await p.textContent(".bon")).replace(/\s+/g, " ");
    assert.match(bon, /Beste Wahl/); assert.match(bon, /von 3 Artikeln im Angebot/);
    const zeilen = await p.$$eval(".zeile .posten-info", e => e.map(x => x.textContent.replace(/\s+/g, " ")));
    assert.ok(zeilen.length === 3 && zeilen.every(z => /€/.test(z)), JSON.stringify(zeilen));
    await p.click('[data-aktion="alteWeg"]'); await p.waitForTimeout(200);
    assert.equal(await p.evaluate(() => "Alt|1250" in zettel), false);
    assert.deepEqual(fehler, []);
  });
});

t("Liste: Menge in Stück, Normalpreis je Stück, Vergleich mit bester Wahl", async () => {
  await mitSeite({ favs: [{ name: "Butter", aus: "" }, { name: "Eier", aus: "" }] }, async ({ p, fehler }) => {
    await p.click('.produkt[data-p="Butter"] .p-plus'); await p.click('.produkt[data-p="Eier"] .p-plus');
    await bereich(p, "liste");
    assert.match(await p.textContent(".zeile"), /Stück à 250 g/);
    await p.click('.zeile [data-schritt="1"] >> nth=0'); await p.waitForTimeout(200);
    assert.equal(await p.evaluate(() => zettel.Butter), 0.5);
    const rw = p.locator(".zeile >> nth=0").locator("input[data-r]");
    await rw.fill("2,29"); await rw.press("Tab"); await p.waitForTimeout(200);
    assert.equal(await p.evaluate(() => richt.Butter), 9.16);
    assert.match(await p.textContent(".bon"), /Beste Wahl/);
    assert.deepEqual(fehler, []);
  });
});

t("Liste: Name führt zur Produktseite (mit Marktguru-Link), Zurück an dieselbe Stelle", async () => {
  await mitSeite({ favs: [{ name: "Butter", aus: "" }, { name: "Eier", aus: "" }, { name: "Milch", aus: "" }] }, async ({ p, fehler }) => {
    for (const n of ["Butter", "Eier", "Milch"]) await p.click(`.produkt[data-p="${n}"] .p-plus`);
    await bereich(p, "liste");
    await p.setViewportSize({ width: 390, height: 420 });
    const link = p.locator(".zeile a.plink", { hasText: "Milch" }).first();
    await link.scrollIntoViewIfNeeded(); await p.waitForTimeout(100);
    const y = await p.evaluate(() => scrollY);
    assert.ok(y > 50, "Liste ist gescrollt: " + y);
    await link.click(); await p.waitForTimeout(300);
    assert.equal(await p.evaluate(() => S.v + "|" + S.p), "produkt|Milch");
    assert.equal(await p.textContent("#titel"), "Milch");
    assert.ok(await p.locator('tbody a[href^="https://"]').count() > 0, "Link zu Marktguru auf der Produktseite");
    assert.equal(await p.locator('#leiste [data-v="liste"].an').count(), 1, "Liste bleibt in der Leiste markiert");
    await p.click("#zurueck"); await p.waitForTimeout(300);
    assert.equal(await p.evaluate(() => S.v), "liste");
    const y2 = await p.evaluate(() => scrollY);
    assert.ok(Math.abs(y2 - y) < 30, `gleiche Stelle: ${y} → ${y2}`);
    assert.deepEqual(fehler, []);
  });
});

t("Alter Preis (oldPrice) wird als „statt …“ angezeigt", async () => {
  await mitSeite({ favs: [{ name: "Milch", aus: "" }] }, async ({ p }) => {
    assert.match(await p.textContent('.produkt[data-p="Milch"]'), /statt 1,09/);
    await p.click('.produkt[data-p="Milch"]'); await p.waitForTimeout(300);
    assert.match(await p.textContent("tbody"), /statt\s+1,09/);
  });
});

t("Ohne Zugangscode: eigene Favoriten im Browser, Angebote über die öffentliche Abfrage", async () => {
  await mitSeite({ code: "" }, async ({ p, fehler }, u) => {
    assert.match(await p.textContent("#ansicht"), /Noch keine Favoriten/);
    await suche(p, "Butter");
    await klick(p, '[data-ik="0|0"]');
    const lokal = await p.evaluate(() => JSON.parse(localStorage.getItem("pv-favs")));
    assert.equal(lokal.length, 1); assert.equal(lokal[0].suche, "Butter");
    assert.equal(JSON.parse(u.store.get("favoriten")).length, 3, "Server-Favoriten unverändert");
    await p.reload(); await p.waitForTimeout(1500); await bereich(p, "angebote");
    const karten = await p.$$eval(".produkt h3", e => e.map(x => x.textContent));
    assert.deepEqual(karten, [lokal[0].name]);
    assert.match(await p.textContent(".produkt .preisschild"), /€/);
    assert.deepEqual(fehler, []);
  });
});
