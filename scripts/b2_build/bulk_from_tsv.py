#!/usr/bin/env python3
"""Build batch JSON from compact TSV lines.
Format: word|pos|tr|bucket|e1|r1|e2|r2|e3|r3|colloc|[note]|[pattern]
"""
import sys, json
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from ipa_util import to_ipa

def build(text, outpath):
    rows = []
    for line in text.strip().splitlines():
        if not line.strip() or line.startswith('#'):
            continue
        p = line.split('|')
        while len(p) < 13:
            p.append('')
        word, pos, tr, bucket = [x.strip() for x in p[:4]]
        e1,r1,e2,r2,e3,r3 = [x.strip() for x in p[4:10]]
        colloc, note, pattern = [x.strip() for x in p[10:13]]
        exs = [{'en':a,'ru':b} for a,b in ((e1,r1),(e2,r2),(e3,r3)) if a and b]
        assert len(exs) >= 2, word
        row = {
            'word': word, 'lemma': word.lower(), 'ipa': to_ipa(word), 'pos': pos,
            'tr': tr, 'bucket': bucket or 'idea', 'examples': exs[:3], 'colloc': colloc,
        }
        if note: row['note'] = note
        if pattern: row['pattern'] = pattern
        rows.append(row)
    Path(outpath).write_text(json.dumps(rows, ensure_ascii=False, indent=2) + '\n')
    print(Path(outpath).name, len(rows))

if __name__ == '__main__':
    build(Path(sys.argv[1]).read_text(encoding='utf-8'), sys.argv[2])
