import json
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
cards = json.load(open(ROOT / 'data' / 'b1.json'))
by_lem = {c['lemma']: c for c in cards}
by_word = {c['word'].lower(): c for c in cards}

def build(block, outfile):
    M = {}
    for line in block.strip().splitlines():
        if not line.strip() or line.startswith('#'):
            continue
        parts = line.split('|')
        lem = parts[0]
        c = by_lem.get(lem) or by_word.get(lem)
        if not c:
            print('MISS', lem)
            continue
        e2, r2, e3, r3 = parts[1], parts[2], parts[3], parts[4]
        colloc = parts[5] if len(parts) > 5 else ''
        note = parts[6] if len(parts) > 6 else ''
        pattern = parts[7] if len(parts) > 7 else ''
        syn = parts[8] if len(parts) > 8 else ''
        ant = parts[9] if len(parts) > 9 else ''
        if not colloc:
            colloc = c.get('colloc') or ''
        # Keep original as [0]; e2/e3 must differ
        exs = [{'en': c['ex'], 'ru': c['exRu']}]
        for en, ru in ((e2, r2), (e3, r3)):
            if en.strip() and en.strip().lower() != c['ex'].strip().lower():
                exs.append({'en': en.strip(), 'ru': ru.strip()})
        if len(exs) < 2:
            print('NEED MORE', lem)
            continue
        payload = {'examples': exs[:3]}
        if colloc:
            payload['colloc'] = colloc
        if note:
            payload['note'] = note
        if pattern:
            payload['pattern'] = pattern
        if syn:
            payload['syn'] = syn
        if ant:
            payload['ant'] = ant
        M[c['id']] = payload
    Path(outfile).write_text(json.dumps(M, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(Path(outfile).name, len(M))
    return M
