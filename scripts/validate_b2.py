#!/usr/bin/env python3
# -*- coding: utf-8 -*-
from pathlib import Path
import json, sys
from difflib import SequenceMatcher

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'data' / 'b2.json'

def similar(a, b):
    a = (a or '').lower().strip(); b = (b or '').lower().strip()
    if a == b: return True
    return SequenceMatcher(None, a, b).ratio() >= 0.88

def main():
    cards = json.loads(DATA.read_text(encoding='utf-8'))
    assert isinstance(cards, list)
    assert 1400 <= len(cards) <= 1600, 'count %s' % len(cards)
    lemmas = []
    for c in cards:
        assert (c.get('word') or '').strip() and (c.get('tr') or '').strip()
        assert c.get('level') == 'b2'
        assert (c.get('ipa') or '').strip()
        assert c.get('imgSrc') == 'svg'
        assert (c.get('img') or '').startswith('/icons/concepts/')
        exs = c.get('examples') or []
        assert len(exs) >= 2, c['id']
        for e in exs:
            assert (e.get('en') or '').strip() and (e.get('ru') or '').strip(), c['id']
        assert c['ex'] == exs[0]['en'] and c['exRu'] == exs[0]['ru']
        for i in range(len(exs)):
            for j in range(i+1, len(exs)):
                assert not similar(exs[i]['en'], exs[j]['en']), c['id']
        lemmas.append(c['lemma'])
    assert len(lemmas) == len(set(lemmas)), 'dup lemmas'
    for name in ('a1', 'a2', 'b1'):
        other = {x['lemma'] for x in json.loads((ROOT/'data'/f'{name}.json').read_text(encoding='utf-8'))}
        inter = other & set(lemmas)
        assert not inter, '%s overlap %s' % (name, list(inter)[:10])
    avg = sum(len(c['examples']) for c in cards) / len(cards)
    print('OK: %s cards, examples avg=%.2f' % (len(cards), avg))

if __name__ == '__main__':
    try:
        main()
    except AssertionError as e:
        print('FAIL:', e); sys.exit(1)
