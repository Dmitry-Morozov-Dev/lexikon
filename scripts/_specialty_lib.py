#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Shared assemble/validate helpers for specialty decks."""
from pathlib import Path
import json, sys
from difflib import SequenceMatcher

CONCEPT = {
    'person': 'person', 'action': 'action', 'emotion': 'emotion',
    'idea': 'idea', 'speech': 'speech', 'object': 'object', 'place': 'place',
    'time': 'time', 'nature': 'nature', 'number': 'number', 'tech': 'object',
}

def svg(kind):
    return '/icons/concepts/%s.svg' % CONCEPT.get(kind, 'idea')

def similar(a, b):
    a = (a or '').lower().strip(); b = (b or '').lower().strip()
    if not a or not b: return False
    if a == b: return True
    return SequenceMatcher(None, a, b).ratio() >= 0.88

def assemble(batch_dir, out_path, id_prefix, min_n, max_n, default_level='mixed', default_bucket='idea', require_space=False):
    rows = []
    for p in sorted(Path(batch_dir).glob('batch_*.json')):
        rows.extend(json.loads(p.read_text(encoding='utf-8')))
    seen = set()
    cards = []
    for row in rows:
        word = (row.get('word') or '').strip()
        lemma = (row.get('lemma') or word).strip().lower()
        if not word or not lemma:
            raise ValueError('empty word')
        if lemma in seen:
            raise ValueError('dup %s' % lemma)
        if require_space and ' ' not in word and '-' not in word:
            raise ValueError('expected multiword %s' % word)
        tr = (row.get('tr') or '').strip()
        if not tr:
            raise ValueError('empty tr %s' % lemma)
        ipa = (row.get('ipa') or '').strip()
        if ipa and not ipa.startswith('/'):
            ipa = '/' + ipa.strip('/') + '/'
        pos = (row.get('pos') or 'phrase').lower()
        if pos not in {'noun','verb','adj','adv','prep','conj','phrase','other'}:
            pos = 'phrase'
        level = (row.get('level') or default_level).lower()
        if level not in {'a1','a2','b1','b2','c1','c2','mixed','b2-c1','b1-c1'}:
            level = default_level
        exs = []
        for e in row.get('examples') or []:
            en = (e.get('en') or '').strip(); ru = (e.get('ru') or '').strip()
            if not en or not ru: continue
            if any(similar(en, x['en']) for x in exs):
                continue
            exs.append({'en': en, 'ru': ru})
        if len(exs) < 2:
            raise ValueError('%s needs >=2 examples' % lemma)
        exs = exs[:3]
        bucket = row.get('bucket') or default_bucket
        card = {
            'id': '%s-%04d' % (id_prefix, len(cards)+1),
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
            if v: card[k] = v
        seen.add(lemma)
        cards.append(card)
    n = len(cards)
    if not (min_n <= n <= max_n):
        print('WARN count %s outside %s–%s' % (n, min_n, max_n), file=sys.stderr)
    Path(out_path).write_text(json.dumps(cards, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    avg = sum(len(c['examples']) for c in cards) / max(1, len(cards))
    print('OK wrote %s cards=%s examples_avg=%.2f' % (out_path, n, avg))
    return cards

def validate(data_path, min_n, max_n, require_space=False, allowed_levels=None):
    allowed_levels = allowed_levels or {'a1','a2','b1','b2','c1','c2','mixed','b2-c1','b1-c1'}
    cards = json.loads(Path(data_path).read_text(encoding='utf-8'))
    assert  min_n <= len(cards) <= max_n, 'count %s' % len(cards)
    lemmas = []
    for c in cards:
        assert (c.get('word') or '').strip() and (c.get('tr') or '').strip()
        assert c.get('level') in allowed_levels
        assert c.get('imgSrc') == 'svg'
        assert (c.get('img') or '').startswith('/icons/concepts/')
        if require_space:
            assert ' ' in c['word'] or '-' in c['word'], c['id']
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
    avg = sum(len(c['examples']) for c in cards) / len(cards)
    print('OK: %s cards, examples avg=%.2f' % (len(cards), avg))
