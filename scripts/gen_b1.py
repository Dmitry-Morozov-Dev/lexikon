#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Generate data/b1.json — 1000–1200 B1 lemmas excluding a1+a2."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PARTS = Path(__file__).resolve().parent / "b1_parts"
POS_OK = {"noun", "verb", "adj", "adv", "prep", "conj", "phrase", "other"}
POS_MAP = {"number": "other", "num": "other", "adjective": "adj", "adverb": "adv"}

CONCEPT = {
    "person": "person", "family": "person", "body": "person", "job": "person",
    "food": "nature", "drink": "nature", "animal": "nature", "nature": "nature",
    "place": "place", "home": "place", "travel": "place", "city": "place",
    "time": "time", "number": "number", "color": "object",
    "action": "action", "verb": "action", "sport": "action",
    "emotion": "emotion", "adj": "emotion",
    "speech": "speech", "school": "idea", "idea": "idea",
    "object": "object", "clothes": "object", "tech": "object", "money": "object",
    "weather": "nature", "work": "action",
}


def svg(kind: str) -> str:
    return "/icons/concepts/%s.svg" % CONCEPT.get(kind, "object")


def normalize_pos(pos: str) -> str:
    pos = (pos or "other").lower().strip()
    pos = POS_MAP.get(pos, pos)
    return pos if pos in POS_OK else "other"


def load_exclude():
    keys = set()
    for name in ("a1.json", "a2.json"):
        path = ROOT / "data" / name
        for c in json.loads(path.read_text(encoding="utf-8")):
            keys.add(c.get("lemma", "").lower())
            keys.add(c.get("word", "").lower())
    keys.discard("")
    return keys


def load_rows():
    rows = []
    for path in sorted(PARTS.glob("*.json")):
        if path.name == "nouns_a.json":
            continue
        rows.extend(json.loads(path.read_text(encoding="utf-8")))
    return rows


def build_cards(target_min=1000, target_max=1200, prefer=1100):
    exclude = load_exclude()
    rows = load_rows()
    seen = set()
    selected = []
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
        # Honest local SVG only
        bucket = row.get("bucket") or "object"
        img = svg(bucket)
        if not img.startswith("/icons/concepts/") or not img.endswith(".svg"):
            continue
        seen.add(key)
        selected.append(row)
        if len(selected) >= target_max:
            break

    if len(selected) < target_min:
        raise SystemExit(
            "Only %d valid B1 lemmas after exclude (need %d–%d)"
            % (len(selected), target_min, target_max)
        )

    # Prefer ~1100 if we have more
    if len(selected) > prefer:
        selected = selected[:prefer]

    cards = []
    for row in selected:
        word = row["word"].strip()
        n = len(cards) + 1
        bucket = row.get("bucket") or "object"
        cards.append({
            "id": "b1-%04d" % n,
            "word": word,
            "lemma": word.lower(),
            "ipa": row.get("ipa") or "",
            "pos": normalize_pos(row.get("pos")),
            "level": "b1",
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


def validate(cards, exclude):
    required = [
        "id", "word", "lemma", "ipa", "pos", "level", "tr", "note",
        "ex", "exRu", "colloc", "img", "imgSrc", "imgAlt",
    ]
    missing = 0
    long_ex = 0
    lemmas = []
    for c in cards:
        for f in required:
            if f not in c or c[f] is None:
                missing += 1
            elif f not in ("note", "colloc") and isinstance(c[f], str) and not c[f].strip() and f != "note":
                if f not in ("note", "colloc"):
                    # note and colloc may be empty; all others required non-empty except note/colloc
                    if f not in ("note", "colloc"):
                        missing += 1
        # Re-check: note/colloc allowed empty; others must be non-empty strings
        for f in required:
            if f in ("note", "colloc"):
                continue
            v = c.get(f)
            if v is None or (isinstance(v, str) and not str(v).strip()):
                missing += 1
        if len((c.get("ex") or "").split()) > 12:
            long_ex += 1
        lemmas.append((c.get("lemma") or "").lower())
        if c.get("level") != "b1":
            missing += 1
        if c.get("imgSrc") != "svg":
            missing += 1
        if not str(c.get("img", "")).startswith("/icons/concepts/"):
            missing += 1

    dups = len(lemmas) - len(set(lemmas))
    overlap = len(set(lemmas) & exclude)
    return {
        "count": len(cards),
        "missing": missing,
        "long_ex": long_ex,
        "dups": dups,
        "overlap": overlap,
    }


def main():
    exclude = load_exclude()
    cards = build_cards()
    out = ROOT / "data" / "b1.json"
    out.write_text(json.dumps(cards, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    stats = validate(cards, exclude)
    print("Wrote", out, "count=%d" % stats["count"])
    print(
        "validation: missing=%d long_ex=%d dups=%d overlap=%d"
        % (stats["missing"], stats["long_ex"], stats["dups"], stats["overlap"])
    )
    ok = (
        1000 <= stats["count"] <= 1200
        and stats["missing"] == 0
        and stats["long_ex"] == 0
        and stats["dups"] == 0
        and stats["overlap"] == 0
    )
    if not ok:
        raise SystemExit("VALIDATION FAILED: %s" % stats)
    print("VALIDATION OK")


if __name__ == "__main__":
    main()
