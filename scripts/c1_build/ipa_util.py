import eng_to_ipa as ipa
def to_ipa(word):
    raw = (ipa.convert(word) or '').replace('*','').strip() or word
    return '/' + raw + '/'
