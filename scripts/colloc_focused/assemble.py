#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Assemble focused collocation decks from scripts/colloc_focused/{vn,an,prep,biz,acad}/*.json"""
from __future__ import annotations
import json, sys, re
from pathlib import Path
from difflib import SequenceMatcher

ROOT = Path(__file__).resolve().parents[2]
FOCUSED = Path(__file__).resolve().parent
SKIP = set(x.strip().lower() for x in (FOCUSED / 'SKIP.txt').read_text(encoding='utf-8').splitlines() if x.strip())

DECKS = {
    'vn': {
        'dir': FOCUSED / 'vn',
        'out': ROOT / 'data' / 'colloc-verb-noun.json',
        'id_prefix': 'colloc-vn',
        'default_pattern': 'v + n',
        'target': (350, 450),
    },
    'an': {
        'dir': FOCUSED / 'an',
        'out': ROOT / 'data' / 'colloc-adj-noun.json',
        'id_prefix': 'colloc-an',
        'default_pattern': 'adj + n',
        'target': (300, 400),
    },
    'prep': {
        'dir': FOCUSED / 'prep',
        'out': ROOT / 'data' / 'colloc-prep.json',
        'id_prefix': 'colloc-prep',
        'default_pattern': 'v/adj + prep',
        'target': (280, 380),
    },
    'biz': {
        'dir': FOCUSED / 'biz',
        'out': ROOT / 'data' / 'colloc-business.json',
        'id_prefix': 'colloc-biz',
        'default_pattern': 'business collocation',
        'target': (250, 350),
    },
    'acad': {
        'dir': FOCUSED / 'acad',
        'out': ROOT / 'data' / 'colloc-academic.json',
        'id_prefix': 'colloc-acad',
        'default_pattern': 'academic collocation',
        'target': (200, 300),
    },
}

def norm_key(s: str) -> str:
    s = (s or '').lower().strip()
    s = re.sub(r'\s+', ' ', s)
    bare = ' '.join(t for t in s.split() if t not in {'a', 'an', 'the'})
    return bare

def similar(a, b, thr=0.88):
    a = (a or '').lower().strip(); b = (b or '').lower().strip()
    if not a or not b: return False
    if a == b: return True
    return SequenceMatcher(None, a, b).ratio() >= thr

def load_batches(d: Path):
    rows = []
    for p in sorted(d.glob('batch_*.json')):
        data = json.loads(p.read_text(encoding='utf-8'))
        if not isinstance(data, list):
            raise SystemExit(f'batch must be list: {p}')
        rows.extend(data)
    return rows

def card_from_row(row, idx, id_prefix, default_pattern, seen_local, seen_global):
    word = (row.get('word') or '').strip()
    lemma = (row.get('lemma') or word).strip().lower()
    if not word or not lemma:
        raise ValueError(f'empty word at {id_prefix}-{idx}')
    key = norm_key(lemma)
    if key in seen_local:
        raise ValueError(f'dup within deck: {lemma}')
    if key in SKIP or lemma in SKIP or key in seen_global:
        raise ValueError(f'overlaps existing/other deck: {lemma}')
    tr = (row.get('tr') or '').strip()
    if not tr:
        raise ValueError(f'empty tr: {lemma}')
    level = (row.get('level') or 'b1').lower()
    if level not in {'b1', 'b2', 'c1'}:
        raise ValueError(f'bad level {level} for {lemma}')
    exs = []
    for e in row.get('examples') or []:
        en = (e.get('en') or '').strip(); ru = (e.get('ru') or '').strip()
        if not en or not ru:
            continue
        if any(similar(en, x['en']) for x in exs):
            continue
        exs.append({'en': en, 'ru': ru})
    if len(exs) < 2:
        raise ValueError(f'{lemma} needs >=2 examples, got {len(exs)}')
    exs = exs[:3]
    pos = (row.get('pos') or 'collocation').strip() or 'collocation'
    pattern = (row.get('pattern') or default_pattern).strip()
    colloc = (row.get('colloc') or row.get('partners') or '').strip()
    note = (row.get('note') or '').strip()
    card = {
        'id': f'{id_prefix}-{idx:04d}',
        'word': word,
        'lemma': lemma,
        'ipa': (row.get('ipa') or '').strip(),
        'pos': pos,
        'level': level,
        'tr': tr,
        'note': note,
        'ex': exs[0]['en'],
        'exRu': exs[0]['ru'],
        'examples': exs,
        'colloc': colloc,
        'img': '/icons/concepts/speech.svg',
        'imgSrc': 'svg',
        'imgAlt': word,
        'pattern': pattern,
    }
    seen_local.add(key)
    seen_global.add(key)
    return card

def assemble_one(key, cfg, seen_global, write=True):
    rows = load_batches(cfg['dir'])
    seen_local = set()
    cards = []
    for row in rows:
        cards.append(card_from_row(
            row, len(cards) + 1, cfg['id_prefix'], cfg['default_pattern'],
            seen_local, seen_global,
        ))
    lo, hi = cfg['target']
    if not (lo <= len(cards) <= hi):
        print(f'WARN {key}: count {len(cards)} outside {lo}–{hi}', file=sys.stderr)
    if write:
        cfg['out'].write_text(json.dumps(cards, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    avg = sum(len(c['examples']) for c in cards) / max(1, len(cards))
    print(f'OK {key}: {len(cards)} cards avg_ex={avg:.2f} -> {cfg["out"].name}')
    return cards

def main(argv):
    which = argv[1:] or list(DECKS)
    seen_global = set()
    # pre-load already written sibling decks into seen_global for cross-deck dedup
    for k, cfg in DECKS.items():
        if k in which:
            continue
        if cfg['out'].exists():
            for c in json.loads(cfg['out'].read_text(encoding='utf-8')):
                seen_global.add(norm_key(c.get('lemma') or c.get('word') or ''))
    all_cards = {}
    for k in which:
        if k not in DECKS:
            raise SystemExit(f'unknown deck {k}')
        all_cards[k] = assemble_one(k, DECKS[k], seen_global, write=True)
    return 0

if __name__ == '__main__':
    raise SystemExit(main(sys.argv))
