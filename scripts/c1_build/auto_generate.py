#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Generate C1 cards: gloss overlay + Argos fallback; grammatical EN frames; Argos RU examples."""
from __future__ import annotations
import json, re, hashlib, sys, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from emit import emit
import argostranslate.translate as atr

BATCH = HERE / 'batches'
LEMMAS = HERE / 'c1_final_lemmas.json'
GLOSS_PATH = HERE / 'glosses.json'

def translate(text: str) -> str:
    try:
        return (atr.translate(text, 'en', 'ru') or '').strip()
    except Exception as e:
        print('TRERR', e, text[:60], file=sys.stderr)
        return ''

def hpick(word: str, options, salt: str = ''):
    h = int(hashlib.md5((word + '|' + salt).encode()).hexdigest(), 16)
    return options[h % len(options)]

def article(word: str) -> str:
    w = word.lstrip("'").lower()
    return 'an' if w[:1] in 'aeiou' else 'a'

# Diverse, grammatical frames — always insert word as a real constituent
NOUN_SETS = [
    ("Researchers examined the {w} closely.",
     "The {w} shaped the final decision.",
     "Without the {w}, the argument collapses."),
    ("They underestimated the {w}.",
     "A clear {w} emerged from the data.",
     "Address the {w} before it grows."),
    ("The report cites a striking {w}.",
     "Funding hinges on this {w}.",
     "Students often confuse {w} with related terms."),
    ("Her career turned on one {w}.",
     "Public debate ignored the {w}.",
     "Document every {w} in the log."),
    ("There was no simple {w}.",
     "Critics mocked the {w}.",
     "We need a working definition of {w}."),
]
VERB_SETS = [
    ("Please {w} the proposal carefully.",
     "They refuse to {w} without evidence.",
     "Leaders must {w} when stakes are high."),
    ("Can you {w} this for the board?",
     "Analysts {w} the numbers overnight.",
     "Do not {w} under political pressure."),
    ("She learned to {w} with precision.",
     "We will {w} the policy next quarter.",
     "Critics {w} the choice harshly."),
    ("Managers {w} resources each week.",
     "He tends to {w} too quickly.",
     "They {w} only after a full review."),
]
ADJ_SETS = [
    ("It was {a} {w} strategy.",
     "The tone grew {w}.",
     "They rejected the {w} proposal."),
    ("A {w} approach may help.",
     "His answer sounded {w}.",
     "Avoid {w} claims without proof."),
    ("The evidence is hardly {w}.",
     "She remained {w} under stress.",
     "Results looked only {w}."),
    ("Choose a less {w} option.",
     "The design feels {w}.",
     "A {w} policy risks backlash."),
]
ADV_SETS = [
    ("She spoke {w} about the issue.",
     "The team responded {w}.",
     "Progress moved {w} after the fix."),
    ("He argued {w} for reform.",
     "The rule was applied {w}.",
     "Costs rose {w} last year."),
    ("Handle the sample {w}.",
     "Support arrived {w}.",
     "The plan failed {w}."),
    ("Work continued {w} overnight.",
     "She answered {w} and clearly.",
     "The claim was {w} dismissed."),
]
PREP_SETS = [
    ("Keep the note {w} the file.",
     "Talks continued {w} closed doors.",
     "Nothing moves {w} consent."),
]
CONJ_SETS = [
    ("The fix worked, {w} slowly.",
     "He agreed, {w} with doubts.",
     "Useful, {w} imperfect."),
]

def sets_for(pos):
    return {
        'noun': NOUN_SETS, 'verb': VERB_SETS, 'adj': ADJ_SETS,
        'adv': ADV_SETS, 'prep': PREP_SETS, 'conj': CONJ_SETS,
    }.get(pos, NOUN_SETS)

def fill(tmpl: str, word: str) -> str:
    return tmpl.replace('{w}', word).replace('{a}', article(word)).replace('{W}', word[:1].upper()+word[1:])

def make_examples(word, pos):
    triple = hpick(word, sets_for(pos), 'ex')
    out = []
    for tmpl in triple:
        en = fill(tmpl, word)
        ru = translate(en)
        if not ru:
            ru = en  # last resort; polish later
        out.append({'en': en, 'ru': ru})
    return out

def gloss_for(word, pos, overlay):
    if word in overlay and overlay[word].strip():
        return overlay[word].strip()
    # Argos with light prompting by POS
    if pos == 'verb':
        g = translate(f'to {word}')
    elif pos == 'adv':
        g = translate(word)
    elif pos == 'adj':
        g = translate(word)
    else:
        g = translate(f'the {word}')
    g = (g or '').strip()
    g = re.sub(r'^(to|the|a|an)\s+', '', g, flags=re.I).strip()
    # drop trailing punctuation
    g = g.strip(' .;:')
    return g or word

def colloc(word, pos):
    if pos == 'verb':
        return f"{hpick(word,[f'{word} carefully', f'{word} the claim', f'{word} pressure'],'c1')} · {hpick(word,[f'{word} + N', f'refuse to {word}'],'c2')}"
    if pos == 'adj':
        return f"{hpick(word,[f'highly {word}', f'{word} approach', f'{word} tone'],'c1')} · {hpick(word,[f'remain {word}', f'{word} result'],'c2')}"
    if pos == 'adv':
        return f"{hpick(word,[f'speak {word}', f'act {word}', f'respond {word}'],'c1')} · {word}"
    if pos == 'noun':
        return f"{hpick(word,[f'the {word}', f'clear {word}', f'growing {w}' if False else f'clear {word}'],'c1')} · {hpick(word,[f'{word} of', f'address the {word}'],'c2')}"
    return word

def pattern(word, pos):
    if pos != 'verb':
        return None
    return hpick(word, [f'{word} + N', f'{word} + that', f'{word} (+ prep)', f'{word} + to-INF'], 'pat')

def bucket(pos):
    return {'verb':'action','adj':'emotion','adv':'idea','noun':'idea','prep':'idea','conj':'idea'}.get(pos,'idea')

def load_done():
    done=set()
    for p in sorted(BATCH.glob('batch_*.json')):
        for c in json.loads(p.read_text(encoding='utf-8')):
            done.add(c['lemma'].lower())
    return done

def main(limit=None, batch_size=50, start_idx=1):
    overlay = {}
    if GLOSS_PATH.exists():
        overlay = json.loads(GLOSS_PATH.read_text(encoding='utf-8'))
    lemmas = json.loads(LEMMAS.read_text(encoding='utf-8'))
    done = load_done()
    pending = [x for x in lemmas if x['lemma'] not in done]
    print(f'pending={len(pending)} done={len(done)} gloss_overlay={len(overlay)}')
    if limit:
        pending = pending[:limit]
    batch_i = start_idx
    # find next free batch_a index
    existing = list(BATCH.glob('batch_a*.json'))
    if existing:
        nums = []
        for p in existing:
            m = re.search(r'batch_a(\d+)', p.name)
            if m: nums.append(int(m.group(1)))
        if nums:
            batch_i = max(nums) + 1
    buf = []
    t0 = time.time()
    for i, item in enumerate(pending, 1):
        w = item['lemma']
        pos = item['pos']
        if pos not in {'noun','verb','adj','adv','prep','conj'}:
            pos = 'noun'
        tr = gloss_for(w, pos, overlay)
        exs = make_examples(w, pos)
        row = {
            'word': w,
            'pos': pos,
            'tr': tr,
            'bucket': bucket(pos),
            'examples': exs,
            'colloc': colloc(w, pos),
        }
        pat = pattern(w, pos)
        if pat:
            row['pattern'] = pat
        buf.append(row)
        if len(buf) >= batch_size:
            name = f'batch_a{batch_i:02d}.json'
            emit(buf, BATCH / name)
            elapsed = time.time() - t0
            print(f'wrote {name} n={len(buf)} i={i}/{len(pending)} elapsed={elapsed:.0f}s', flush=True)
            buf = []
            batch_i += 1
    if buf:
        name = f'batch_a{batch_i:02d}.json'
        emit(buf, BATCH / name)
        print(f'wrote {name} n={len(buf)}', flush=True)
    print('DONE', flush=True)

if __name__ == '__main__':
    lim = int(sys.argv[1]) if len(sys.argv) > 1 else None
    bs = int(sys.argv[2]) if len(sys.argv) > 2 else 50
    main(limit=lim, batch_size=bs)
