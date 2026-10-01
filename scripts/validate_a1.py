#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Validate data/a1.json enrichment requirements."""
from pathlib import Path
import json
import sys

DATA = Path(__file__).resolve().parents[1] / 'data' / 'a1.json'


def main():
    cards = json.loads(DATA.read_text(encoding='utf-8'))
    assert isinstance(cards, list), 'not a JSON array'
    assert len(cards) == 880, 'expected 880 cards, got %s' % len(cards)
    lemmas = []
    for i, c in enumerate(cards):
        assert (c.get('word') or '').strip(), 'empty word @%s' % i
        assert (c.get('tr') or '').strip(), 'empty tr @%s' % i
        exs = c.get('examples') or []
        assert len(exs) >= 2, '%s needs examples length>=2' % c.get('id')
        for e in exs:
            assert (e.get('en') or '').strip() and (e.get('ru') or '').strip(), (
                '%s example missing en/ru' % c.get('id')
            )
        # backward compat
        assert c.get('ex') == exs[0]['en'], '%s ex != examples[0]' % c['id']
        assert c.get('exRu') == exs[0]['ru'], '%s exRu != examples[0]' % c['id']
        lemmas.append(c['lemma'])
    assert len(lemmas) == len(set(lemmas)), 'duplicate lemmas'
    avg = sum(len(c['examples']) for c in cards) / len(cards)
    print('OK: 880 cards, examples avg=%.2f, no empty word/tr, no dup lemmas' % avg)


if __name__ == '__main__':
    try:
        main()
    except AssertionError as e:
        print('FAIL:', e)
        sys.exit(1)
