
def N(word, tr, e1, r1, e2, r2, e3, r3, colloc="", bucket="idea", note=""):
    d = {"word": word, "pos": "noun", "tr": tr, "bucket": bucket, "colloc": colloc,
         "examples": [{"en": e1, "ru": r1}, {"en": e2, "ru": r2}, {"en": e3, "ru": r3}]}
    if note:
        d["note"] = note
    return d

def A(word, tr, e1, r1, e2, r2, e3, r3, colloc="", bucket="emotion", note=""):
    d = {"word": word, "pos": "adj", "tr": tr, "bucket": bucket, "colloc": colloc,
         "examples": [{"en": e1, "ru": r1}, {"en": e2, "ru": r2}, {"en": e3, "ru": r3}]}
    if note:
        d["note"] = note
    return d

def D(word, tr, e1, r1, e2, r2, e3, r3, colloc="", bucket="idea", note=""):
    d = {"word": word, "pos": "adv", "tr": tr, "bucket": bucket, "colloc": colloc,
         "examples": [{"en": e1, "ru": r1}, {"en": e2, "ru": r2}, {"en": e3, "ru": r3}]}
    if note:
        d["note"] = note
    return d

def P(word, tr, e1, r1, e2, r2, e3, r3, colloc="", bucket="idea", note="", pos="prep"):
    d = {"word": word, "pos": pos, "tr": tr, "bucket": bucket, "colloc": colloc,
         "examples": [{"en": e1, "ru": r1}, {"en": e2, "ru": r2}, {"en": e3, "ru": r3}]}
    if note:
        d["note"] = note
    return d
