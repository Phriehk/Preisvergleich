#!/usr/bin/env python3
"""Temporäre Diagnose: Mengenerkennung im Text gegen die strukturierten Mengenangaben von Marktguru prüfen."""
import json
import sys
import traceback

sys.path.insert(0, ".")
import test_marktguru as t

QUERIES = ["Coca-Cola", "Cola", "Red Bull", "Monster Energy", "Wasser", "Mineralwasser", "Fanta", "Sprite", "Pepsi", "Apfelschorle",
           "Limonade", "Eistee", "Energy Drink", "Saft", "Spezi", "Mezzo Mix", "Gerolsteiner", "Volvic", "Granini", "Capri-Sun",
           "Bier", "Radler", "Ginger Ale", "Tonic", "Schorle", "Getränke"]
PLZS = ["47178", "46535", "47053"]
out = {"offers": [], "fehler": ""}
gesehen = set()
try:
    api, client = t.hole_schluessel()
    for plz in PLZS:
        for q in QUERIES:
            try:
                for o in t.hole_treffer(plz, [q], api, client):
                    if o.get("id") in gesehen:
                        continue
                    gesehen.add(o.get("id"))
                    name = (o.get("product") or {}).get("name", "")
                    beschr = o.get("description", "")
                    m = t.menge(beschr) or t.menge(name)
                    out["offers"].append({
                        "id": o.get("id"), "adv": ((o.get("advertisers") or [{}])[0]).get("name"), "name": name,
                        "brand": (o.get("brand") or {}).get("name"), "desc": beschr, "price": o.get("price"),
                        "volume": o.get("volume"), "quantity": o.get("quantity"), "multi": o.get("isMultiProduct"),
                        "unit": (o.get("unit") or {}).get("shortName"), "ref": o.get("referencePrice"),
                        "text": list(m) if m else None})
            except Exception as e:  # noqa: BLE001
                out["fehler"] += f"{plz}/{q}: {str(e)[:100]}\n"
except Exception:  # noqa: BLE001
    out["fehler"] += traceback.format_exc()[-600:]
with open("diagnose.json", "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False)
print(len(out["offers"]), "Angebote")
