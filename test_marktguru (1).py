#!/usr/bin/env python3
"""Holt aktuelle Coca-Cola-Angebote von Marktguru (inoffiziell) und rechnet auf Preis pro Liter um.

Aufruf:  python test_marktguru.py                  (Standard: Coca-Cola, PLZ 47178)
         python test_marktguru.py --plz 47178 --suche "Coca-Cola"
         python test_marktguru.py --debug          (zeigt zusätzlich die Rohdaten des ersten Treffers)

Nur Standardbibliothek. Bitte nur gelegentlich und für den privaten Gebrauch abfragen.
Schreibt das Ergebnis zusätzlich in angebote.json (für die spätere App).
"""
import argparse
import csv
import json
import os
import sys
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime

UA = {"User-Agent": "Mozilla/5.0 (privates Testprojekt)"}
HOME = "https://www.marktguru.de"
SEARCH = "https://api.marktguru.de/api/v1/offers/search"


def http(url, headers=None, versuche=4):
    for i in range(versuche):
        try:
            req = urllib.request.Request(url, headers={**UA, **(headers or {})})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and i < versuche - 1:
                warte = 5 * (i + 1)
                print(f"  Server meldet {e.code}, neuer Versuch in {warte} s ...")
                time.sleep(warte)
            else:
                raise


def hole_schluessel():
    """Die Webseite enthält die Schlüssel, die auch ihr eigener Browser-Code benutzt."""
    html = http(HOME)
    api = re.search(r'"apiKey"\s*:\s*"([^"]+)"', html)
    client = re.search(r'"clientKey"\s*:\s*"([^"]+)"', html)
    if not (api and client):
        raise SystemExit("Schlüssel auf marktguru.de nicht gefunden - die Seite hat sich vermutlich geändert.")
    return api.group(1), client.group(1)


def liter(text):
    """Liest Mengen wie '6 x 1,5 l', '1,5-l-Fl.' oder '24 x 330 ml' aus einem Text."""
    t = (text or "").lower().replace(",", ".")
    t = re.sub(r"(\d)\s*i\b", r"\1 l", t)  # Tippfehler: "1,25 I" statt "1,25 l"
    m = re.search(r"(\d+)\s*[x×]\s*(\d+(?:\.\d+)?)\s*-?\s*(ml|l)\b", t)
    if m:
        n, v, u = int(m[1]), float(m[2]), m[3]
    else:
        m = re.search(r"(\d+(?:\.\d+)?)\s*-?\s*(ml|l)\b", t)
        if not m:
            return None
        n, v, u = 1, float(m[1]), m[2]
    return n * v / (1000 if u == "ml" else 1)


def lokal(s):
    """ISO-Zeit (UTC) in lokales Datum umrechnen, z.B. 2026-10-17T21:59:59Z -> 2026-10-17."""
    if not s:
        return ""
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone().strftime("%Y-%m-%d")
    except ValueError:
        return s[:10]


def status(von, bis):
    heute = date.today()
    if von:
        d = (datetime.strptime(von, "%Y-%m-%d").date() - heute).days
        if d > 0:
            return f"NOCH NICHT GÜLTIG: gültig in {d} Tagen (ab {von})"
    if bis:
        t = (datetime.strptime(bis, "%Y-%m-%d").date() - heute).days
        return f"gültig bis {bis} (noch {t} Tage)" if t >= 0 else "abgelaufen"
    return "Gültigkeit unbekannt"


def angebots_link(o):
    """Link zur Quellseite (Format nicht offiziell dokumentiert - bitte einmal ausprobieren)."""
    for k in ("url", "link", "shareUrl", "webUrl"):
        if isinstance(o.get(k), str) and o[k].startswith("http"):
            return o[k]
    return f"https://www.marktguru.de/offers/{o['id']}" if o.get("id") else ""


def gueltigkeit(o):
    v = (o.get("validityDates") or [{}])[0]
    von, bis = lokal(v.get("from")), lokal(v.get("to"))
    rest = None
    if bis:
        rest = (datetime.strptime(bis, "%Y-%m-%d").date() - date.today()).days
    return von, bis, rest


KW = {"Coca-Cola": ("coca",), "Red Bull": ("red bull", "redbull"), "Monster Energy": ("monster",)}
AUSSCHLUSS = ("munch", "mash")  # z.B. Monster Munch (Snack) ist kein Energydrink


def ist_produkt(gruppe, text, extra=()):
    """Bekannte Marken über KW, freie Suchen über das erste Suchwort; extra = zusätzlich auszuschließende Wörter."""
    t = text.lower()
    schluessel = KW.get(gruppe) or (gruppe.lower().split() or [""])[:1]
    return any(k in t for k in schluessel) and not any(x in t for x in AUSSCHLUSS + tuple(extra))


def hole_treffer(plz, suchen, api, client):
    """Fragt Marktguru für eine Postleitzahl ab (mehrere Suchbegriffe, je 2 Seiten)."""
    treffer, ids = [], set()
    for suche in suchen:
        for offset in (0, 100):
            url = SEARCH + "?" + urllib.parse.urlencode(
                {"as": "web", "limit": 100, "offset": offset, "q": suche, "zipCode": plz})
            seite = json.loads(http(url, {"x-apikey": api, "x-clientkey": client})).get("results", [])
            for o in seite:
                k = o.get("id") or id(o)
                if k not in ids:
                    ids.add(k)
                    treffer.append(o)
            time.sleep(1)
            if len(seite) < 100:
                break
    return treffer


def aktiv(x):
    s = status(x["gueltig_von"], x["gueltig_bis"])
    return not (s.startswith("NOCH NICHT") or s == "abgelaufen")


def verlauf(ausgabe, alarm):
    """Vergleicht je Produkt mit früheren Läufen, löst ggf. einen Alarm aus (nur Coca-Cola) und hängt an verlauf.csv an."""
    alt = []
    if os.path.exists("verlauf.csv"):
        with open("verlauf.csv", encoding="utf-8") as f:
            for z in csv.reader(f, delimiter=";"):
                try:
                    alt.append((float(z[5]), z[0], z[1], z[8] if len(z) > 8 and z[8] else "Coca-Cola"))
                except (ValueError, IndexError):
                    pass  # Kopfzeile oder unvollständige Zeile
    for g in sorted({x["gruppe"] for x in ausgabe}):
        jetzt = [x for x in ausgabe if x["gruppe"] == g and x["preis_pro_liter"] and aktiv(x)]
        if not jetzt:
            continue
        b = min(jetzt, key=lambda x: x["preis_pro_liter"])
        print(f"\nBester gültiger Preis {g}: {b['preis_pro_liter']:.2f} €/l bei {b['markt']}")
        hist = [h for h in alt if h[3] == g]
        if hist:
            bw = min(hist)
            print(f"Bisher bester gespeicherter Preis: {bw[0]:.2f} €/l ({bw[2]}, {bw[1]})")
            if b["preis_pro_liter"] < bw[0]:
                print("-> Das ist ein neuer Bestwert!")
        if alarm and g == "Coca-Cola" and b["preis_pro_liter"] <= alarm:
            text = f"Coca-Cola für {b['preis_pro_liter']:.2f} €/l bei {b['markt']} (gültig bis {b['gueltig_bis']})"
            print("ALARM:", text)
            if sys.platform == "win32" and not os.environ.get("PV_SERVER"):  # im Server-Betrieb kein Fenster
                import ctypes
                ctypes.windll.user32.MessageBoxW(0, text, "Cola-Angebot", 0x40)
    neu = not os.path.exists("verlauf.csv")
    with open("verlauf.csv", "a", newline="", encoding="utf-8") as f:
        w = csv.writer(f, delimiter=";")
        if neu:
            w.writerow(["datum", "markt", "produkt", "liter", "preis", "preis_pro_liter",
                        "gueltig_bis", "gueltig_von", "gruppe"])
        for x in ausgabe:
            w.writerow([date.today().isoformat(), x["markt"], x["produkt"], x["liter"], x["preis"],
                        x["preis_pro_liter"], x["gueltig_bis"], x["gueltig_von"], x["gruppe"]])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--plz", default="47178")
    ap.add_argument("--suche", default="Coca-Cola")
    ap.add_argument("--debug", action="store_true")
    ap.add_argument("--alle", action="store_true", help="auch Angebote ohne Coca-Cola-Marke zeigen")
    ap.add_argument("--alarm", type=float, help="Meldung, wenn der beste gültige Coca-Cola-Literpreis darunter liegt, z.B. 0.80")
    ap.add_argument("--plz2", default="46535", help="zweite Postleitzahl nur für bestimmte Märkte")
    ap.add_argument("--plz2-maerkte", default="Penny,Thomas Philipps", help="Märkte, die zusätzlich in --plz2 gesucht werden")
    ap.add_argument("--produkte", default="", help="zusätzliche Produkte, durch Komma getrennt (die Favoriten aus favoriten.json werden immer mit abgefragt)")
    ap.add_argument("--ausschliessen", default="", help="Wörter, die ein Angebot ausschließen, durch Komma getrennt")
    ap.add_argument("--out", default="angebote.json", help="Ausgabedatei")
    ap.add_argument("--kein-verlauf", action="store_true", help="verlauf.csv nicht ändern (für freie Suchen)")
    ap.add_argument("--ohne-favoriten", action="store_true", help="gespeicherte Favoriten (favoriten.json) nicht mit abfragen")
    a = ap.parse_args()
    extra_aus = tuple(w.strip().lower() for w in a.ausschliessen.split(",") if w.strip())
    os.chdir(os.path.dirname(os.path.abspath(__file__)))  # Dateien immer neben dem Skript speichern
    favs, fav_aus = [], {}
    if not a.ohne_favoriten and not os.path.exists("favoriten.json"):
        with open("favoriten.json", "w", encoding="utf-8") as f:  # Startfavoriten beim ersten Lauf
            json.dump([{"name": n, "aus": ""} for n in ("Coca-Cola", "Red Bull", "Monster Energy")], f, ensure_ascii=False, indent=2)
    if not a.ohne_favoriten and os.path.exists("favoriten.json"):
        try:
            with open("favoriten.json", encoding="utf-8") as f:
                for fv in json.load(f):
                    favs.append(fv["name"])
                    fav_aus[fv["name"]] = tuple(w.strip().lower() for w in fv.get("aus", "").split(",") if w.strip())
        except (OSError, ValueError, KeyError, AttributeError):
            print("Hinweis: favoriten.json konnte nicht gelesen werden und wird ignoriert.")

    api, client = hole_schluessel()
    SUCHEN = {"Coca-Cola": [a.suche, "Coca Cola", "Cola"], "Red Bull": ["Red Bull"],
              "Monster Energy": ["Monster Energy", "Monster"]}
    zweit = [t.strip().lower() for t in a.plz2_maerkte.split(",") if t.strip()]
    treffer = []
    produkte = [p.strip() for p in a.produkte.split(",") if p.strip()]
    produkte += [fv for fv in favs if fv not in produkte]
    for produkt in produkte:
        suchen = SUCHEN.get(produkt, [produkt])
        gefunden_p = hole_treffer(a.plz, suchen, api, client)
        if a.plz2 and zweit:  # Penny/Thomas Philipps zusätzlich in der zweiten Postleitzahl
            for o in hole_treffer(a.plz2, suchen, api, client):
                name = ((o.get("advertisers") or [{}])[0].get("name") or "").lower()
                if any(z in name for z in zweit):
                    o["_plz"] = a.plz2
                    gefunden_p.append(o)
        for o in gefunden_p:
            o["_gruppe"] = produkt
        treffer.extend(gefunden_p)
        print(f"{produkt}: {len(gefunden_p)} Angebote abgefragt.")
    print(f"{len(treffer)} Angebote insgesamt abgefragt.\n")

    ausgabe = []
    for o in treffer:
        markt = ((o.get("advertisers") or [{}])[0]).get("name", "?")
        if o.get("_plz"):
            markt += f" ({o['_plz']})"
        name = (o.get("product") or {}).get("name", "?")
        beschr = o.get("description", "")
        preis = o.get("price")
        l = liter(beschr) or liter(name)
        von, bis, rest = gueltigkeit(o)
        pro_l = round(preis / l, 2) if preis and l else None
        marke = (o.get("brand") or {}).get("name", "")
        gruppe = o.get("_gruppe", "Coca-Cola")
        coke = ist_produkt(gruppe, f"{marke} {name} {beschr}", fav_aus.get(gruppe, extra_aus))
        ausgabe.append({"abgefragt": datetime.now().isoformat(timespec="minutes"), "gruppe": gruppe, "marke": marke, "coke": coke, "link": angebots_link(o), "markt": markt, "produkt": name, "beschreibung": beschr, "preis": preis,
                        "liter": l, "preis_pro_liter": pro_l, "gueltig_von": von, "gueltig_bis": bis})

    roh_maerkte = {x["markt"].lower() for x in ausgabe}
    # Nur Coca-Cola (Marke steht im Feld "brand" oder im Text)
    if not a.alle:
        coke = [x for x in ausgabe if x["coke"]]
        if coke:
            print(f"{len(ausgabe) - len(coke)} Angebote ohne passende Marke aussortiert (mit --alle siehst du sie).")
            ausgabe = coke
        else:
            print("ACHTUNG: Bei keinem Angebot ist die gesuchte Marke erkennbar - es werden alle gezeigt. Mit --debug siehst du, wo die Marke steht.")

    # Doppelte (gleicher Markt, Preis, Menge, Gültigkeit) und Angebote nur für Großhändler entfernen
    gesehen, sauber = set(), []
    for x in ausgabe:
        if "grosshändler" in x["beschreibung"].lower().replace("ß", "ss"):
            continue
        schluessel = (x["gruppe"], x["markt"], x["preis"], x["liter"], x["gueltig_bis"])
        if schluessel in gesehen:
            continue
        gesehen.add(schluessel)
        sauber.append(x)
    print(f"{len(ausgabe) - len(sauber)} doppelte bzw. reine Großhandels-Angebote entfernt.\n")
    ausgabe = sauber

    gefunden = {x["markt"].lower() for x in ausgabe}
    print("Märkte mit Coca-Cola-Angeboten:", ", ".join(sorted({x["markt"] for x in ausgabe})) or "keine")
    for wunsch in ("Penny", "REWE", "Thomas Philipps"):
        if any(wunsch.lower() in m for m in gefunden):
            continue
        if any(wunsch.lower() in m for m in roh_maerkte):
            print(f"Hinweis: {wunsch} hat Angebote, aber keines mit erkennbarer Coca-Cola-Marke (mit --alle ansehen).")
        else:
            print(f"Hinweis: {wunsch} hat bei Marktguru für {a.plz} aktuell kein Coca-Cola-Angebot.")
    print()

    # günstigste zuerst, Angebote ohne berechenbaren Literpreis ans Ende
    ausgabe.sort(key=lambda x: (x["gruppe"], x["preis_pro_liter"] is None, x["preis_pro_liter"] or 0))
    for x in ausgabe:
        pl = f"{x['preis_pro_liter']:.2f} €/l" if x["preis_pro_liter"] else "Literpreis unklar"
        rest = " | " + status(x["gueltig_von"], x["gueltig_bis"])
        if x["link"]:
            rest += f" | {x['link']}"
        print(f"[{x['gruppe']}] {x['markt']}: {x['produkt']} | {x['beschreibung']} | {x['preis']} € | {pl}{rest}")

    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(ausgabe, f, ensure_ascii=False, indent=2)
    print(f"\nGespeichert in {a.out}")
    if not a.kein_verlauf:
        verlauf(ausgabe, a.alarm)
    if a.debug and treffer:
        print("\nRohdaten des ersten Treffers:\n", json.dumps(treffer[0], indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
