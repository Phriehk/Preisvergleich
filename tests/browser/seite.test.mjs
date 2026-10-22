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
  if (opts.vorbereiten) await opts.vorbereiten(u);
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

t("Suche: Name führt zu allen Angeboten nach Markt, dort im Markt kaufen; Markt in der Liste wählbar", async () => {
  await mitSeite({ favs: [{ name: "Eier", aus: "" }] }, async ({ p, fehler }, u) => {
    await suche(p, "Butter");
    await p.click('.kachel a[data-tz="0|*"]'); await p.waitForTimeout(300);
    assert.equal(await p.evaluate(() => S.v), "treffer");
    assert.equal(await p.textContent("#titel"), "Butter"); assert.match(await p.textContent("#untertitel"), /Alle Marken/);
    assert.equal(await p.locator("#zurueck").isVisible(), true);
    assert.equal(await p.locator('#leiste [data-v="suchen"].an').count(), 1);
    const maerkte = await p.$$eval(".t-markt h2", e => e.map(x => x.textContent.trim()));
    assert.deepEqual(maerkte, ["REWE", "PENNY", "ALDI SÜD"], "günstigster Preis je kg zuerst");
    assert.match(await p.textContent(".t-markt >> nth=0"), /am günstigsten[\s\S]*Milram Butter[\s\S]*6,98\s€\/kg[\s\S]*3,49\s€/);
    assert.equal(await p.locator('.t-markt a.t-link[href^="https://www.marktguru.de/offers/"]').count(), await p.locator('.t-z').count(), await p.$$eval('.t-z', e => e.map(x => x.innerHTML).join('\n')));
    await p.click('#zurueck'); await p.waitForTimeout(300);
    assert.equal(await p.evaluate(() => S.v), "suchen");
    // Kachel einer Marke: nur ihre Angebote, „Hier kaufen“ setzt sie mit diesem Markt auf die Liste
    const j = await p.evaluate(() => S.suche.items[0].karten.findIndex(c => c.label === "Weihenstephan Butter"));
    await p.click(`.kachel a[data-tz="0|${j}"]`); await p.waitForTimeout(300);
    assert.equal(await p.textContent("#titel"), "Weihenstephan Butter");
    assert.deepEqual(await p.$$eval(".t-markt h2", e => e.map(x => x.textContent.trim())), ["PENNY"]);
    await p.click('.t-markt [data-tw]');
    await p.waitForFunction(() => !S.suche.busy && wahlName("Weihenstephan Butter") === "PENNY", null, { timeout: 10000 });
    assert.match(await p.textContent('.t-markt [data-tw]'), /Hier gekauft/);
    assert.match(await p.textContent("#ansicht"), /du kaufst es bei PENNY/);
    // Liste: Markt selbst wählen
    await p.click('#leiste [data-v="angebote"]'); await p.waitForTimeout(300);
    await p.click('.produkt[data-p="Eier"] .p-plus');
    await p.click('#leiste [data-v="liste"]'); await p.waitForTimeout(300);
    const eier = p.locator(".zeile", { hasText: "Eier" }).first();
    assert.match(await eier.locator(".posten-info").textContent(), /ALDI SÜD|PENNY/);
    await eier.locator("select[data-wahl]").selectOption("Kaufland"); await p.waitForTimeout(300);
    assert.equal(await p.evaluate(() => wahl.Eier), "Kaufland");
    assert.match(await p.locator(".zeile", { hasText: "Eier" }).first().locator(".posten-info").textContent(), /📌[\s\S]*Kaufland/);
    assert.match(await p.textContent(".bon"), /Selbst gewählt: Eier bei Kaufland, Weihenstephan Butter bei PENNY/);
    assert.match(await p.textContent(".bon-kopf"), /Kaufland/);
    await p.click('#leiste [data-v="einkaufen"]'); await p.waitForTimeout(300);
    const gr = await p.evaluate(() => expGruppen().map(g => g.kopf + ":" + g.namen.map(x => x.name).join(",")));
    assert.ok(gr.includes("Kaufland:Eier") && gr.includes("PENNY:Weihenstephan Butter"), JSON.stringify(gr));
    await p.click('#leiste [data-v="liste"]'); await p.waitForTimeout(300);
    await p.locator(".zeile", { hasText: "Eier" }).first().locator("select[data-wahl]").selectOption(""); await p.waitForTimeout(300);
    assert.equal(await p.evaluate(() => wahl.Eier), undefined);
    assert.equal(JSON.parse(await p.evaluate(() => localStorage.getItem("pv-wahl")))["Weihenstephan Butter"], "PENNY");
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

t("Alle Angebote je Markt: Märkte, Gruppen, Suche, Favorit und Liste", async () => {
  await mitSeite({ favs: [{ name: "Eier", aus: "" }] }, async ({ p, fehler }, u) => {
    await p.click('[data-seg="aTab"][data-wert="markt"]');
    await p.waitForSelector(".mk-chips .chip", { timeout: 10000 });
    assert.equal(await p.evaluate(() => location.hash), "#markt");
    assert.equal(await p.locator('#leiste [data-v="angebote"].an').count(), 1);
    const chips = await p.$$eval(".mk-chips .chip", e => e.map(x => x.textContent.replace(/\s+/g, " ").trim()));
    assert.ok(chips.some(c => /^Lidl 4$/.test(c)) && chips.some(c => /^PENNY 4$/.test(c)), JSON.stringify(chips));
    await p.click('.mk-chips [data-mk="126679"]');
    await p.waitForSelector(".mk-gruppe", { timeout: 10000 });
    const gruppen = async () => p.$$eval(".mk-gruppe > summary", e => e.map(x => x.textContent.replace(/\s+/g, " ").trim()));
    let g = await gruppen();
    assert.ok(g.includes("Milch, Käse & Eier 2") && g.includes("Nudeln, Reis & Spezialitäten 1") && !g.some(x => /Garten/.test(x)), JSON.stringify(g));
    assert.equal(await p.locator(".mk-z").count(), 0, "Gruppen sind zu, bis man sie öffnet");
    await p.click('[data-seg="mkBereich"][data-wert="alle"]');
    g = await gruppen(); assert.ok(g.some(x => /^Garten & Heimwerken 1/.test(x)), JSON.stringify(g));
    await p.click('.mk-gruppe:has-text("Milch, Käse") > summary'); await p.waitForTimeout(300);
    const milch = p.locator(".mk-z", { hasText: "Milbona" });
    assert.match(await milch.textContent(), /0,89\s*€[\s\S]*statt 1,09/);
    assert.match(await milch.locator("a.plink").getAttribute("href"), /^https:\/\/www\.marktguru\.de\/offers\/\d+/);
    await p.fill("#mkSuche", "reis"); await p.waitForTimeout(300);
    const zeilen = await p.$$eval(".mk-z", e => e.map(x => x.querySelector(".mk-t b").textContent));
    assert.deepEqual(zeilen, ["Tilda Basmati Reis"]);
    await p.click('.mk-z [data-mkl]'); await p.waitForFunction(() => !S.suche.busy && aufListe("Tilda Basmati Reis"), null, { timeout: 10000 });
    const fav = JSON.parse(u.store.get("favoriten")).find(f => f.name === "Tilda Basmati Reis");
    assert.ok(fav && fav.suche === "Tilda Basmati Reis" && JSON.stringify(fav.nur) === '["tilda"]', JSON.stringify(fav));
    assert.match(await p.textContent(".mk-z [data-mkl]"), /✓/);
    assert.match(await p.textContent(".mk-z [data-mkf]"), /★/);
    await p.fill("#mkSuche", ""); await p.waitForTimeout(200);
    await p.click('#leiste [data-v="liste"]'); await p.waitForTimeout(300);
    assert.match(await p.textContent("#ansicht"), /Tilda Basmati Reis/);
    assert.match(await p.textContent(".zeile", { timeout: 2000 }), /Lidl/);
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

t("Normalpreis: Vorschlag aus „statt …“, eigener Preis ersetzt ihn, sonst bleibt das Feld leer", async () => {
  await mitSeite({ favs: [{ name: "Milch", aus: "" }, { name: "Butter", aus: "" }] }, async ({ p, fehler }) => {
    await p.click('.produkt[data-p="Milch"] .p-plus'); await p.click('.produkt[data-p="Butter"] .p-plus');
    await bereich(p, "liste");
    const feld = n => p.locator(".zeile", { hasText: n }).first().locator("input[data-r]");
    assert.equal(await feld("Milch").inputValue(), "1,09");
    assert.equal(await feld("Milch").getAttribute("class"), "vorschlag");
    assert.match(await p.locator(".zeile", { hasText: "Milch" }).first().textContent(), /Vorschlag aus dem früheren Preis \(„statt“\) bei Lidl/);
    assert.equal(await feld("Butter").inputValue(), "", "ohne „statt“-Preis und ohne eigenen Preis leer");
    assert.equal(await p.evaluate(() => richt.Milch), undefined, "der Vorschlag wird nicht gespeichert");
    await feld("Milch").fill("1,19"); await feld("Milch").press("Tab"); await p.waitForTimeout(200);
    assert.equal(await p.evaluate(() => richt.Milch), 1.19);
    assert.equal(await feld("Milch").getAttribute("class"), null);
    assert.equal(await feld("Milch").inputValue(), "1,19");
    await feld("Milch").fill(""); await feld("Milch").press("Tab"); await p.waitForTimeout(200);
    assert.equal(await p.evaluate(() => richt.Milch), undefined);
    assert.equal(await feld("Milch").inputValue(), "1,09", "ohne eigenen Preis wieder der Vorschlag");
    assert.deepEqual(fehler, []);
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

t("Suche: „Meintest du …?“ bei Tippfehlern, ein Tipp sucht neu", async () => {
  await mitSeite({}, async ({ p, fehler }) => {
    await suche(p, "Kerygold");
    await p.waitForSelector("[data-mein]", { timeout: 15000 });
    const vor = await p.$$eval("[data-mein]", e => e.map(x => x.dataset.wort));
    assert.ok(vor.includes("Kerrygold"), JSON.stringify(vor));
    await p.click('[data-mein][data-wort="Kerrygold"]');
    await p.waitForFunction(() => S.suche.items[0].name === "Kerrygold" && S.suche.items[0].status === "fertig", null, { timeout: 15000 });
    assert.equal(await p.inputValue("#sucheText"), "Kerrygold");
    assert.deepEqual(fehler, []);
  });
});

t("Scannen: Nummer eingeben, Produkt aus Open Food Facts, Angebote prüfen, als Favorit speichern", async () => {
  await mitSeite({}, async ({ p, fehler }, u) => {
    let gefragt = "";
    await p.route("https://world.openfoodfacts.org/**", r => { gefragt = r.request().url(); r.fulfill({ headers: { "access-control-allow-origin": "*", "content-type": "application/json" }, body: JSON.stringify({ status: 1, product: { product_name: "Irische Butter", brands: "Kerrygold, Ornua", quantity: "250 g" } }) }); });
    await bereich(p, "suchen");
    await p.click('[data-aktion="scannen"]');
    assert.equal(await p.isVisible("#scanDlg"), true);
    await p.fill("#sEan", "4006381333932");   // falsche Prüfziffer
    await p.click("#sEanLos");
    assert.match(await p.textContent("#sStatus"), /stimmt nicht/);
    await p.fill("#sEan", "4006381333931");
    await p.click("#sEanLos");
    await p.waitForFunction(() => document.getElementById("sMarke"), null, { timeout: 10000 });
    assert.match(gefragt, /\/api\/v2\/product\/4006381333931\.json/);
    assert.equal(await p.inputValue("#sMarke"), "Kerrygold");
    assert.equal(await p.inputValue("#sArtikel"), "Butter");   // „Irische“ ist nur eine Eigenschaft
    await p.waitForFunction(() => /Gerade 1 Angebot/.test(document.getElementById("sAngebote").textContent), null, { timeout: 15000 });
    await p.click("#sSpeichern");
    await p.waitForFunction(() => document.getElementById("sSpeichern").textContent.includes("Gespeichert"), null, { timeout: 15000 });
    const f = JSON.parse(await u.KV.get("favoriten")).find(x => x.name === "Kerrygold Butter");
    assert.ok(f, "Favorit fehlt");
    assert.deepEqual([f.nur, f.suche], [["kerrygold"], "Butter"]);
    await p.click("#sZu");
    await bereich(p, "angebote");
    assert.ok((await p.$$eval(".produkt h3", e => e.map(x => x.textContent))).includes("Kerrygold Butter"));
    assert.deepEqual(fehler, []);
  });
});

t("Vorrat: Tiefstpreis seit Beginn der Aufzeichnung bekommt einen Hinweis", async () => {
  const vorbereiten = async u => {
    const monate = new Map(), heute = Date.now();
    for (let i = 60; i >= 1; i--) {
      const d = new Date(heute - i * 864e5).toISOString().slice(0, 10), m = d.slice(0, 7);
      (monate.get(m) || monate.set(m, []).get(m)).push([d, "ALDI SÜD", "Reis", 1, 2.5, 2.5, "", "", "Reis"].join(";"));
    }
    const alt = JSON.parse((await u.KV.get("verlauf:monate")) || "[]");
    for (const [m, z] of monate) { const v = (await u.KV.get("verlauf:" + m)) || ""; await u.KV.put("verlauf:" + m, [...z, v].filter(Boolean).join("\n")); if (!alt.includes(m)) alt.push(m); }
    await u.KV.put("verlauf:monate", JSON.stringify(alt.sort()));
  };
  await mitSeite({ vorbereiten }, async ({ p, fehler }) => {
    await p.waitForTimeout(800);
    const reis = await p.textContent('.produkt[data-p="Reis"]');
    assert.match(reis, /📦 Tiefstpreis seit Beginn/);
    assert.doesNotMatch(await p.textContent('.produkt[data-p="Eier"]'), /Tiefstpreis|Bestpreis/);
    await p.click('.produkt[data-p="Reis"]'); await p.waitForTimeout(300);
    assert.match(await p.textContent("#ansicht"), /auf Vorrat/);
    assert.deepEqual(fehler, []);
  });
});

t("Einkaufen ohne Netz: Haken bleiben auf dem Gerät und gehen später ins Konto", async () => {
  await mitSeite({ code: "" }, async ({ p, fehler }, u) => {
    await bereich(p, "mehr");
    await p.click('[data-seg="kMode"][data-wert="neu"]');
    await p.fill("#kName", "ben"); await p.fill("#kPw", "geheim123"); await p.fill("#kPw2", "geheim123"); await p.click("#kGo");
    await p.waitForSelector("#kWer", { timeout: 15000 });
    await bereich(p, "einkaufen");
    await p.fill("#extraName", "Zahnpasta"); await p.press("#extraName", "Enter"); await p.waitForTimeout(2200);
    await p.route("https://preise.phriehk.workers.dev/konto/**", r => r.abort());   // Funkloch
    await p.check('#ansicht input[data-hk]'); await p.waitForTimeout(2200);
    assert.match(await p.textContent("#ansicht"), /auf diesem Gerät gespeichert/);
    assert.deepEqual(JSON.parse(u.store.get("u:ben")).daten.haken || {}, {});
    await p.unroute("https://preise.phriehk.workers.dev/konto/**");
    await p.reload(); await p.waitForTimeout(2500);   // beim nächsten Öffnen gewinnt dieses Gerät, nicht der alte Stand im Konto
    assert.equal(Object.keys(JSON.parse(u.store.get("u:ben")).daten.haken || {}).length, 1);
    await bereich(p, "einkaufen");
    assert.equal(await p.isChecked('#ansicht input[data-hk]'), true);
    assert.doesNotMatch(await p.textContent("#ansicht"), /auf diesem Gerät gespeichert/);
    assert.deepEqual(fehler, []);
  });
});
