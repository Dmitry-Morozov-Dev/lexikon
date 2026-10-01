#!/usr/bin/env python3
"""Emit batch JSON from list of dicts; add IPA."""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from ipa_util import to_ipa

def emit(rows, outpath):
    out=[]
    for r in rows:
        word=r['word']
        exs=r['examples']
        assert len(exs)>=2 and all(e.get('en') and e.get('ru') for e in exs), word
        row={
            'word':word,'lemma':word.lower(),'ipa':to_ipa(word),'pos':r['pos'],
            'tr':r['tr'],'bucket':r.get('bucket','idea'),'examples':exs[:3],
            'colloc':r.get('colloc',''),
        }
        for k in ('note','pattern','syn','ant'):
            if r.get(k): row[k]=r[k]
        out.append(row)
    Path(outpath).write_text(json.dumps(out, ensure_ascii=False, indent=2)+'\n')
    print(Path(outpath).name, len(out))
