# Preisvergleich

Private Web-App: Supermarkt-Angebote von Marktguru vergleichen, eine Einkaufsliste planen (welcher Markt lohnt sich, mit Fahrtkosten) und beim Einkaufen abhaken.

- **Seite:** `index.html` (eine Datei, keine Bibliotheken). Die bisherige Version liegt als Sicherung in `alt.html` und ist unter `/alt.html` erreichbar. Beide nutzen dieselben Daten im Browser und auf dem Server.
- **Server:** Cloudflare Worker in `worker/` (Marktguru-Abfragen, täglicher Lauf um 7 Uhr, Preisalarm per ntfy, Konten ohne E-Mail, Entfernungen über OpenStreetMap). Hochgeladen wird automatisch über `.github/workflows/worker.yml`.
- **Daten:** im Cloudflare-Speicher (KV). `sicherung.yml` kopiert Verlauf, Favoriten und Korrekturen einmal pro Woche nach `sicherung/`.
- **Geheimnisse (GitHub, Settings, Secrets):** `CLOUDFLARE_API_TOKEN`, `NTFY_TOPIC`, optional `ZUGANGSCODE`.

## Aufbau der Seite

| Bereich | Inhalt |
|---|---|
| Angebote | Eine Karte je Favorit: bester Preis je Liter, kg oder Stück, Markt mit Entfernung, Gültigkeit, Vergleich mit dem eigenen Durchschnitt, Hinweis auf günstigere Angebote demnächst. Antippen öffnet die Produktseite (alle Angebote, Filter, Preisverlauf, Preisalarm, Korrektur auffälliger Preise). |
| Suchen | Ein Artikel oder eine ganze Liste (z. B. aus Erinnerungen, auch per Link `#import=`). Pro Artikel Kacheln: alle Marken, einzelne Produkte als Favorit, ohne Angebot. |
| Liste | Menge in Stück (übliche Packungsgröße), Normalpreis für Artikel ohne Angebot, beste Wahl mit Ware und Fahrt (auch zwei Märkte als Tour), alle Märkte im Vergleich, Weitergeben als Text oder Kurzbefehl, Meldung bei Angeboten. |
| Einkaufen | Liste zum Abhaken, nach Markt gegliedert, eigene Artikel, Abgehakte entfernen. |
| Mehr | Standort und Fahrtkosten, Märkte ausblenden, App-Preise, Darstellung, Konto, Betreiber (Zugangscode, Preise neu holen, Passwort-Anfragen). |

**Mit Zugangscode** (Betreiber) liegen die Favoriten auf dem Server, werden täglich abgefragt und haben Preisverlauf und Preisalarm. **Ohne Zugangscode** hat jede Person eigene Favoriten im Browser (mit Konto auf allen Geräten), die Angebote kommen dann über die öffentliche Abfrage `/region` für die eigene Postleitzahl.

## Tests

`node --test tests/erkennung.test.mjs tests/alarm.test.mjs` und mit installiertem Playwright `node --test tests/browser/seite.test.mjs` (die echte Seite im Browser gegen den echten Worker-Code, Marktguru nachgebaut). Alles läuft bei jedem Push (Workflow „Tests“); bei Fehlern schreibt die Pipeline die Ausgabe nach `tests/ergebnis/browser.txt`.

## Grenzen

Normalpreise liefert Marktguru nicht (nur selten einen alten Preis, dann steht „statt …“ da), deshalb gibt es eigene Normalpreise. Die Zuordnung von Angeboten zu einem Artikel arbeitet mit dem Namen und ist nicht perfekt. Verpackung und Menge werden aus dem Prospekttext abgeleitet.
