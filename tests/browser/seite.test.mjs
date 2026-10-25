// Ende-zu-Ende: die echte Seite im Browser gegen den echten Worker-Code (Marktguru nachgebaut).
// Braucht Playwright mit Chromium (in der Pipeline installiert); ohne wird übersprungen.
import test from "node:test";
import assert from "node:assert/strict";
import { umgebung, browserStarten, playwright, DATEN, O, PDFJS_DIR, pdfMachen, prospektSeiten, visionAntwort } from "./lib.mjs";

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
const marktWahl = async (p, id) => {   // „Nach Markt“: Liste der Märkte aufklappen (falls zu) und einen antippen
  await p.waitForSelector(".mk-wahl", { timeout: 10000 });
  if (!(await p.$eval(".mk-wahl", d => d.open))) await p.click(".mk-wahl > summary");
  await p.click(`.mk-liste [data-mk="${id}"]`);
};
const klick = async (p, sel) => { await p.evaluate(s => document.querySelector(s).click(), sel); await p.waitForTimeout(900); };
const bereich = async (p, v) => { await p.click(`#leiste [data-v="${v}"]`); await p.waitForTimeout(300); };
const suche = async (p, text) => { await bereich(p, "suchen"); await p.fill("#sucheText", text); await p.click('[data-aktion="suchen"]'); await p.waitForFunction(() => !S.suche.laeuft, null, { timeout: 15000 }); await p.waitForTimeout(200); };

t("Alle Bereiche laden ohne Fehler, auch die Produktseite", async () => {
  await mitSeite({}, async ({ p, fehler }) => {
    assert.deepEqual(await p.$$eval(".produkt h3", e => e.map(x => x.textContent)), ["Äpfel", "Eier", "Reis"]);
    for (const v of ["suchen", "liste", "einkaufen", "mehr", "angebote"]) await bereich(p, v);
    await p.click('.produkt[data-p="Eier"]'); await p.waitForTimeout(300);
    assert.equal(await p.textContent("#titel"), "Eier");
    assert.ok(await p.$$eval("tbody tr", e => e.length) >= 2);
    await p.click('[data-seg="sort2"][data-wert="preis"]');
    await p.goBack(); await p.waitForTimeout(300);
    assert.equal(await p.textContent("#titel"), "Angebote");
    assert.deepEqual(fehler, []);
  });
});

t("Konto anlegen: Passwortprüfung, Anmeldung, Abgleich ohne Datenverlust (auch wenn ein Gerät nur einen Teil schickt)", async () => {
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
    // ... und bleibt, wenn eine ältere Fassung der Seite nur ihre Felder schickt
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

t("Alle Angebote je Markt: Märkte untereinander (ohne Baumärkte), Gruppen, Suche, Favorit und Liste", async () => {
  await mitSeite({ favs: [{ name: "Eier", aus: "" }], daten: { ...DATEN, schrauben: [O("OBI", "Schrauben", "Fischer", "100 Stück", 4.99)] } }, async ({ p, fehler }, u) => {
    await p.click('[data-seg="aTab"][data-wert="markt"]');
    await p.waitForSelector(".mk-liste .mk-m", { timeout: 10000 });
    assert.equal(await p.evaluate(() => location.hash), "#markt");
    assert.equal(await p.locator('#leiste [data-v="angebote"].an').count(), 1);
    assert.equal(await p.$eval(".mk-wahl", d => d.open), true, "beim ersten Mal ist die Liste offen");
    const chips = await p.$$eval(".mk-liste .mk-m", e => e.map(x => x.textContent.replace(/\s+/g, " ").trim()));
    assert.ok(chips.some(c => /^Lidl 4 Angebote$/.test(c)) && chips.some(c => /^PENNY 4 Angebote$/.test(c)), JSON.stringify(chips));
    assert.ok(!chips.some(c => /OBI/.test(c)), "Baumarkt fehlt: " + JSON.stringify(chips));
    const lage = await p.$$eval(".mk-liste .mk-m", e => e.map(x => x.getBoundingClientRect()).map(r => [Math.round(r.left), Math.round(r.top)]));
    assert.ok(lage.every((r, i) => i === 0 || (r[0] === lage[0][0] && r[1] > lage[i - 1][1])), "untereinander: " + JSON.stringify(lage));
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "nichts zum Seitwärtsscrollen");
    await p.click('.mk-liste [data-mk="126679"]');
    assert.equal(await p.$eval(".mk-wahl", d => d.open), false, "nach der Wahl zu");
    assert.match(await p.textContent(".mk-wahl > summary"), /Lidl[\s\S]*Markt wechseln/);
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
    assert.ok(fav && fav.suche === "Tilda Basmati Reis" && JSON.stringify(fav.nur) === '["tildabasmatireis"]', JSON.stringify(fav));
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
    await p.route("https://world.openfoodfacts.org/**", r => { gefragt = r.request().url(); r.fulfill({ headers: { "access-control-allow-origin": "*", "content-type": "application/json" }, body: JSON.stringify({ status: 1, product: { product_name: "Irische Butter", brands: "Kerrygold, Ornua", quantity: "250 g", image_front_small_url: "https://images.openfoodfacts.org/butter.200.jpg" } }) }); });
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
    assert.equal(f.bild, "https://images.openfoodfacts.org/butter.200.jpg", "Vorschaubild aus dem Scan bleibt");
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

t("Mitteilungen: im Preisalarm einschalten, Test senden, ntfy abschalten, ausschalten", async () => {
  const u = await umgebung({ ntfy: true });
  await u.KV.put("favoriten", JSON.stringify([{ name: "Milch", aus: "" }]));
  await u.A("/aktualisieren", "POST");
  const k = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const p256dh = Buffer.from(await crypto.subtle.exportKey("raw", k.publicKey)).toString("base64url"), auth = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
  const s = await browserStarten(u, {});
  try {
    // so wie die App auf dem Home-Bildschirm: Hintergrunddienst mit Push, Erlaubnis wird beim Tippen erteilt
    await s.c.addInitScript(([p256dh, auth]) => {
      const abo = { endpoint: "https://push.example/geraet", options: { applicationServerKey: null }, toJSON() { return { endpoint: this.endpoint, keys: { p256dh, auth } }; }, unsubscribe: async () => { window.__abo = null; return true; } };
      window.__abo = null;
      const reg = { pushManager: { getSubscription: async () => window.__abo, subscribe: async o => { abo.options.applicationServerKey = o.applicationServerKey.buffer; window.__abo = abo; return abo; } } };
      Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { register: async () => reg, getRegistration: async () => reg, ready: Promise.resolve(reg), addEventListener() {} } });
      let erlaubt = "default";
      window.Notification = { get permission() { return erlaubt; }, requestPermission: async () => (erlaubt = "granted") };
    }, [p256dh, auth]);
    await s.oeffnen("#alarm");
    const p = s.p;
    await p.waitForSelector('[data-aktion="pushAn"]', { timeout: 5000 });
    assert.match(await p.textContent("#ansicht"), /Mitteilungen[\s\S]*direkt auf dieses Gerät/);
    await p.click('[data-aktion="pushAn"]');
    await p.waitForFunction(() => S.push.stand === "an" && !S.push.busy, null, { timeout: 5000 });
    const abos = JSON.parse(u.store.get("push:abos"));
    assert.equal(abos.length, 1); assert.equal(abos[0].endpoint, "https://push.example/geraet"); assert.equal(abos[0].keys.auth, auth);
    assert.match(await p.textContent("#ansicht"), /An auf diesem Gerät/);
    await p.click('[data-aktion="pushTest"]'); await p.waitForFunction(() => !S.push.busy);
    assert.equal(u.push.length, 1); assert.equal(u.push[0].url, "https://push.example/geraet");
    await p.uncheck("[data-push-ntfy]"); await p.waitForTimeout(300);
    assert.equal(u.store.get("push:ntfy"), "aus");
    await p.uncheck("[data-push-woche]"); await p.waitForTimeout(300);
    assert.equal(u.store.get("push:woche"), "aus");
    await p.click('[data-aktion="wocheJetzt"]'); await p.waitForTimeout(500);
    assert.equal(u.push.length, 2, "Wochenüberblick auf Knopfdruck");
    await p.click('[data-aktion="pushAus"]'); await p.waitForFunction(() => S.push.stand === "aus" && !S.push.busy);
    assert.deepEqual(JSON.parse(u.store.get("push:abos")), []);
    assert.deepEqual(s.fehler, []);
  } finally { await s.b.close(); }
});

t("Suche nach einer Marke: je Produkt eine Kachel (Nivea Pflegedusche, Nivea Creme), Favorit zählt nur dieses Produkt", async () => {
  const nivea = [O("PENNY", "Pflegedusche", "Nivea", "250 ml", 1.49), O("Kaufland", "Pflege-Dusche", "Nivea", "250 ml", 1.59), O("PENNY", "Creme", "Nivea", "150 ml", 2.29), O("Lidl", "Deospray", "Nivea", "150 ml", 1.79), O("Kaufland", "Creme", "Nivea", "400 ml", 4.99)];
  await mitSeite({ daten: { ...DATEN, nivea }, favs: [{ name: "Eier", aus: "" }] }, async ({ p, fehler }, u) => {
    await suche(p, "Nivea");
    const karten = await p.evaluate(() => S.suche.items[0].karten.map(c => c.label + ":" + c.os.length));
    assert.deepEqual(karten.sort(), ["Nivea Creme:2", "Nivea Deospray:1", "Nivea Pflegedusche:2"], "Pflegedusche und Pflege-Dusche sind dasselbe Produkt");
    const j = await p.evaluate(() => S.suche.items[0].karten.findIndex(c => c.label === "Nivea Pflegedusche"));
    await p.click(`.kachel a[data-tz="0|${j}"]`); await p.waitForTimeout(300);
    const zeilen = await p.$$eval(".t-z .mk-t b", e => e.map(x => x.textContent));
    assert.deepEqual(zeilen.sort(), ["Pflege-Dusche", "Pflegedusche"], "keine Creme und kein Deo");
    await p.click('#zurueck'); await p.waitForTimeout(300);
    await p.click(`[data-il="0|${j}"]`); await p.waitForFunction(() => !S.suche.busy && aufListe("Nivea Pflegedusche"), null, { timeout: 10000 });
    const fav = JSON.parse(u.store.get("favoriten")).find(f => f.name === "Nivea Pflegedusche");
    assert.deepEqual(fav.nur, ["niveapflegedusche"]); assert.equal(fav.suche, "Nivea");
    // der tägliche Lauf holt für den Favoriten nur dieses Produkt
    await u.A("/aktualisieren", "POST");
    const ang = JSON.parse(u.store.get("angebote")).filter(x => x.gruppe === "Nivea Pflegedusche");
    assert.ok(ang.length >= 2 && ang.every(x => /Pflege-?Dusche/i.test(x.produkt)), JSON.stringify(ang.map(x => x.produkt)));
    assert.deepEqual(fehler, []);
  });
});

t("Favoriten entfernen: unter Angebote mit „Bearbeiten“, in der Suche und unter „Nach Markt“ mit zweimal Tippen", async () => {
  const hidro = [O("ALDI SÜD", "Deodorant-Spray", "Hidrofugal", "150 ml", 2.99), O("REWE", "Deospray", "Hidrofugal", "150 ml", 3.49), O("Kaufland", "Deo Roll-on", "Hidrofugal", "50 ml", 3.49), O("REWE", "Hackfleisch", "thisisnobrand123", "vom Schwein, je 500 g", 3.49)];
  await mitSeite({ daten: { ...DATEN, hidrofugal: hidro }, favs: [{ name: "Eier", aus: "" }, { name: "Milch", aus: "" }] }, async ({ p, fehler }, u) => {
    const namen = () => JSON.parse(u.store.get("favoriten")).map(f => f.name).sort();
    // Angebote: Bearbeiten, ✕ entfernt (auch von der Liste)
    await p.click('.produkt[data-p="Milch"] .p-plus');
    await p.click('[data-aktion="favEdit"]'); await p.waitForTimeout(200);
    assert.equal(await p.locator(".produkt [data-favweg]").count(), 2);
    await p.click('[data-favweg="Milch"]'); await p.waitForTimeout(500);
    assert.deepEqual(namen(), ["Eier"]);
    assert.equal(await p.evaluate(() => aufListe("Milch")), false, "auch von der Liste genommen");
    await p.click('[data-aktion="favEdit"]');
    // Suche: Deodorant-Spray und Deospray sind dasselbe Produkt, die Marken-Attrappe von REWE zählt nicht
    await suche(p, "Hidrofugal");
    const karten = await p.evaluate(() => S.suche.items[0].karten.map(c => c.label + ":" + c.os.length));
    assert.ok(karten.includes("Hidrofugal Deodorant-Spray:2") && karten.includes("Hidrofugal Deo Roll-on:1"), JSON.stringify(karten));
    const j = await p.evaluate(() => S.suche.items[0].karten.findIndex(c => c.label === "Hidrofugal Deo Roll-on"));
    await p.click(`[data-ik="0|${j}"]`); await p.waitForFunction(() => !S.suche.busy && istFav("Hidrofugal Deo Roll-on"));
    await p.click(`[data-ik="0|${j}"]`); await p.waitForTimeout(200);
    assert.match(await p.textContent(`[data-ik="0|${j}"]`), /Entfernen\?/);
    assert.ok(namen().includes("Hidrofugal Deo Roll-on"), "erst nach dem zweiten Tippen weg");
    await p.click(`[data-ik="0|${j}"]`); await p.waitForTimeout(500);
    assert.ok(!namen().includes("Hidrofugal Deo Roll-on"));
    // Nach Markt: ★ → ✕ → entfernt
    await p.click('#leiste [data-v="angebote"]'); await p.waitForTimeout(200);
    await p.click('[data-seg="aTab"][data-wert="markt"]'); await marktWahl(p, "126679"); await p.waitForSelector("#mkSuche", { timeout: 10000 });
    await p.fill("#mkSuche", "reis"); await p.waitForTimeout(300);
    await p.click(".mk-z [data-mkf]"); await p.waitForFunction(() => !S.suche.busy && istFav("Tilda Basmati Reis"));
    await p.click(".mk-z [data-mkf]"); await p.waitForTimeout(200);
    assert.equal((await p.textContent(".mk-z [data-mkf]")).trim(), "✕");
    await p.click(".mk-z [data-mkf]"); await p.waitForTimeout(500);
    assert.ok(!namen().includes("Tilda Basmati Reis"));
    assert.deepEqual(fehler, []);
  });
});

t("Angebote: Hinweise wie „bis …“ stehen immer in einer eigenen Zeile unter dem Preis", async () => {
  await mitSeite({ favs: [{ name: "Milch", aus: "" }, { name: "Eier", aus: "" }] }, async ({ p }) => {
    for (const n of ["Milch", "Eier"]) {
      const lage = await p.evaluate(g => { const k = document.querySelector(`.produkt[data-p="${g}"]`), pr = k.querySelector(".preisschild").getBoundingClientRect(), tg = k.querySelector(".p-tags").getBoundingClientRect(); return tg.top >= pr.bottom - 1; }, n);
      assert.ok(lage, n);
    }
  });
});

t("Favoriten ohne Angebot behalten ihr Vorschaubild, früher gescannte holen es aus Open Food Facts nach", async () => {
  const u = await umgebung();
  await u.KV.put("favoriten", JSON.stringify([{ name: "Eier", aus: "" }, { name: "Seife", aus: "", bild: "https://bilder.example/seife.png" }, { name: "Fa Duschgel", aus: "", nur: ["fa"], suche: "Duschgel" }]));
  await u.A("/aktualisieren", "POST");
  const s = await browserStarten(u, {});
  try {
    await s.c.addInitScript(() => localStorage.setItem("pv-ean", JSON.stringify({ "4005800000000": { marke: "Fa", artikel: "Duschgel" } })));
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    for (const m of ["https://bilder.example/**", "https://images.openfoodfacts.org/**"]) await s.p.route(m, r => r.fulfill({ body: png, headers: { "content-type": "image/png" } }));
    await s.p.route("https://world.openfoodfacts.org/**", r => r.fulfill({ headers: { "access-control-allow-origin": "*", "content-type": "application/json" }, body: JSON.stringify({ status: 1, product: { product_name: "Duschgel", brands: "Fa", image_front_small_url: "https://images.openfoodfacts.org/fa.200.jpg" } }) }));
    await s.oeffnen("");
    const p = s.p, src = n => p.evaluate(g => (document.querySelector(`.produkt[data-p="${g}"] .bild img`) || {}).src || "", n);
    assert.equal(await src("Seife"), "https://bilder.example/seife.png");
    await p.waitForFunction(() => !!document.querySelector('.produkt[data-p="Fa Duschgel"] .bild img'), null, { timeout: 10000 });
    assert.equal(await src("Fa Duschgel"), "https://images.openfoodfacts.org/fa.200.jpg");
    await p.waitForTimeout(500);
    assert.equal(JSON.parse(u.store.get("favoriten")).find(f => f.name === "Fa Duschgel").bild, "https://images.openfoodfacts.org/fa.200.jpg", "auf dem Server gespeichert");
    assert.deepEqual(s.fehler, []);
  } finally { await s.b.close(); }
});

t("Sorten über alle Marken: „Rinder-Hackfleisch“ von mehreren Marken, Favorit holt nur diese Sorte", async () => {
  const hack = [O("Kaufland", "Schweinehackfleisch", "K-Purland", "zum Braten, gekühlt je 500-g-Packg.", 1.89), O("PENNY", "Hackfleisch", "Mühlenhof", "Gemischt, vom Schwein und Rind, je 800-g-Packung", 4.99),
    O("ALDI SÜD", "Gemischt-Hackfleisch", "Gut Ponholz", "500 g aus 50% Schwein und 50% Rind", 3.33), O("REWE", "Hackfleisch", "thisisnobrand123", "vom Schwein, 500-g-Packung", 3.45),
    O("ALDI SÜD", "Rinder-Hackfleisch", "Meine Metzgerei", "500-g-Packung", 4.59), O("ALDI SÜD", "Rinderhackfleisch XXL", "Meine Metzgerei", "1-kg-Packung", 9.49), O("Lidl", "XXL Rinderhackfleisch", "Metzgerfrisch", "1-kg-Packung", 9.49),
    O("PENNY", "Rinder-Hackfleisch", "Gut Ponholz", "zum Braten 500 g", 4.79), O("REWE", "Rinder-Hackfleisch", "Metzgerei Wilhelm Brandenburg", "je 250-g-Pckg.", 3.49)];
  await mitSeite({ daten: { ...DATEN, hackfleisch: hack }, favs: [{ name: "Eier", aus: "" }] }, async ({ p, fehler }, u) => {
    await suche(p, "Hackfleisch");
    const sorten = await p.evaluate(() => S.suche.items[0].sorten.map(x => x.label + ":" + x.marken + ":" + x.os.length));
    assert.deepEqual(sorten, ["Rinder-Hackfleisch:4:5"], JSON.stringify(await p.evaluate(() => S.suche.items[0].roh.map(o => o.marke + "|" + o.produkt + "|" + o.markt))));
    assert.match(await p.textContent(".kachel:has(a[data-tz='0|s:rinderhackfleisch'])"), /alle Marken[\s\S]*4 Marken · 5 Angebote/);
    await p.click("a[data-tz='0|s:rinderhackfleisch']"); await p.waitForTimeout(300);
    assert.equal(await p.textContent("#titel"), "Rinder-Hackfleisch");
    const zeilen = await p.$$eval(".t-z .mk-t b", e => e.map(x => x.textContent));
    assert.equal(zeilen.length, 5); assert.ok(zeilen.every(z => /Rinder/i.test(z)), JSON.stringify(zeilen));
    await p.click("[data-isl='0|rinderhackfleisch']"); await p.waitForFunction(() => !S.suche.busy && aufListe("Rinder-Hackfleisch (alle Marken)"), null, { timeout: 10000 });
    const fav = JSON.parse(u.store.get("favoriten")).find(f => f.name === "Rinder-Hackfleisch (alle Marken)");
    assert.deepEqual([fav.nur, fav.suche], [["sorte:rinderhackfleisch"], "Hackfleisch"]);
    await p.click('#leiste [data-v="angebote"]'); await p.waitForTimeout(300);
    assert.equal(await p.locator('.produkt[data-p="Rinder-Hackfleisch (alle Marken)"]').count(), 1);
    assert.equal(await p.locator('.produkt[data-p="Rinder-Hackfleisch (alle Marken)"] .tag.neu').count(), 0, "ein gerade angelegter Favorit ist nicht „neu“");
    await u.A("/aktualisieren", "POST");
    const ang = JSON.parse(u.store.get("angebote")).filter(x => x.gruppe === "Rinder-Hackfleisch (alle Marken)").map(x => x.produkt);
    assert.ok(ang.length >= 5 && ang.every(z => /Rinder/i.test(z)), JSON.stringify(ang));
    assert.deepEqual(fehler, []);
  });
});

t("„Neu“: beim ersten Öffnen nichts, ein später dazugekommenes bestes Angebot bekommt den Hinweis", async () => {
  const daten = { ...DATEN };
  await mitSeite({ daten, favs: [{ name: "Milch", aus: "" }, { name: "Eier", aus: "" }] }, async ({ p, fehler }, u) => {
    assert.equal(await p.locator(".tag.neu").count(), 0, "beim ersten Mal ist nichts neu");
    daten.milch = [...DATEN.milch, O("Kaufland", "Milch", "Weihenstephan", "1 l", 0.79, "l", 1, 1)];
    await u.A("/aktualisieren", "POST");
    await p.reload(); await p.waitForTimeout(1500);
    assert.equal(await p.locator('.produkt[data-p="Milch"] .tag.neu').count(), 1);
    assert.equal(await p.locator('.produkt[data-p="Eier"] .tag.neu').count(), 0);
    assert.match(await p.textContent("#ansicht"), /1 Favorit hat ein neues bestes Angebot/);
    await p.reload(); await p.waitForTimeout(1500);
    assert.equal(await p.locator('.produkt[data-p="Milch"] .tag.neu').count(), 1, "bleibt nach erneutem Öffnen");
    assert.deepEqual(fehler, []);
  });
});

t("Ersparnis: Abhaken merkt Preis und Normalpreis, Übersicht beim Einkaufen und unter „Mehr“, Haken weg nimmt es zurück", async () => {
  await mitSeite({ favs: [{ name: "Milch", aus: "" }, { name: "Butter", aus: "" }] }, async ({ p, fehler }) => {
    await p.click('.produkt[data-p="Milch"] .p-plus'); await p.click('.produkt[data-p="Butter"] .p-plus');
    await p.click('#leiste [data-v="liste"]'); await p.waitForTimeout(300);
    const rw = p.locator(".zeile", { hasText: "Butter" }).first().locator("input[data-r]"); await rw.fill("2,29"); await rw.press("Tab"); await p.waitForTimeout(200);
    await p.click('#leiste [data-v="einkaufen"]'); await p.waitForTimeout(300);
    const haken = n => p.locator(".haken", { hasText: n }).first().locator("input[type=checkbox]");
    await haken("Milch").check(); await p.waitForTimeout(150); await haken("Butter").check(); await p.waitForTimeout(200);
    const k = await p.evaluate(() => kaeufe.map(e => [e.n, e.m, e.p, e.r]));
    assert.deepEqual(k.sort(), [["Butter", "PENNY", 1.79, 2.29], ["Milch", "Lidl", 0.89, 1.09]].sort(), JSON.stringify(k));
    assert.match(await p.textContent("#ansicht"), /2 Artikel für 2,68\s€, 0,70\s€ gespart/);
    await haken("Butter").uncheck(); await p.waitForTimeout(200);
    assert.equal(await p.evaluate(() => kaeufe.length), 1, "Haken weg: zählt nicht mehr");
    await p.click('#leiste [data-v="mehr"]'); await p.waitForTimeout(300);
    assert.match(await p.textContent("#ansicht"), /Ersparnis[\s\S]*0,20\s€ insgesamt[\s\S]*1 Artikel für 0,89\s€ · meist bei Lidl/);
    await p.click('[data-aktion="ersparnisWeg"]'); await p.click('[data-aktion="ersparnisWeg"]'); await p.waitForTimeout(200);
    assert.equal(await p.evaluate(() => JSON.parse(localStorage.getItem("pv-kaeufe")).length), 0);
    assert.deepEqual(fehler, []);
  });
});

t("Angebote nach Abteilungen (abschaltbar) und Favorit pausieren: nicht abgefragt, eigener Abschnitt, fortsetzen", async () => {
  await mitSeite({ favs: ["Milch", "Butter", "Äpfel", "Reis"].map(name => ({ name, aus: "" })) }, async ({ p, fehler }, u) => {
    const koepfe = () => p.$$eval(".abt-kopf h2", e => e.map(x => x.textContent));
    assert.deepEqual(await koepfe(), ["Obst & Gemüse", "Milch, Käse & Eier", "Vorrat"]);
    await p.click('[data-aktion="gruppenUm"]'); await p.waitForTimeout(200);
    assert.deepEqual(await koepfe(), [], "ohne Gruppen");
    await p.click('[data-aktion="gruppenUm"]'); await p.waitForTimeout(200);
    // pausieren
    await p.click('[data-aktion="favEdit"]'); await p.waitForTimeout(200);
    await p.click('[data-favpause="Reis"]'); await p.waitForTimeout(500);
    assert.equal(JSON.parse(u.store.get("favoriten")).find(f => f.name === "Reis").pause, true);
    assert.equal(await p.locator('.produkt[data-p="Reis"]').count(), 0, "nicht mehr bei den Angeboten");
    assert.match(await p.textContent(".pause-box"), /Pausiert\s*1[\s\S]*Reis/);
    await u.A("/aktualisieren", "POST");
    assert.ok(!JSON.parse(u.store.get("angebote")).some(x => x.gruppe === "Reis"), "pausiert: nicht abgefragt");
    await p.click('[data-favweiter="Reis"]'); await p.waitForTimeout(500);
    assert.equal(JSON.parse(u.store.get("favoriten")).find(f => f.name === "Reis").pause, undefined);
    assert.deepEqual(fehler, []);
  });
});

t("Nach Markt: nach Rabatt sortieren (größter Nachlass zuerst) und „Neu“ seit dem letzten Besuch", async () => {
  const daten = { ...DATEN };
  await mitSeite({ daten, favs: [{ name: "Eier", aus: "" }] }, async ({ p, fehler }, u) => {
    const lidl = async () => { await p.click('[data-seg="aTab"][data-wert="markt"]'); await marktWahl(p, "126679"); await p.waitForSelector("#mkSuche", { timeout: 10000 }); };
    await lidl();
    await p.click('[data-seg="mkSort"][data-wert="rabatt"]'); await p.waitForTimeout(200);
    const r = await p.$$eval(".mk-z", e => e.map(x => x.innerText.replace(/\s+/g, " ")));
    assert.equal(r.length, 1); assert.match(r[0], /Milbona Milch.*−18 %/);
    await p.click('[data-seg="mkSort"][data-wert="neu"]'); await p.waitForTimeout(200);
    assert.equal(await p.locator(".mk-z .tag.neu").count(), 0, "beim ersten Besuch ist nichts neu");
    // ein neues Angebot bei Lidl
    daten.butter = [...DATEN.butter, O("Lidl", "Butter", "Milsani", "250 g", 1.69)];
    for (const k of [...u.store.keys()]) if (/^mk\d:/.test(k)) u.store.delete(k);
    await p.reload(); await p.waitForTimeout(1500); await lidl();
    await p.click('[data-seg="mkSort"][data-wert="neu"]'); await p.waitForTimeout(200);
    const n = await p.$$eval(".mk-z", e => e.map(x => x.innerText.replace(/\s+/g, " ")));
    assert.match(n[0], /Milsani Butter.*neu/, JSON.stringify(n));
    assert.equal(await p.locator(".mk-z .tag.neu").count(), 1);
    assert.deepEqual(fehler, []);
  });
});

t("Einkaufen: je Markt in der Reihenfolge des Laufwegs (Obst zuerst), mit Abteilungen als Zwischenüberschrift", async () => {
  await mitSeite({ favs: ["Reis", "Butter", "Äpfel", "Eier"].map(name => ({ name, aus: "" })) }, async ({ p, fehler }) => {
    await p.evaluate(() => { for (const n of ["Reis", "Butter", "Äpfel", "Eier"]) { aufListeSetzen(n); wahl[n] = "ALDI SÜD"; } listeSpeichern(); render(); });
    await p.click('#leiste [data-v="einkaufen"]'); await p.waitForTimeout(300);
    const aldi = p.locator(".haken-gruppe", { hasText: "ALDI SÜD" }).first();
    const reihe = await aldi.evaluate(g => [...g.querySelectorAll(".gang, .haken span")].map(x => (x.classList.contains("gang") ? "# " : "") + x.textContent.trim()));
    assert.deepEqual(reihe, ["# Obst & Gemüse", "Äpfel", "# Milch, Käse & Eier", "Butter", "Eier", "# Vorrat", "Reis"]);
    assert.deepEqual(fehler, []);
  });
});

t("Spar-Tipp: bei einem Marken-Favoriten steht dieselbe Sorte einer anderen Marke, wenn sie deutlich günstiger ist", async () => {
  const daten = { ...DATEN, butter: [...DATEN.butter, O("Lidl", "Butter", "Milsani", "250 g", 1.49)] };
  for (const code of ["betreiber", ""]) {
    await mitSeite({ daten, code, favs: [{ name: "Weihenstephan Butter", aus: "", nur: ["weihenstephanbutter"], suche: "Butter" }, { name: "Milch", aus: "" }] }, async ({ p, fehler }) => {
      if (!code) { await p.evaluate(async () => { favsLokal = [{ name: "Weihenstephan Butter", aus: "", nur: ["weihenstephanbutter"], suche: "Butter" }]; await angeboteLaden(true); render(); }); }
      const k = p.locator('.produkt[data-p="Weihenstephan Butter"]');
      assert.match(await k.textContent(), /1,79\s€/, "der Favorit selbst bleibt bei seiner Marke");
      assert.match(await k.locator(".p-tipp").textContent(), /Milsani Butter bei Lidl: 1,49\s€ für 250 g, 17 % günstiger/, code || "ohne Code");
      if (code) {
        assert.equal(await p.locator('.produkt[data-p="Milch"] .p-tipp').count(), 0, "Alle-Marken-Favorit braucht keinen Tipp");
        await k.click(); await p.waitForTimeout(300);
        assert.match(await p.textContent(".banner"), /Dieselbe Sorte gibt es günstiger: Milsani Butter bei Lidl/);
      }
      assert.deepEqual(fehler, []);
    });
  }
});

t("Zahl auf dem App-Symbol: neue Angebote, offene Artikel oder keine", async () => {
  const daten = { ...DATEN };
  const u = await umgebung({ daten });
  await u.KV.put("favoriten", JSON.stringify([{ name: "Milch", aus: "" }, { name: "Eier", aus: "" }]));
  await u.A("/aktualisieren", "POST");
  const s = await browserStarten(u, {});
  try {
    await s.c.addInitScript(() => { window.__badge = []; navigator.setAppBadge = async n => { window.__badge.push(n); }; navigator.clearAppBadge = async () => { window.__badge.push(0); }; });
    await s.oeffnen("");
    const p = s.p, letzte = () => p.evaluate(() => window.__badge[window.__badge.length - 1]);
    assert.equal(await letzte(), 0, "beim ersten Öffnen nichts neu");
    daten.milch = [...DATEN.milch, O("Kaufland", "Milch", "Weihenstephan", "1 l", 0.79, "l", 1, 1)];
    await u.A("/aktualisieren", "POST"); await p.reload(); await p.waitForTimeout(1500);
    assert.equal(await letzte(), 1, "ein Favorit mit neuem Angebot");
    await p.click('.produkt[data-p="Eier"] .p-plus'); await p.click('.produkt[data-p="Milch"] .p-plus');
    await p.click('#leiste [data-v="mehr"]'); await p.waitForTimeout(200);
    await p.click('[data-seg="badge"][data-wert="liste"]'); await p.waitForTimeout(200);
    assert.equal(await letzte(), 2, "zwei offene Artikel");
    await p.click('[data-seg="badge"][data-wert="aus"]'); await p.waitForTimeout(200);
    assert.equal(await letzte(), 0);
    assert.deepEqual(s.fehler, []);
  } finally { await s.b.close(); }
});

t("Kassenbon: Zeilen mit Preisen erkennen, der Liste zuordnen, bezahlte Preise und Normalpreise übernehmen", async () => {
  const u = await umgebung();
  await u.KV.put("favoriten", JSON.stringify(["Butter", "Eier", "Milch"].map(name => ({ name, aus: "" }))));
  await u.A("/aktualisieren", "POST");
  const s = await browserStarten(u, {});
  try {
    // die Texterkennung selbst ist nachgebaut (im Test gibt es kein Netz); erkannt wird dieser Text
    await s.c.addInitScript(() => { window.Tesseract = { createWorker: async (l, o, opt) => ({ recognize: async () => { opt.logger({ status: "recognizing text", progress: 0.5 }); return { data: { text: "ALDI SUED\nKERRYGOLD BUTTER 1,99 A\nFREILAND-EIER M 10ST 2,29 A\n2 x 0,89\nH-MILCH 3,5% 1,78 A\nSALZ 0,19 A\nPFAND 0,25 B\nSUMME EUR 6,50\nEC-Karte 6,50" } }; }, terminate: async () => {} }) }; });
    await s.oeffnen("");
    const p = s.p;
    await p.evaluate(() => { for (const n of ["Butter", "Eier", "Milch"]) { aufListeSetzen(n); wahl[n] = "ALDI SÜD"; } wahl.Milch = "Lidl"; frei.Salz = "st"; aufListeSetzen("Salz", 1); listeSpeichern(); render(); });
    assert.deepEqual(await p.evaluate(() => bonZeilen("KERRYGOLD BUTTER 1,99 A\n2 x 0,89\nH-MILCH 3,5% 1,78 A\nRabatt -0,20\nSUMME 3,57").map(z => [z.name, z.preis, z.n])), [["KERRYGOLD BUTTER", 1.99, 1], ["H-MILCH", 1.58, 2]]);
    await p.click('#leiste [data-v="einkaufen"]'); await p.waitForTimeout(300);
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    await p.setInputFiles("#bonFoto", { name: "bon.png", mimeType: "image/png", buffer: png });
    await p.waitForSelector(".bon-pruefen", { timeout: 10000 });
    const zu = await p.evaluate(() => S.bon.zeilen.map(z => [z.name, z.preis, z.k]));
    assert.deepEqual(zu, [["KERRYGOLD BUTTER", 1.99, "Butter"], ["FREILAND-EIER M", 2.29, "Eier"], ["H-MILCH", 1.78, "Milch"], ["SALZ", 0.19, "Salz"]]);
    await p.click('[data-aktion="bonOk"]'); await p.waitForTimeout(300);
    const k = await p.evaluate(() => kaeufe.map(e => e.z + ":" + e.p).sort());
    assert.deepEqual(k, ["Butter:1.99", "Eier:2.29", "Milch:1.78", "Salz:0.19"], "abgehakt, mit den Preisen vom Bon");
    assert.equal(await p.evaluate(() => richt.Salz), 0.19, "ohne Angebot gekauft: Normalpreis je Stück");
    assert.equal(await p.evaluate(() => Object.keys(haken).length), 4);
    assert.deepEqual(s.fehler, []);
  } finally { await s.b.close(); }
});

t("Kassenbon später eingelesen: Einkaufstag vom Bon, Angebot von damals aus dem Preisverlauf, sonst Normalpreis", async () => {
  const p2 = x => String(x).padStart(2, "0"), tag = n => { const d = new Date(Date.now() - n * 864e5); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };
  const D = tag(1), bonDatum = `${D.slice(8, 10)}.${D.slice(5, 7)}.${D.slice(2, 4)}`;
  const u = await umgebung({ daten: { ...DATEN, butter: [] } });   // das Butter-Angebot ist inzwischen abgelaufen
  await u.KV.put("favoriten", JSON.stringify(["Butter", "Eier"].map(name => ({ name, aus: "" }))));
  await u.KV.put("verlauf:" + D.slice(0, 7), `${tag(2)};ALDI SÜD;Butter;0.25;1.99;7.96;${D};${tag(5)};Butter`);
  await u.KV.put("verlauf:monate", JSON.stringify([D.slice(0, 7)]));
  await u.A("/aktualisieren", "POST");
  const s = await browserStarten(u, {});
  try {
    await s.c.addInitScript(t => { window.Tesseract = { createWorker: async () => ({ recognize: async () => ({ data: { text: t } }), terminate: async () => {} }) }; }, `ALDI SÜD\nFiliale 123\n${bonDatum} 10:15\nKERRYGOLD BUTTER 1,99 A\nFREILAND-EIER 2,49 A\nSUMME 4,48`);
    await s.oeffnen("");
    const p = s.p;
    await p.waitForFunction(() => vd.length > 0, null, { timeout: 5000 });
    await p.evaluate(() => { aufListeSetzen("Butter"); aufListeSetzen("Eier"); listeSpeichern(); render(); });
    await p.click('#leiste [data-v="einkaufen"]'); await p.waitForTimeout(300);
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    await p.setInputFiles("#bonFoto", { name: "bon.png", mimeType: "image/png", buffer: png });
    await p.waitForSelector(".bon-pruefen", { timeout: 10000 });
    assert.equal(await p.inputValue("#bonDatum"), D, "Einkaufstag vom Bon");
    assert.equal(await p.inputValue("#bonMarkt"), "ALDI SÜD");
    const was = await p.$$eval(".bon-z2 small.klein-text", e => e.map(x => x.textContent));
    assert.match(was[0], /war im Angebot bei ALDI SÜD/); assert.match(was[1], /wird dein Normalpreis/);
    await p.click('[data-aktion="bonOk"]'); await p.waitForTimeout(300);
    const e = await p.evaluate(() => kaeufe.map(x => [x.z, x.d, x.p, x.a, x.m]));
    assert.deepEqual(e.find(x => x[0] === "Butter"), ["Butter", D, 1.99, 1, "ALDI SÜD"], JSON.stringify(e));
    assert.equal(await p.evaluate(() => richt.Butter), undefined, "Angebotspreis wird kein Normalpreis");
    assert.ok(await p.evaluate(() => richt.Eier > 0), "ohne passendes Angebot: Normalpreis");
    assert.deepEqual(s.fehler, []);
  } finally { await s.b.close(); }
});

t("Kassenbon nach „Abgehakte von der Liste nehmen“: ordnet trotzdem zu (abgehakt am Einkaufstag, Favoriten) und doppelt nichts", async () => {
  const u = await umgebung();
  await u.KV.put("favoriten", JSON.stringify(["Butter", "Eier", "Reis"].map(name => ({ name, aus: "" }))));
  await u.A("/aktualisieren", "POST");
  const s = await browserStarten(u, {});
  try {
    await s.c.addInitScript(() => { window.Tesseract = { createWorker: async () => ({ recognize: async () => ({ data: { text: "ALDI SUED\nKERRYGOLD BUTTER 1,99 A\nFREILAND-EIER 2,29 A\nBASMATI REIS 1,29 A\nSUMME 5,57" } }), terminate: async () => {} }) }; });
    await s.oeffnen("");
    const p = s.p;
    await p.evaluate(() => { for (const n of ["Butter", "Eier"]) { aufListeSetzen(n); wahl[n] = "ALDI SÜD"; } listeSpeichern(); render(); });
    await p.click('#leiste [data-v="einkaufen"]'); await p.waitForTimeout(300);
    for (const n of ["Butter", "Eier"]) { await p.locator(".haken", { hasText: n }).first().locator("input[type=checkbox]").check(); await p.waitForTimeout(150); }
    await p.click('[data-aktion="abgehakteWeg"]'); await p.waitForTimeout(300);
    assert.equal(await p.evaluate(() => zettelNamen().length), 0, "Liste ist leer");
    assert.equal(await p.locator("#bonFoto").count(), 1, "Kassenbon geht auch mit leerer Liste");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    await p.setInputFiles("#bonFoto", { name: "bon.png", mimeType: "image/png", buffer: png });
    await p.waitForSelector(".bon-pruefen", { timeout: 10000 });
    assert.deepEqual(await p.evaluate(() => S.bon.zeilen.map(z => z.k)), ["Butter", "Eier", "Reis"], "Reis war nie auf der Liste, ist aber ein Favorit");
    await p.click('[data-aktion="bonOk"]'); await p.waitForTimeout(300);
    const k = await p.evaluate(() => kaeufe.map(e => e.z + ":" + e.p + ":" + e.a).sort());
    assert.deepEqual(k, ["Butter:1.99:1", "Eier:2.29:1", "Reis:1.29:0"], "abgehakte Käufe aktualisiert, keine doppelten");
    assert.equal(await p.evaluate(() => richt.Butter), undefined);
    assert.equal(await p.evaluate(() => zettelNamen().length), 0, "nichts wieder auf die Liste gesetzt");
    assert.deepEqual(s.fehler, []);
  } finally { await s.b.close(); }
});

t("PENNY: UVP, Streichpreis und App-Preis von penny.de auf der Produktseite und unter „Nach Markt“", async () => {
  const penny = { kuehlregal: [{ title: "WEIHENSTEPHAN Butter*", quantity: "je 250 g", price: "1.79", listPrice: "2.49", benefitPrice: "1.59²", primaryType: "promoPlus", uuid: "b" },
    { title: "WEIHENSTEPHAN H-Milch*", quantity: "je 1 l", price: "0.95", crossOutPrice: "1.15", primaryType: "offer", uuid: "m" }] };
  await mitSeite({ penny, favs: [{ name: "Butter", aus: "" }, { name: "Milch", aus: "" }] }, async ({ p, fehler }) => {
    await p.click('.produkt[data-p="Butter"]'); await p.waitForTimeout(300);
    const t1 = await p.textContent("#ansicht");
    assert.match(t1, /UVP\s*2,49/); assert.match(t1, /App-Preis 1,59/);
    await p.goBack(); await p.waitForTimeout(300);
    await p.click('.produkt[data-p="Milch"]'); await p.waitForTimeout(300);
    const t2 = await p.textContent("#ansicht");
    assert.match(t2, /statt\s*1,15/); assert.match(t2, /statt\s*1,09/, "Lidl behält den Preis von Marktguru"); assert.doesNotMatch(t2, /UVP/);
    await p.goBack(); await p.waitForTimeout(300);
    await p.click('[data-seg="aTab"][data-wert="markt"]');
    await marktWahl(p, "126765");
    await p.waitForSelector(".mk-gruppe", { timeout: 10000 });
    await p.click('.mk-gruppe:has-text("Milch, Käse") > summary'); await p.waitForTimeout(300);
    const t3 = await p.textContent("#ansicht");
    assert.match(t3, /UVP\s*2,49/); assert.match(t3, /App\s*1,59/); assert.match(t3, /statt\s*1,15/);
    assert.deepEqual(fehler, []);
  });
});

t("Prospekt einlesen: PDF auf dem Gerät lesen, frühere Preise werden Normalpreis-Vorschlag, das PENNY-Angebot bekommt „statt“", async () => {
  if (!PDFJS_DIR) return;
  await mitSeite({ favs: [{ name: "Butter", aus: "" }, { name: "Schokolade", aus: "" }], hash: "#mehr" }, async ({ p, fehler }, u) => {
    await p.waitForSelector("#prospektDatei", { state: "attached", timeout: 5000 });
    assert.match(await p.textContent("#prospekte"), /Noch kein Prospekt eingelesen/);
    await p.setInputFiles("#prospektDatei", { name: "Prospekt.pdf", mimeType: "application/pdf", buffer: pdfMachen(prospektSeiten("PENNY")) });
    await p.waitForSelector("#prErgebnis", { timeout: 30000 }).catch(async () => { throw new Error("nicht gelesen: " + JSON.stringify(await p.evaluate(() => S.pr)).slice(0, 300)); });
    assert.match(await p.textContent("#prErgebnis"), /Prospekt\.pdf: 4 Angebote auf 1 Seite erkannt, 4 davon sicher\. 3 mit früherem Preis \(2 davon UVP\)/);
    assert.equal(await p.$eval("#prMarkt", s => s.value), "PENNY");
    assert.match(await p.textContent("#prospekte"), /Milka Schokolade 0,95\s€ \(UVP 1,99\s€\)/);
    await p.click('[data-aktion="prOk"]');
    await p.waitForFunction(() => /3 frühere Preise/.test(document.querySelector("#prospekte").textContent), null, { timeout: 10000 });
    assert.match(await p.textContent("#prospekte"), /PENNY[\s\S]*3 frühere Preise/);
    assert.equal(JSON.parse(u.store.get("prospekt:penny")).angebote.length, 4);
    // Liste: Schokolade hat kein Angebot, der Normalpreis kommt aus dem Prospekt (UVP)
    await p.evaluate(() => { aufListeSetzen("Schokolade"); aufListeSetzen("Butter"); listeSpeichern(); render(); });
    await bereich(p, "liste");
    const liste = await p.textContent("#ansicht");
    assert.match(liste, /Vorschlag aus der UVP bei PENNY \(Prospekt\)/);
    assert.match(liste, /Vorschlag aus dem früheren Preis \(„statt“\) bei PENNY/);
    // Produktseite: das PENNY-Angebot von Marktguru hat jetzt den früheren Preis
    await bereich(p, "angebote");
    await p.click('.produkt[data-p="Butter"]'); await p.waitForTimeout(300);
    assert.match(await p.textContent("#ansicht"), /statt\s*2,49/);
    // Entfernen (zweimal tippen)
    await bereich(p, "mehr");
    await p.click("[data-prweg]"); await p.click("[data-prweg]");
    await p.waitForFunction(() => /Noch kein Prospekt eingelesen/.test(document.querySelector("#prospekte").textContent), null, { timeout: 10000 });
    assert.deepEqual(fehler, []);
  });
});

t("Kassenbon mit Google: Zeilen aus den Wörtern, ohne Texterkennung auf dem Gerät; klappt Google nicht, liest das Gerät", async () => {
  const u = await umgebung({ vision: visionAntwort(["ALDI SUED", "KERRYGOLD BUTTER|1,99 A", "FREILAND-EIER M 10ST|2,29 A", "SUMME EUR|4,28"]) });
  await u.KV.put("favoriten", JSON.stringify(["Butter", "Eier"].map(name => ({ name, aus: "" }))));
  await u.A("/aktualisieren", "POST");
  const s = await browserStarten(u, {});
  try {
    await s.c.addInitScript(() => { window.Tesseract = { createWorker: async () => { window.__geraet = (window.__geraet || 0) + 1; return { recognize: async () => ({ data: { text: "ALDI SUED\nKERRYGOLD BUTTER 1,99 A" } }), terminate: async () => {} }; } }; });
    await s.oeffnen("");
    const p = s.p, png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    await p.evaluate(() => { aufListeSetzen("Butter"); aufListeSetzen("Eier"); listeSpeichern(); render(); });
    await p.click('#leiste [data-v="einkaufen"]'); await p.waitForTimeout(300);
    await p.setInputFiles("#bonFoto", { name: "bon.png", mimeType: "image/png", buffer: png });
    await p.waitForSelector(".bon-pruefen", { timeout: 10000 });
    assert.deepEqual(await p.evaluate(() => S.bon.zeilen.map(z => [z.name, z.preis, z.k])), [["KERRYGOLD BUTTER", 1.99, "Butter"], ["FREILAND-EIER M", 2.29, "Eier"]]);
    assert.match(await p.textContent(".bon-pruefen"), /gelesen mit Google/);
    assert.equal(await p.evaluate(() => window.__geraet || 0), 0, "Tesseract nicht gebraucht");
    assert.equal(u.vision.length, 1);
    // Google lehnt ab (z. B. Schlüssel falsch): das Gerät liest den Bon
    u.vision.status = 403;
    await p.evaluate(() => { S.bon = null; render(); });
    await p.setInputFiles("#bonFoto", { name: "bon.png", mimeType: "image/png", buffer: png });
    await p.waitForSelector(".bon-pruefen", { timeout: 10000 });
    assert.equal(await p.evaluate(() => [window.__geraet, S.bon.quelle].join()), "1,geraet");
    assert.deepEqual(s.fehler, []);
  } finally { await s.b.close(); }
});
