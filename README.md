# Preisvergleich

Private Web-App: Supermarkt-Angebote von Marktguru vergleichen, eine Einkaufsliste planen (welcher Markt lohnt sich, mit Fahrtkosten) und beim Einkaufen abhaken.

- **Seite:** `index.html` (eine Datei, keine Bibliotheken).
- **Server:** Cloudflare Worker in `worker/` (Marktguru-Abfragen, alle Angebote je Markt über `/maerkte` und `/markt` mit Zwischenspeicher, täglicher Lauf um 7 Uhr, Preisalarm per Web-Push und ntfy, Konten ohne E-Mail, Entfernungen über OpenStreetMap). Hochgeladen wird automatisch über `.github/workflows/worker.yml`.
- **Daten:** im Cloudflare-Speicher (KV). `sicherung.yml` kopiert Verlauf, Favoriten und Korrekturen einmal pro Woche nach `sicherung/`.
- **Geheimnisse (GitHub, Settings, Secrets):** `CLOUDFLARE_API_TOKEN`, `NTFY_TOPIC`, optional `ZUGANGSCODE`.

## Aufbau der Seite

| Bereich | Inhalt |
|---|---|
| Angebote | Eine Karte je Favorit: das günstigste Angebot (verglichen je Liter, kg oder Stück) mit dem Packungspreis groß, klein dazu Stückpreis bei Mehrfachpackungen und Preis je kg oder Liter, Markt mit Entfernung, Gültigkeit, Vergleich mit dem eigenen Durchschnitt, 📦-Hinweis bei Bestpreis seit mindestens 6 Wochen (Vorrat lohnt sich, außer bei frischer Ware), Hinweis auf günstigere Angebote demnächst. Nach Abteilungen gegliedert (abschaltbar), „neu“ bei Angeboten seit dem letzten Öffnen, „Bearbeiten“ pausiert oder entfernt Favoriten (pausierte werden nicht abgefragt). Antippen öffnet die Produktseite (alle Angebote, Filter, Preisverlauf, Preisalarm, Korrektur auffälliger Preise). **Nach Markt:** alle Angebote eines Marktes der Gegend (Lebensmittelmärkte vorne, weitere Geschäfte darunter), nach Warengruppen, mit Suche, aktuell oder demnächst, sortiert nach Warengruppe, Rabatt oder „neu“; ☆ merkt ein Angebot als Favorit, + setzt es auf die Liste. |
| Suchen | Findet eine Suche nichts, schlägt „Meintest du …?“ ähnliche Namen aus allen Angeboten der Gegend vor (`/namen`, täglich erneuert). **📷 Scannen** (auch unter Einkaufen): Strichcode per Kamera oder Nummer eingeben, das Produkt kommt aus Open Food Facts (bzw. Open Beauty Facts), Marke und Artikel lassen sich anpassen, gespeichert wird es als Favorit. Ein Artikel oder eine ganze Liste (z. B. aus Erinnerungen, auch per Link `#import=`). Pro Artikel Kacheln: alle Marken, einzelne Produkte (Marke und Produktname, z. B. „Nivea Pflegedusche“ und „Nivea Creme“ getrennt) als Favorit, Sorten über alle Marken (z. B. „Rinder-Hackfleisch“ von ALDI, Lidl und PENNY), ohne Angebot; auf jeder Kachel die Märkte mit Preis. Der Name einer Kachel öffnet alle Angebote nach Markt (günstigster zuerst, mit Link zu Marktguru); „Hier kaufen“ setzt den Artikel mit diesem Markt auf die Liste. |
| Liste | Der Name eines Artikels führt zu seiner Produktseite. Menge in Stück (übliche Packungsgröße), Normalpreis für Artikel ohne Angebot (ohne eigenen Eintrag ein Vorschlag aus dem früheren Preis „statt …“, falls Marktguru einen liefert, sonst leer), beste Wahl mit Ware und Fahrt (auch zwei Märkte als Tour), je Artikel wahlweise ein selbst gewählter Markt (📌), alle Märkte im Vergleich, zu jedem Artikel das gewählte Angebot, Weitergeben als Text oder Kurzbefehl. |
| Einkaufen | Liste zum Abhaken, nach Markt gegliedert, eigene Artikel, Abgehakte entfernen. Funktioniert auch ohne Netz: die Seite kommt aus dem Speicher (`sw.js`), Haken werden nachgereicht. Abgehakte Artikel zählen für die Ersparnis (unter „Mehr“: je Monat bezahlt und gegenüber dem Normalpreis gespart). |
| Alarm | Mitteilungen auf diesem Gerät einschalten (Web-Push; auf dem iPhone in der App vom Home-Bildschirm, ab iOS 16.4), Test senden, Wochenüberblick montags (gute Angebote der Favoriten), ntfy zusätzlich an oder aus. Preisalarm je Favorit ein- und ausschalten: bei jedem Angebot oder unter einem Wunschpreis (je Liter, kg, Stück oder Flasche, wahlweise nur eine Größe). Mit einem Knopf für alle Artikel der Einkaufsliste. Nur mit Zugangscode. |
| Mehr | Standort und Fahrtkosten, Märkte ausblenden, App-Preise, Darstellung, Konto, Betreiber (Zugangscode, Preise neu holen, Passwort-Anfragen). |

**Mit Zugangscode** (Betreiber) liegen die Favoriten auf dem Server, werden täglich abgefragt und haben Preisverlauf und Preisalarm. **Ohne Zugangscode** hat jede Person eigene Favoriten im Browser (mit Konto auf allen Geräten), die Angebote kommen dann über die öffentliche Abfrage `/region` für die eigene Postleitzahl.

## Auf dem iPhone

In Safari die Seite öffnen, Teilen, „Zum Home-Bildschirm“. Die App startet dann ohne Safari-Leiste, zeigt ohne Netz den letzten Stand und kann Mitteilungen empfangen (unter „Alarm“ einschalten). Die Schlüssel für Web-Push (VAPID) erzeugt der Worker beim ersten Mal selbst und legt sie im KV ab.

## Tests

`node --test tests/erkennung.test.mjs tests/alarm.test.mjs tests/zuordnung.test.mjs tests/push.test.mjs` und mit installiertem Playwright `node --test tests/browser/seite.test.mjs` (die echte Seite im Browser gegen den echten Worker-Code, Marktguru nachgebaut). Alles läuft bei jedem Push (Workflow „Tests“); bei Fehlern schreibt die Pipeline die Ausgabe nach `tests/ergebnis/browser.txt`.

## Grenzen

Normalpreise liefert Marktguru nicht (nur selten einen alten Preis, dann steht „statt …“ da), deshalb gibt es eigene Normalpreise. Die Zuordnung von Angeboten zu einem Artikel arbeitet mit dem Namen und ist nicht perfekt. Verpackung und Menge werden aus dem Prospekttext abgeleitet.
