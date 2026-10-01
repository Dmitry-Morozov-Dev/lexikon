#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Assemble data/b2.json from scripts/b2_build/batches/*.json"""
from pathlib import Path
import json, sys, re
from difflib import SequenceMatcher

ROOT = Path(__file__).resolve().parents[1]
BATCH = ROOT / 'scripts' / 'b2_build' / 'batches'
OUT = ROOT / 'data' / 'b2.json'

CONCEPT = {
    'person': 'person', 'family': 'person', 'body': 'person', 'job': 'person',
    'food': 'nature', 'drink': 'nature', 'animal': 'nature', 'nature': 'nature',
    'place': 'place', 'home': 'place', 'travel': 'place', 'city': 'place',
    'time': 'time', 'number': 'number',
    'action': 'action', 'verb': 'action', 'sport': 'action', 'work': 'action',
    'emotion': 'emotion', 'adj': 'emotion',
    'speech': 'speech', 'school': 'idea', 'idea': 'idea',
    'object': 'object', 'clothes': 'object', 'tech': 'object', 'money': 'object',
    'weather': 'nature',
}

def svg(kind):
    return '/icons/concepts/%s.svg' % CONCEPT.get(kind, 'object')

def similar(a, b):
    a = (a or '').lower().strip(); b = (b or '').lower().strip()
    if not a or not b: return False
    if a == b: return True
    return SequenceMatcher(None, a, b).ratio() >= 0.88

def load_taken():
    keys = set()
    for name in ('a1', 'a2', 'b1'):
        for c in json.loads((ROOT / 'data' / f'{name}.json').read_text(encoding='utf-8')):
            keys.add(c.get('lemma', '').lower())
            keys.add(c.get('word', '').lower())
    keys.discard('')
    return keys

def load_batches():
    rows = []
    for p in sorted(BATCH.glob('batch_*.json')):
        rows.extend(json.loads(p.read_text(encoding='utf-8')))
    return rows

def normalize(row, idx, taken, seen):
    word = (row.get('word') or '').strip()
    lemma = (row.get('lemma') or word).strip().lower()
    if not word or not lemma:
        raise ValueError('empty word at %s' % idx)
    if lemma in seen or lemma in taken or word.lower() in taken:
        raise ValueError('overlap/dup lemma %s' % lemma)
    tr = (row.get('tr') or '').strip()
    if not tr:
        raise ValueError('empty tr %s' % lemma)
    ipa = (row.get('ipa') or '').strip()
    if ipa and not ipa.startswith('/'):
        ipa = '/' + ipa.strip('/') + '/'
    if not ipa:
        raise ValueError('empty ipa %s' % lemma)
    pos = (row.get('pos') or 'other').lower()
    if pos not in {'noun','verb','adj','adv','prep','conj','phrase','other'}:
        pos = 'other'
    exs = []
    for e in row.get('examples') or []:
        en = (e.get('en') or '').strip(); ru = (e.get('ru') or '').strip()
        if not en or not ru: continue
        if any(similar(en, x['en']) for x in exs):
            continue
        exs.append({'en': en, 'ru': ru})
    if len(exs) < 2:
        raise ValueError('%s needs >=2 distinct examples' % lemma)
    exs = exs[:3]
    bucket = row.get('bucket') or ('action' if pos=='verb' else 'idea' if pos in ('noun','adv') else 'emotion' if pos=='adj' else 'object')
    card = {
        'id': 'b2-%04d' % idx,
        'word': word,
        'lemma': lemma,
        'ipa': ipa,
        'pos': pos,
        'level': 'b2',
        'tr': tr,
        'note': (row.get('note') or '').strip(),
        'ex': exs[0]['en'],
        'exRu': exs[0]['ru'],
        'examples': exs,
        'colloc': (row.get('colloc') or '').strip(),
        'img': svg(bucket),
        'imgSrc': 'svg',
        'imgAlt': word,
    }
    for k in ('pattern', 'syn', 'ant'):
        v = (row.get(k) or '').strip()
        if v:
            card[k] = v
    seen.add(lemma)
    return card

def main():
    taken = load_taken()
    rows = load_batches()
    seen = set()
    cards = []
    for row in rows:
        cards.append(normalize(row, len(cards)+1, taken, seen))
    n = len(cards)
    if not (1400 <= n <= 1600):
        print('WARN count %s outside 1400–1600' % n, file=sys.stderr)
    OUT.write_text(json.dumps(cards, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    avg = sum(len(c['examples']) for c in cards) / max(1,len(cards))
    print('OK wrote %s cards=%s examples_avg=%.2f colloc=%s pattern=%s note=%s' % (
        OUT, n, avg,
        sum(1 for c in cards if c.get('colloc')),
        sum(1 for c in cards if c.get('pattern')),
        sum(1 for c in cards if c.get('note')),
    ))

if __name__ == '__main__':
    main()
