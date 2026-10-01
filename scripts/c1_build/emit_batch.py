#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Emit a batch JSON from a list of card dicts (word,pos,tr,examples,colloc,...)."""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from emit import emit

def bucket_for(pos):
    return {'verb':'action','adj':'emotion','adv':'idea','noun':'idea','prep':'idea','conj':'idea'}.get(pos,'idea')

def run(rows, outname):
    out = []
    for r in rows:
        r = dict(r)
        r.setdefault('bucket', bucket_for(r.get('pos','noun')))
        # normalize examples
        exs = r['examples']
        assert len(exs) >= 2, r['word']
        out.append(r)
    path = Path(__file__).resolve().parent / 'batches' / outname
    emit(out, path)
