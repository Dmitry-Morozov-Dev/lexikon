#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Merge scripts/b1_enrich/batch_*.json into data/b1.json and validate."""
from pathlib import Path
import json
import sys
from difflib import SequenceMatcher

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'data' / 'b1.json'
BATCH_DIR = ROOT / 'scripts' / 'b1_enrich'
A1 = ROOT / 'data' / 'a1.json'
A2 = ROOT / 'data' / 'a2.json'


def similar(a, b):
    a = (a or '').lower().strip()
    b = (b or '').lower().strip()
    if not a or not b:
        return False
    if a == b:
        return True
    def norm(s):
        return (s.replace("n't", ' not').replace("'re", ' are').replace("'s", ' is')
                 .replace("'m", ' am').replace("'ve", ' have').replace("'ll", ' will')
                 .replace("'d", ' would'))
    if norm(a) == norm(b):
        return True
    return SequenceMatcher(None, a, b).ratio() >= 0.88


def load_batches():
    merged = {}
    for p in sorted(BATCH_DIR.glob('batch_*.json')):
        merged.update(json.loads(p.read_text(encoding='utf-8')))
    return merged


def normalize_card(card, enrich):
    out = dict(card)
    if not enrich:
        raise ValueError('no enrich for %s' % card['id'])
    clean = []
    for e in enrich.get('examples') or []:
        if not e:
            continue
        en = (e.get('en') or '').strip()
        ru = (e.get('ru') or '').strip()
        if not en:
            continue
        if any(similar(en, k['en']) for k in clean):
            continue
        clean.append({'en': en, 'ru': ru})
    if len(clean) < 2:
        raise ValueError('%s has <2 distinct examples' % card['id'])
    out['examples'] = clean[:3]
    out['ex'] = clean[0]['en']
    out['exRu'] = clean[0]['ru']
    out['colloc'] = (enrich.get('colloc') or out.get('colloc') or '').strip()
    if enrich.get('collocs'):
        out['collocs'] = enrich['collocs']
    for key in ('note', 'pattern', 'syn', 'ant'):
        val = (enrich.get(key) or '').strip()
        if key == 'note':
            out['note'] = val
        elif val:
            out[key] = val
        else:
            out.pop(key, None)
    return out


def validate(cards):
    assert isinstance(cards, list), 'not a list'
    assert len(cards) == 1100, 'count %s != 1100' % len(cards)
    lemmas = []
    for i, c in enumerate(cards):
        assert (c.get('word') or '').strip(), 'empty word @%s' % i
        assert (c.get('tr') or '').strip(), 'empty tr @%s' % i
        exs = c.get('examples') or []
        assert len(exs) >= 2, '%s examples < 2' % c['id']
        for e in exs:
            assert (e.get('en') or '').strip(), '%s empty en' % c['id']
            assert (e.get('ru') or '').strip(), '%s empty ru' % c['id']
        assert c.get('ex') == exs[0]['en'], '%s ex mismatch' % c['id']
        assert c.get('exRu') == exs[0]['ru'], '%s exRu mismatch' % c['id']
        for j in range(len(exs)):
            for k in range(j + 1, len(exs)):
                assert not similar(exs[j]['en'], exs[k]['en']), (
                    '%s near-dup examples' % c['id'])
        lemmas.append(c['lemma'])
    assert len(lemmas) == len(set(lemmas)), 'duplicate lemmas'
    for path, label in ((A1, 'a1'), (A2, 'a2')):
        if path.exists():
            other = {c['lemma'] for c in json.loads(path.read_text(encoding='utf-8'))}
            overlap = other & set(lemmas)
            assert not overlap, 'overlap with %s: %s' % (label, sorted(overlap)[:10])
    return True


def main():
    cards = json.loads(DATA.read_text(encoding='utf-8'))
    batches = load_batches()
    missing = [c['id'] for c in cards if c['id'] not in batches]
    if missing:
        print('MISSING', len(missing), missing[:20])
        sys.exit(1)
    enriched = [normalize_card(c, batches[c['id']]) for c in cards]
    validate(enriched)
    ex_lens = [len(c['examples']) for c in enriched]
    colloc_n = sum(1 for c in enriched if (c.get('colloc') or '').strip())
    note_n = sum(1 for c in enriched if (c.get('note') or '').strip())
    pattern_n = sum(1 for c in enriched if (c.get('pattern') or '').strip())
    avg = sum(ex_lens) / len(ex_lens)
    DATA.write_text(json.dumps(enriched, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print('OK wrote', DATA)
    print('examples avg=%.2f min=%s max=%s' % (avg, min(ex_lens), max(ex_lens)))
    print('colloc=%s note=%s pattern=%s' % (colloc_n, note_n, pattern_n))


if __name__ == '__main__':
    main()
