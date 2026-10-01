#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Expand compact .tsv batches into batch_*.json for assemble.py"""
import json, sys
from pathlib import Path

def parse_line(line, default_pattern):
    line = line.strip()
    if not line or line.startswith('#'):
        return None
    parts = [p.strip() for p in line.split('|')]
    if len(parts) < 8:
        raise ValueError('need word|tr|level|en1|ru1|en2|ru2|en3|ru3… got %s fields: %s' % (len(parts), line[:80]))
    word, tr, level, en1, ru1, en2, ru2, en3, ru3 = parts[:9]
    note = parts[9] if len(parts) > 9 else ''
    partners = parts[10] if len(parts) > 10 else ''
    pattern = parts[11] if len(parts) > 11 else default_pattern
    exs = []
    for en, ru in ((en1, ru1), (en2, ru2), (en3, ru3)):
        if en and ru:
            exs.append({'en': en, 'ru': ru})
    if len(exs) < 2:
        raise ValueError('need >=2 examples: ' + word)
    row = {
        'word': word,
        'lemma': word.lower(),
        'level': level.lower(),
        'tr': tr,
        'examples': exs,
        'note': note,
        'colloc': partners,
        'pattern': pattern,
        'pos': 'collocation',
    }
    return row

def expand(src: Path, out: Path, default_pattern: str):
    rows = []
    for i, line in enumerate(src.read_text(encoding='utf-8').splitlines(), 1):
        try:
            row = parse_line(line, default_pattern)
        except ValueError as e:
            raise SystemExit(f'{src.name}:{i}: {e}')
        if row:
            rows.append(row)
    out.write_text(json.dumps(rows, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'{src.name} -> {out.name}: {len(rows)}')
    return len(rows)

if __name__ == '__main__':
    # usage: expand_tsv.py deckdir default_pattern
    deck = Path(sys.argv[1])
    pat = sys.argv[2]
    total = 0
    for tsv in sorted(deck.glob('src_*.tsv')):
        out = deck / ('batch_' + tsv.stem.replace('src_', '') + '.json')
        total += expand(tsv, out, pat)
    print('TOTAL', total)
