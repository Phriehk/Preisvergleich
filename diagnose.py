#!/usr/bin/env python3
"""Temporäre Diagnose 2: wie fragt die Marktguru-Webseite REWE-Angebote ab? Schreibt diagnose.json."""
import json
import re
import sys
import traceback
import urllib.parse

sys.path.insert(0, ".")
import test_marktguru as t

out = {"seiten": {}, "varianten": {}, "plz": {}}


def kurz(o):
    v = (o.get("validityDates") or [{}])[0]
    return {"id": o.get("id"),
            "adv": ((o.get("advertisers") or [{}])[0]).get("name"),
            "produkt": (o.get("product") or {}).get("name"),
            "marke": (o.get("brand") or {}).get("name"),
            "preis": o.get("price"), "bis": v.get("to")}


def suche(params, h):
    url = t.SEARCH + "?" + urllib.parse.urlencode(params)
    try:
        res = json.loads(t.http(url, h, versuche=2)).get("results", [])
        return {"anzahl": len(res), "rewe": [kurz(o) for o in res if "rewe" in ((o.get("advertisers") or [{}])[0].get("name") or "").lower()],
                "haendler": sorted({((o.get("advertisers") or [{}])[0]).get("name") for o in res})}
    except Exception as e:  # noqa: BLE001
        return {"fehler": str(e)[:200]}


try:
    api, client = t.hole_schluessel()
    h = {"x-apikey": api, "x-clientkey": client}

    # 1) Welche API-Aufrufe stecken in den Seiten der Webseite?
    for pfad in ("/search/cola", "/offers/25362087", "/b/coca-cola", "/rp/rewe-prospekte", "/"):
        try:
            html = t.http("https://www.marktguru.de" + pfad)
            html = html.replace("&q;", '"').replace("&a;", "&").replace("&s;", "'").replace("&l;", "<").replace("&g;", ">")
            urls = sorted(set(re.findall(r"https?://api\.marktguru\.de/[^\"'\s<>\\]+", html)))
            skripte = sorted(set(re.findall(r'src="([^"]+\.js)"', html)))
            out["seiten"][pfad] = {"laenge": len(html), "api_urls": urls[:40], "skripte": skripte[:15]}
        except Exception as e:  # noqa: BLE001
            out["seiten"][pfad] = {"fehler": str(e)[:200]}

    # 2) Mögliche Filter-Parameter für die Suche
    basis = {"as": "web", "limit": 100, "offset": 0, "zipCode": "47178"}
    for name, extra in (
        ("q=cola", {"q": "cola"}),
        ("q=cola, as=mobile", {"q": "cola", "as": "mobile"}),
        ("q=cola, advertisers=rewe", {"q": "cola", "advertisers": "rewe"}),
        ("q=cola, advertisers=retailers/126802", {"q": "cola", "advertisers": "retailers/126802"}),
        ("q=cola, retailers=rewe", {"q": "cola", "retailers": "rewe"}),
        ("q=cola, advertiser=rewe", {"q": "cola", "advertiser": "rewe"}),
        ("q=cola, advertiserIds=retailers/126802", {"q": "cola", "advertiserIds": "retailers/126802"}),
        ("q=coca-cola, brands=coca-cola", {"q": "coca-cola", "brands": "coca-cola"}),
        ("q=rewe", {"q": "rewe"}),
        ("q=rewe cola", {"q": "rewe cola"}),
        ("q=getränke rewe", {"q": "getränke rewe"}),
        ("ohne q, brands=coca-cola", {"brands": "coca-cola"}),
        ("ohne q, brand=coca-cola", {"brand": "coca-cola"}),
        ("ohne q, advertisers=rewe", {"advertisers": "rewe"}),
    ):
        out["varianten"][name] = suche({**basis, **extra}, h)

    # 3) Taucht REWE bei irgendeiner Postleitzahl in der Suche auf?
    for plz in ("47051", "47119", "47139", "47166", "47169", "47226", "47441", "47506", "46045", "45127", "40210", "50667", "10115", "80331"):
        out["plz"][plz] = suche({**basis, "q": "cola", "zipCode": plz}, h)
except Exception:  # noqa: BLE001
    out["fehler"] = traceback.format_exc()[-800:]

with open("diagnose.json", "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=1)
print("diagnose.json geschrieben")
