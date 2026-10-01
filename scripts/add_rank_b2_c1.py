#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""STAGE 2: add rank (core|useful|rare) to every card in data/b2.json and data/c1.json."""
from __future__ import annotations

import csv
import json
import re
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

try:
    from wordfreq import zipf_frequency
except ImportError:
    import subprocess
    subprocess.check_call([str(ROOT / ".venv" / "bin" / "pip"), "install", "wordfreq", "-q"])
    from wordfreq import zipf_frequency  # type: ignore

ORDER = {"A1": 1, "A2": 2, "B1": 3, "B2": 4, "C1": 5, "C2": 6}
VALID = {"core", "useful", "rare"}


def load_cefrj() -> dict[str, str]:
    path = ROOT / "scripts" / "c1_build" / "cefrj.csv"
    out: dict[str, str] = {}
    with path.open(encoding="utf-8") as f:
        for row in csv.DictReader(f):
            hw = (row.get("headword") or "").lower().strip()
            lvl = (row.get("CEFR") or "").strip()
            if not hw or not lvl:
                continue
            if hw not in out or ORDER.get(lvl, 9) < ORDER.get(out[hw], 9):
                out[hw] = lvl
    return out


def load_ox5() -> dict[str, str]:
    path = ROOT / "scripts" / "c1_build" / "american_ox5000.txt"
    text = path.read_text(encoding="utf-8", errors="replace")
    out: dict[str, str] = {}
    for m in re.finditer(
        r"([A-Za-z][A-Za-z0-9'-]*)\s+"
        r"(?:n\.|v\.|adj\.|adv\.|prep\.|conj\.|det\.|pron\.|exclam\.|modal v\.)"
        r"(?:\s*,\s*(?:n\.|v\.|adj\.|adv\.|prep\.|conj\.))*?\s+"
        r"(A[12]|B[12]|C[12])",
        text,
    ):
        lem, lvl = m.group(1).lower(), m.group(2)
        if lem not in out or ORDER.get(lvl, 9) < ORDER.get(out[lem], 9):
            out[lem] = lvl
    return out


def load_ox3() -> set[str]:
    path = ROOT / "scripts" / "b2_build" / "ox3000.txt"
    return {ln.strip().lower() for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip()}


# Niche / low-utility / culture-specific for a C1-bound learner
B2_FORCE_RARE = {
    # US / culture / sports / narrow roles — low transfer for C1 goal
    "sophomore", "sidewalk", "congressional", "councilor", "spokeswoman", "aide",
    "rookie", "firearm", "broadband", "liter", "postwar", "marathon", "trophy",
    "rifle", "banner", "presidency", "legislature", "embassy", "portfolio",
    "shareholder", "settler", "inmate", "seeker", "lawmaker", "senator", "cowboy",
    "coordinator", "lawn", "filmmaker", "columnist", "broadcaster", "spokesperson",
    "commentator", "trustee", "miner", "peasant", "contender", "patron", "dime",
    "novelist", "memoir", "newsletter", "apparel", "outing", "roster", "skull",
    "riot", "raid", "artwork", "rental", "receiver", "setup", "smash", "rod",
    "tribe", "lens", "felony", "trillion", "lyric", "slogan", "sponsorship",
    "litter", "folding", "offender", "troop", "rumor", "longtime", "soak", "grin",
    "benchmark", "militant", "educator", "enthusiast", "spectator", "tsunami",
    # truly low-frequency / ornamental-ish
    "incarcerate", "incarceration", "privatization", "insertion", "residue", "quota",
    "ethic", "predator", "indictment", "transcript", "limb", "turnout", "proceeding",
    "dictator", "backdrop", "outsider", "insider", "offspring", "sibling",
    "conception", "endorsement", "infamous", "deed", "lifelong", "restraint",
    "chunk", "slash", "dub", "ensue", "loom", "shrug", "exert", "decorate",
    "infect", "soar", "overturn", "extremist", "secondly", "ironically", "seldom",
    "rotate", "regulator", "endeavor", "dishonest", "peculiar", "imminent",
    "unconstitutional", "compulsory", "marginal", "downward", "upward", "flawed",
    "cynical", "humorous", "impatient",
}

B2_FORCE_CORE = {
    "unless", "whereas", "besides", "alongside", "beside", "beneath", "wherever",
    "acknowledge", "significant", "substantial", "essential", "crucial", "relevant",
    "appropriate", "effective", "efficient", "sufficient", "necessary", "important",
    "available", "responsible", "successful", "traditional", "particular", "specific",
    "approach", "evidence", "research", "analysis", "authority", "opportunity",
    "environment", "community", "society", "development", "relationship", "situation",
    "provide", "require", "involve", "include", "consider", "suggest", "indicate",
    "demonstrate", "establish", "identify", "determine", "maintain", "develop",
    "benefit", "challenge", "impact", "process", "structure", "function", "role",
    "sense", "value", "major", "national", "rate", "range", "level", "form", "term",
    "aspect", "factor", "basis", "source", "method", "result", "effect", "cause",
    "purpose", "condition", "standard", "policy", "system", "urge", "vary", "ensure",
    "enable", "achieve", "obtain", "assume", "claim", "argue", "conclude", "define",
    "describe", "explain", "express", "focus", "increase", "reduce", "improve",
    "support", "produce", "create", "design", "fundamentally", "broadly",
    "sufficiently", "efficiently", "appropriately", "adequately", "remarkably",
    "extensively", "steadily", "critically", "undoubtedly",
}

B2_NEVER_RARE = {
    "devastate", "entitle", "terrify", "overwhelm", "deteriorate", "intensify",
    "allocate", "formulate", "provoke", "collaborate", "derive", "prohibit",
    "persist", "devote", "exaggerate", "reassure", "enrich", "evoke", "deem",
    "escalate", "inflict", "diagnose", "depict", "diminish", "aspire", "speculate",
    "coincide", "empower", "uphold", "overlook", "articulate", "administer",
    "prosecute", "indulge", "flourish", "starve", "inherit", "oblige", "infer",
    "embody", "circulate", "mobilize", "deprive", "devise", "correlate", "unveil",
    "detain", "shatter", "denounce", "encompass", "proclaim", "specialize",
    "incur", "linger", "invoke", "inhibit", "designate", "originate", "elevate",
    "inquire", "prescribe", "embark", "compute", "defy", "divert", "enact",
    "inject", "simulate", "enroll", "unfold", "kidnap", "dissolve", "plunge",
    "equip", "multiply", "descend", "oversee", "erect", "dispose", "evacuate",
    "expire", "distort", "unify", "precede", "imprison", "obsess", "embed",
    "displace", "erupt", "preside", "heighten", "amend", "maximize",
    "differentiate", "plead", "discard", "dictate", "undermine", "intervene",
    "endorse", "inspect", "portray", "align", "retrieve", "manipulate", "preach",
    "deploy", "isolate", "merge", "motivate", "attribute", "tolerate", "reckon",
    "withdraw", "wrap", "wander", "whisper", "bizarre", "amusing", "brutal",
    "authentic", "beneficial", "arbitrary", "accessible", "acceptable", "abstract",
    "absurd", "acute", "adverse", "aesthetic", "affordable", "anonymous",
    "appealing", "applicable", "astonishing", "athletic", "behavioral", "beloved",
    "biological", "foreigner", "gaze", "fragment", "intriguing", "pathway",
    "hostility", "adolescent", "forthcoming", "constraint", "contradiction",
    "globalization", "allegation", "atrocity", "sanction", "protester", "lawmaker",
    "optimism", "dependence", "accumulation", "complication", "beneficiary",
    "intensity", "protocol", "productivity", "identification", "classification",
    "jurisdiction", "restoration", "closure", "adoption", "patent", "commentary",
    "ranking", "array", "propaganda", "torture", "missile", "lawsuit", "screening",
    "incidence", "prevalence", "concession", "assertion", "practitioner",
    "dilemma", "metaphor", "scrutiny", "skeptical", "empirical", "remark",
    "viewpoint", "query", "presume", "reproduce", "adhere", "nominate", "induce",
    "prevail", "defect", "trait", "analogy", "disruption", "confrontation",
    "contributor", "realization", "contempt", "emergence", "expenditure",
    "contention", "disastrous", "disrupt",
}



def score_b2(card, ox3, ox5, cefrj) -> float:
    lem = card["lemma"].lower()
    z = zipf_frequency(lem, "en")
    s = z
    if card.get("pos") in ("prep", "conj"):
        s += 2.0
    if lem in ox3:
        s += 0.22
    if ox5.get(lem) == "B2":
        s += 0.10
    if cefrj.get(lem) in ("A1", "A2"):
        s += 0.10
    if lem in B2_FORCE_CORE:
        s += 0.6
    if lem in B2_FORCE_RARE:
        s -= 2.0
    if card.get("pos") == "noun" and len(lem) >= 12 and z < 3.65:
        s -= 0.12
    return s


def rank_b2(cards, ox3, ox5, cefrj) -> dict[str, str]:
    items = [(c, c["lemma"].lower(), score_b2(c, ox3, ox5, cefrj), zipf_frequency(c["lemma"].lower(), "en")) for c in cards]
    items.sort(key=lambda x: x[2], reverse=True)
    n = len(items)
    n_core = int(round(n * 0.40))
    out: dict[str, str] = {}
    for i, (c, lem, _sc, z) in enumerate(items):
        if lem in B2_FORCE_CORE or c.get("pos") in ("prep", "conj"):
            r = "core"
        elif lem in B2_FORCE_RARE:
            r = "rare"
        elif i < n_core:
            r = "core"
        else:
            r = "useful"
        # protect utility verbs/adjs from rare
        if r == "rare" and lem in B2_NEVER_RARE:
            r = "useful"
        if lem in B2_FORCE_RARE:
            r = "rare"
        if lem in B2_FORCE_CORE or c.get("pos") in ("prep", "conj"):
            r = "core"
        out[c["id"]] = r

    return out


C1_FORCE_CORE = {
    "behind", "whilst", "versus", "whereas", "well-being", "substantial",
    "strategic", "worthwhile", "worthy", "yield", "abundance", "abundant",
    "accustomed", "adept", "nature", "labour", "automatic", "automatically",
    "superior", "storage", "signal", "cost-effective", "large-scale",
    "long-standing", "self-worth", "awareness", "capability", "capacity",
    "comprehensive", "crucial", "critical", "consistent", "considerable",
    "contemporary", "contribution", "context", "consensus", "constraint",
    "controversy", "conventional", "framework", "fundamental", "furthermore",
    "generate", "highlight", "hypothesis", "identical", "identify", "illustrate",
    "impact", "implement", "implication", "impose", "incentive", "incorporate",
    "indicate", "inevitable", "infer", "infrastructure", "inherent", "initiate",
    "innovation", "insight", "integrate", "integrity", "interpret", "intervene",
    "intrinsic", "investigate", "invoke", "isolate", "justify", "mechanism",
    "nonetheless", "nevertheless", "notion", "objective", "outcome", "overall",
    "paradigm", "parameter", "perceive", "persist", "perspective", "phenomenon",
    "predominantly", "premise", "presumably", "primarily", "principle", "prior",
    "priority", "procedure", "proportion", "prospect", "protocol", "provision",
    "qualitative", "quantitative", "radical", "rational", "realm", "reconcile",
    "refine", "reinforce", "relevant", "reliable", "respective", "robust",
    "scenario", "scheme", "scope", "scrutiny", "significance", "significant",
    "simulate", "sophisticated", "subsequent", "subtle", "sufficient", "supreme",
    "sustain", "tendency", "threshold", "undermine", "undergo", "undertake",
    "underlying", "unfold", "uniform", "unique", "utility", "vague", "valid",
    "variable", "variation", "variety", "various", "vary", "vast", "venture",
    "via", "virtual", "virtue", "visible", "vision", "vital", "vulnerable",
    "widespread", "withdraw",
}


def rank_c1(cards, ox5, cefrj) -> dict[str, str]:
    out: dict[str, str] = {}
    for c in cards:
        lem = c["lemma"].lower()
        z = zipf_frequency(lem, "en")
        pos = c.get("pos") or ""
        ornate_adv = pos == "adv" and lem.endswith("ly") and z < 2.70
        ghost = z <= 0.0
        very_rare = z < 1.95
        fancy_noun = (
            pos == "noun"
            and z < 2.15
            and len(lem) >= 10
            and lem.endswith(("ness", "ity", "tion", "sion", "ment", "ance", "ence", "ism"))
        )
        if pos in ("prep", "conj") or lem in C1_FORCE_CORE:
            out[c["id"]] = "core"
        elif ghost or ornate_adv or very_rare or fancy_noun:
            out[c["id"]] = "rare"
        elif (
            z >= 3.25
            or (cefrj.get(lem) in ("A1", "A2", "B1", "B2") and z >= 3.05)
            or (ox5.get(lem) in ("B2", "C1") and z >= 3.15)
        ):
            out[c["id"]] = "core"
        elif z < 2.30:
            out[c["id"]] = "rare"
        else:
            out[c["id"]] = "useful"
    return out


def apply_ranks(path: Path, ranks: dict[str, str]) -> tuple[int, Counter]:
    cards = json.loads(path.read_text(encoding="utf-8"))
    assert isinstance(cards, list)
    before = len(cards)
    for c in cards:
        r = ranks[c["id"]]
        assert r in VALID, (c["id"], r)
        c["rank"] = r
    path.write_text(json.dumps(cards, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    ct = Counter(c["rank"] for c in cards)
    assert len(cards) == before
    return before, ct


def validate(path: Path, expected_n: int) -> None:
    cards = json.loads(path.read_text(encoding="utf-8"))
    assert len(cards) == expected_n, (path.name, len(cards), expected_n)
    for c in cards:
        assert c.get("rank") in VALID, c.get("id")
        exs = c.get("examples") or []
        assert len(exs) >= 2, c["id"]
        for e in exs:
            assert (e.get("en") or "").strip() and (e.get("ru") or "").strip(), c["id"]


def main() -> None:
    cefrj = load_cefrj()
    ox5 = load_ox5()
    ox3 = load_ox3()

    b2_path = ROOT / "data" / "b2.json"
    c1_path = ROOT / "data" / "c1.json"
    b2 = json.loads(b2_path.read_text(encoding="utf-8"))
    c1 = json.loads(c1_path.read_text(encoding="utf-8"))
    n_b2, n_c1 = len(b2), len(c1)

    rb = rank_b2(b2, ox3, ox5, cefrj)
    rc = rank_c1(c1, ox5, cefrj)
    assert len(rb) == n_b2 and len(rc) == n_c1

    nb, ctb = apply_ranks(b2_path, rb)
    nc, ctc = apply_ranks(c1_path, rc)
    validate(b2_path, n_b2)
    validate(c1_path, n_c1)

    print("B2", nb, dict(ctb), {k: round(100 * v / nb) for k, v in ctb.items()})
    print("C1", nc, dict(ctc), {k: round(100 * v / nc) for k, v in ctc.items()})


if __name__ == "__main__":
    main()
