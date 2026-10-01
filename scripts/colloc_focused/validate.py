#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import json, sys, re
from pathlib import Path
from difflib import SequenceMatcher

ROOT = Path(__file__).resolve().parents[2]
FOCUSED = Path(__file__).resolve().parent
SKIP = set(x.strip().lower() for x in (FOCUSED / 'SKIP.txt').read_text(encoding='utf-8').splitlines() if x.strip())

FILES = {
    'colloc-verb-noun': (350, 450),
    'colloc-adj-noun': (300, 400),
    'colloc-prep': (280, 380),
    'colloc-business': (250, 350),
    'colloc-academic': (200, 300),
}

def norm_key(s):
    s = (s or '').lower().strip()
    return ' '.join(t for t in s.split() if t not in {'a', 'an', 'the'})

def similar(a, b):
    a = (a or '').lower().strip(); b = (b or '').lower().strip()
    if a == b: return True
    return SequenceMatcher(None, a, b).ratio() >= 0.88

def validate(path, lo, hi, cross):
    cards = json.loads(path.read_text(encoding='utf-8'))
    assert isinstance(cards, list), path
    assert lo <= len(cards) <= hi, f'{path.name} count {len(cards)} not in {lo}-{hi}'
    lemmas = []
    for c in cards:
        assert (c.get('word') or '').strip(), c.get('id')
        assert (c.get('tr') or '').strip(), c.get('id')
        assert c.get('level') in {'b1', 'b2', 'c1'}, c.get('id')
        assert c.get('pos') == 'collocation' or c.get('pos'), c.get('id')
        assert c.get('imgSrc') == 'svg'
        assert (c.get('img') or '').startswith('/icons/concepts/')
        exs = c.get('examples') or []
        assert len(exs) >= 2, c['id']
        for e in exs:
            assert (e.get('en') or '').strip() and (e.get('ru') or '').strip(), c['id']
        assert c['ex'] == exs[0]['en'] and c['exRu'] == exs[0]['ru'], c['id']
        for i in range(len(exs)):
            for j in range(i + 1, len(exs)):
                assert not similar(exs[i]['en'], exs[j]['en']), f'similar ex {c["id"]}'
        lem = (c.get('lemma') or c['word']).lower().strip()
        key = norm_key(lem)
        assert key not in SKIP, f'overlaps existing: {lem}'
        assert key not in cross, f'cross-deck dup: {lem}'
        lemmas.append(lem)
        cross.add(key)
    assert len(lemmas) == len(set(lemmas)), f'dup lemmas in {path.name}'
    avg = sum(len(c['examples']) for c in cards) / len(cards)
    print(f'OK {path.name}: {len(cards)} cards avg_ex={avg:.2f}')
    return cards

def main():
    cross = set()
    which = sys.argv[1:] or list(FILES)
    for name in which:
        lo, hi = FILES[name]
        validate(ROOT / 'data' / f'{name}.json', lo, hi, cross)
    print('ALL OK')

if __name__ == '__main__':
    try:
        main()
    except AssertionError as e:
        print('FAIL:', e); sys.exit(1)
