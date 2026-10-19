#!/usr/bin/env python3
"""Temporäre Diagnose: schreibt in diagnose.json, was Marktguru für verschiedene Suchen liefert."""
import json
import sys
import traceback
import urllib.parse

sys.path.insert(0, ".")
import test_marktguru as t

OFFER_ID = "25362087"
out = {"offer": {}, "queries": {}}


def kurz(o):
    v = (o.get("validityDates") or [{}])[0]
    return {"id": o.get("id"),
            "adv": ((o.get("advertisers") or [{}])[0]).get("name"),
            "produkt": (o.get("product") or {}).get("name"),
            "marke": (o.get("brand") or {}).get("name"),
            "beschr": o.get("description"),
            "preis": o.get("price"),
            "von": v.get("from"), "bis": v.get("to")}


try:
    api, client = t.hole_schluessel()
    h = {"x-apikey": api, "x-clientkey": client}
    basis = t.SEARCH.rsplit("/", 1)[0]
    for name, url in (("mit_plz", f"{basis}/{OFFER_ID}?as=web&zipCode=47178"), ("ohne_plz", f"{basis}/{OFFER_ID}")):
        try:
            roh = json.loads(t.http(url, h))
            out["offer"][name] = {"kurz": kurz(roh), "roh": roh}
        except Exception as e:  # noqa: BLE001
            out["offer"][name] = {"fehler": str(e)[:300]}
    for plz in ("47178", "46535"):
        for q in ("coca cola", "Coca-Cola", "Cola", "REWE Cola", "Coca-Cola REWE"):
            try:
                res = t.hole_treffer(plz, [q], api, client)
                liste = [kurz(o) for o in res]
                zaehler = {}
                for k in liste:
                    zaehler[k["adv"]] = zaehler.get(k["adv"], 0) + 1
                out["queries"][f"{plz} | {q}"] = {"anzahl": len(liste), "haendler": zaehler,
                                                  "gesuchte_id_dabei": any(str(k["id"]) == OFFER_ID for k in liste),
                                                  "rewe": [k for k in liste if "rewe" in (k["adv"] or "").lower()],
                                                  "alle": liste}
            except Exception as e:  # noqa: BLE001
                out["queries"][f"{plz} | {q}"] = {"fehler": str(e)[:300]}
except Exception:  # noqa: BLE001
    out["fehler"] = traceback.format_exc()[-800:]

with open("diagnose.json", "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=1)
print("diagnose.json geschrieben")
