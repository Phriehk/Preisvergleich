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
    basis = {"as": "web", "limit": 100, "offset": 0}
    plzs = ["47178", "47179", "47167", "47169", "47166", "47137", "47138", "47139", "47119", "47051", "47053", "47055", "47057", "47058", "47059",
            "47198", "47199", "47226", "47228", "47229", "47249", "47259", "47269", "47279", "47441", "46535", "46537", "46539", "46483",
            "46145", "46147", "46149", "46045", "46047", "46049", "46117", "46119", "45468", "45470", "45472", "45473", "45475", "45476", "45478", "45479"]
    for plz in plzs:
        try:
            url = t.SEARCH + "?" + urllib.parse.urlencode({**basis, "q": "Cola", "zipCode": plz})
            res = json.loads(t.http(url, h, versuche=2)).get("results", [])
            rewe = [o for o in res if "rewe" in (((o.get("advertisers") or [{}])[0]).get("name") or "").lower()]
            out["plz"][plz] = {"anzahl": len(res), "rewe_anzahl": len(rewe),
                               "ziel_dabei": any(o.get("id") == 25362087 for o in res),
                               "rewe_coca": [dict(kurz(o), adv=((o.get("advertisers") or [{}])[0]).get("name")) for o in rewe
                                             if "coca" in json.dumps(o, ensure_ascii=False).lower()]}
        except Exception as e:  # noqa: BLE001
            out["plz"][plz] = {"fehler": str(e)[:200]}
        import time; time.sleep(0.7)
except Exception:  # noqa: BLE001
    out["fehler"] = traceback.format_exc()[-800:]

with open("diagnose.json", "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=1)
print("diagnose.json geschrieben")
