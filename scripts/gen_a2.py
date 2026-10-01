#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Generate data/a2.json — 800–1000 A2 lemmas excluding a1."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PARTS = Path(__file__).resolve().parent / "a2_parts"
POS_OK = {"noun", "verb", "adj", "adv", "prep", "conj", "phrase", "other"}
POS_MAP = {"number": "other", "num": "other"}

CONCEPT = {
    "person": "person", "family": "person", "body": "person", "job": "person",
    "food": "nature", "drink": "nature", "animal": "nature", "nature": "nature",
    "place": "place", "home": "place", "travel": "place", "city": "place",
    "time": "time", "number": "number", "color": "object",
    "action": "action", "verb": "action", "sport": "action",
    "emotion": "emotion", "adj": "emotion",
    "speech": "speech", "school": "idea", "idea": "idea",
    "object": "object", "clothes": "object", "tech": "object", "money": "object",
    "weather": "nature", "work": "job",
}


def svg(kind: str) -> str:
    return "/icons/concepts/%s.svg" % CONCEPT.get(kind, "object")


def normalize_pos(pos: str) -> str:
    pos = (pos or "other").lower().strip()
    pos = POS_MAP.get(pos, pos)
    return pos if pos in POS_OK else "other"


def load_a1_exclude():
    a1 = json.loads((ROOT / "data" / "a1.json").read_text(encoding="utf-8"))
    keys = set()
    for c in a1:
        keys.add(c.get("lemma", "").lower())
        keys.add(c.get("word", "").lower())
    keys.discard("")
    return keys


def load_rows():
    rows = []
    for name in ("extra.json", "from_script.json", "adjs.json"):
        path = PARTS / name
        if path.exists():
            rows.extend(json.loads(path.read_text(encoding="utf-8")))
    return rows


def build_cards(target=900):
    exclude = load_a1_exclude()
    rows = load_rows()
    # bucket by pos after filtering
    buckets = {p: [] for p in POS_OK}
    seen = set()
    for row in rows:
        word = (row.get("word") or "").strip()
        key = word.lower()
        if not key or key in seen or key in exclude:
            continue
        ex = (row.get("ex") or "").strip()
        if not ex or len(ex.split()) > 12:
            continue
        if not (row.get("ipa") or "").strip():
            continue
        if not (row.get("tr") or "").strip():
            continue
        seen.add(key)
        pos = normalize_pos(row.get("pos"))
        buckets.setdefault(pos, []).append(row)

    # Target quotas (sum ~= 900)
    quotas = {
        "verb": 220,
        "noun": 380,
        "adj": 180,
        "adv": 55,
        "phrase": 40,
        "prep": 10,
        "conj": 5,
        "other": 10,
    }
    selected = []
    for pos, q in quotas.items():
        selected.extend(buckets.get(pos, [])[:q])

    # Fill remaining from leftover nouns/verbs/adjs
    used = {(r.get("word") or "").lower() for r in selected}
    leftovers = []
    for pos in ("noun", "verb", "adj", "adv", "phrase", "other", "prep", "conj"):
        for r in buckets.get(pos, []):
            k = (r.get("word") or "").lower()
            if k not in used:
                leftovers.append(r)
    while len(selected) < target and leftovers:
        selected.append(leftovers.pop(0))

    cards = []
    for row in selected[:target]:
        word = row["word"].strip()
        n = len(cards) + 1
        bucket = row.get("bucket") or "object"
        cards.append({
            "id": "a2-%04d" % n,
            "word": word,
            "lemma": word.lower(),
            "ipa": row.get("ipa") or "",
            "pos": normalize_pos(row.get("pos")),
            "level": "a2",
            "tr": row.get("tr") or "",
            "note": row.get("note") or "",
            "ex": (row.get("ex") or "").strip(),
            "exRu": row.get("exRu") or "",
            "colloc": row.get("colloc") or "",
            "img": svg(bucket),
            "imgSrc": "svg",
            "imgAlt": word,
        })
    return cards


def main():
    cards = build_cards()
    out = ROOT / "data" / "a2.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8") as f:
        json.dump(cards, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print("Wrote %d cards -> %s" % (len(cards), out))
    if not (800 <= len(cards) <= 1000):
        print("WARNING: count %d outside 800–1000" % len(cards))


if __name__ == "__main__":
    main()
