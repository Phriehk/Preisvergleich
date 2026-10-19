# Preisvergleich

Privater Getränke-Preisvergleich mit Angeboten von Marktguru.

- **Seite und Server:** laufen bei Cloudflare (Ordner `worker/`, Seite in `index.html`). Hochgeladen wird automatisch über `.github/workflows/worker.yml`, sobald sich etwas ändert.
- **Daten:** liegen im Cloudflare-Speicher (KV). Der Workflow `sicherung.yml` kopiert sie einmal pro Woche nach `sicherung/`.
- **Tests:** `node --test tests/` prüft die Mengen- und Verpackungserkennung.
- **Geheimnisse (GitHub, Settings, Secrets):** `CLOUDFLARE_API_TOKEN`, `NTFY_TOPIC`, optional `ZUGANGSCODE`.
