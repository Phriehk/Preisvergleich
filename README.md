# Preisvergleich

Privater Getränke-Preisvergleich mit Angeboten von Marktguru.

- **Seite und Server:** laufen bei Cloudflare (Ordner `worker/`, Seite in `index.html`). Hochgeladen wird automatisch über `.github/workflows/worker.yml`, sobald sich etwas ändert.
- **Daten:** liegen im Cloudflare-Speicher (KV). Der Workflow `sicherung.yml` kopiert sie einmal pro Woche nach `sicherung/`.
- **Tests:** `node --test tests/` prüft die Mengen- und Verpackungserkennung.
- **Geheimnisse (GitHub, Settings, Secrets):** `CLOUDFLARE_API_TOKEN`, `NTFY_TOPIC`, optional `ZUGANGSCODE`.

## Lebensmittel und Einkaufsliste

Neben Getränken (Preis pro Liter) kann die Seite Lebensmittel vergleichen (Preis pro kg oder pro Stück). Die Einheit erkennt der Server aus den Angaben von Marktguru (Liter, Gramm, Kilogramm, Stück). Auf der Seite „Favoriten“ fügt man mit „Artikel hinzufügen“ beliebige Artikel hinzu. Auf der Einkaufsliste gibt man die Menge an und optional einen **Richtwert** (was der Artikel normalerweise kostet). Der Vergleich rechnet Artikel ohne Angebot mit dem Richtwert (als „ca.“ gekennzeichnet, in jedem Markt gleich) und zeigt, in welchem Markt die meisten Artikel im Angebot sind, samt Fahrt.

Grenzen: Normalpreise gibt es nicht automatisch (Marktguru liefert nur Angebote). Die Zuordnung von Angeboten zu einem Artikel arbeitet mit dem Namen (zusammengesetzte Wörter am Ende zählen, „Butter-Mandel-Stollen“ nicht) und ist nicht perfekt. Bei Lebensmitteln stehen im Deploy-Log unter „Lebensmittel-Probe“ echte Beispiele zur Kontrolle.

## Einkaufsliste importieren (z. B. aus Erinnerungen)

Eigener Tab „Import“: Zeilen einfügen (oder „Aus Zwischenablage einfügen“) (eine pro Artikel, Mengen wie „2 kg Äpfel“ oder „6 Eier“ werden erkannt) und „Angebote suchen“.
Pro Artikel gibt es Kacheln: vorhandene Favoriten, „Alle Marken“ (günstigstes aller Marken) auf die Liste legen, ein Produkt als Favorit speichern („☆ Favorit“) oder direkt mit auf die Liste („＋ Liste“), oder ohne Angebot mit Richtwert.
Per Link (z. B. aus einem iPhone-Kurzbefehl): `https://preise.phriehk.workers.dev/#import=<URL-codierte Zeilen>`. Der Text bleibt im Browser und geht nicht an den Server (nur die Suchbegriffe).
`/suche` (POST) nimmt bis zu 8 Suchbegriffe, getrennt mit `|`.
