#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Convert TSV lines to batch JSON with IPA.
Line format:
word|pos|tr|bucket|e1|r1|e2|r2|e3|r3|colloc|[note]|[pattern]|[syn]|[ant]
"""
import sys, json
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
import eng_to_ipa as ipa

def to_ipa(word):
    raw = ipa.convert(word)
    if '*' in raw:  # unknown
        raw = raw.replace('*', '')
    raw = raw.strip()
    if not raw:
        raw = word
    return '/' + raw + '/'

def build(text, outpath):
    rows = []
    for line in text.strip().splitlines():
        if not line.strip() or line.startswith('#'):
            continue
        p = line.split('|')
        while len(p) < 15:
            p.append('')
        word, pos, tr, bucket = p[0].strip(), p[1].strip(), p[2].strip(), p[3].strip()
        e1,r1,e2,r2,e3,r3 = [x.strip() for x in p[4:10]]
        colloc, note, pattern, syn, ant = [x.strip() for x in p[10:15]]
        exs = []
        for en, ru in ((e1,r1),(e2,r2),(e3,r3)):
            if en and ru:
                exs.append({'en': en, 'ru': ru})
        row = {
            'word': word,
            'lemma': word.lower(),
            'ipa': to_ipa(word),
            'pos': pos,
            'tr': tr,
            'bucket': bucket or 'idea',
            'examples': exs,
            'colloc': colloc,
        }
        if note: row['note'] = note
        if pattern: row['pattern'] = pattern
        if syn: row['syn'] = syn
        if ant: row['ant'] = ant
        rows.append(row)
    Path(outpath).write_text(json.dumps(rows, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(Path(outpath).name, len(rows))
    return rows

if __name__ == '__main__':
    build(sys.stdin.read(), sys.argv[1])
