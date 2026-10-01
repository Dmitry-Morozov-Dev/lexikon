#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Assemble data/phrasal.json from scripts/phrasal_build/batches/*.json"""
from pathlib import Path
import json, sys
from difflib import SequenceMatcher

ROOT = Path(__file__).resolve().parents[1]
BATCH = ROOT / 'scripts' / 'phrasal_build' / 'batches'
OUT = ROOT / 'data' / 'phrasal.json'

CONCEPT = {
    'person': 'person', 'action': 'action', 'verb': 'action', 'emotion': 'emotion',
    'idea': 'idea', 'speech': 'speech', 'object': 'object', 'place': 'place',
    'time': 'time', 'nature': 'nature', 'number': 'number',
}

def svg(kind):
    return '/icons/concepts/%s.svg' % CONCEPT.get(kind, 'action')

def similar(a, b):
    a = (a or '').lower().strip(); b = (b or '').lower().strip()
    if not a or not b: return False
    if a == b: return True
    return SequenceMatcher(None, a, b).ratio() >= 0.88

def load_batches():
    rows = []
    for p in sorted(BATCH.glob('batch_*.json')):
        rows.extend(json.loads(p.read_text(encoding='utf-8')))
    return rows

def normalize(row, idx, seen):
    word = (row.get('word') or '').strip()
    lemma = (row.get('lemma') or word).strip().lower()
    if not word or not lemma:
        raise ValueError('empty word at %s' % idx)
    if lemma in seen:
        raise ValueError('dup lemma %s' % lemma)
    tr = (row.get('tr') or '').strip()
    if not tr:
        raise ValueError('empty tr %s' % lemma)
    ipa = (row.get('ipa') or '').strip()
    if ipa and not ipa.startswith('/'):
        ipa = '/' + ipa.strip('/') + '/'
    # IPA optional for multiword
    pos = (row.get('pos') or 'phrase').lower()
    if pos not in {'noun','verb','adj','adv','prep','conj','phrase','other'}:
        pos = 'phrase'
    level = (row.get('level') or 'mixed').lower()
    if level not in {'a1','a2','b1','b2','c1','c2','mixed'}:
        level = 'mixed'
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
    bucket = row.get('bucket') or 'action'
    card = {
        'id': 'phrasal-%04d' % idx,
        'word': word,
        'lemma': lemma,
        'ipa': ipa,
        'pos': pos,
        'level': level,
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
    rows = load_batches()
    seen = set()
    cards = []
    for row in rows:
        cards.append(normalize(row, len(cards)+1, seen))
    n = len(cards)
    if not (400 <= n <= 600):
        print('WARN count %s outside 400–600' % n, file=sys.stderr)
    OUT.write_text(json.dumps(cards, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    avg = sum(len(c['examples']) for c in cards) / max(1,len(cards))
    print('OK wrote %s cards=%s examples_avg=%.2f colloc=%s pattern=%s' % (
        OUT, n, avg,
        sum(1 for c in cards if c.get('colloc')),
        sum(1 for c in cards if c.get('pattern')),
    ))

if __name__ == '__main__':
    main()
