/**
 * Лексикон — проверка введённого ответа (RU → EN).
 * Варианты: регистр, апострофы, артикли, «to» у глаголов, альтернативы через / , ; |,
 * BrE/AmE (colour/color, -ise/-ize, -yse/-yze, centre/center, travelled/traveled, catalogue/catalog),
 * другая форма того же слова (considered ~ consider). Опечатка (Дамерау–Левенштейн ≤1 при длине ≥5,
 * ≤2 при ≥10) — «почти».
 */
(function (global) {
  'use strict';

  function basic(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[’‘`´]/g, "'")
      .replace(/[“”«»"]/g, '')
      .replace(/\([^)]*\)/g, ' ')          // «(sb)», «(to)» и т. п. — необязательные части
      .replace(/[.!?…:]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  var OPTIONAL = /^(a|an|the|to)$/;
  var PLACEHOLDER = /^(sb|smb|sth|smth|someone|somebody|something|one's|oneself|sb's)$/;

  function strip(s) {
    var t = basic(s).split(' ').filter(function (w) { return w && !PLACEHOLDER.test(w); });
    while (t.length > 1 && OPTIONAL.test(t[0])) t.shift();
    return t.join(' ');
  }

  function canonWord(w) {
    return w
      .replace(/isation/g, 'ization').replace(/yse(s|d)?$/, 'yze$1')
      .replace(/is(e|es|ed|ing)$/, 'iz$1')
      .replace(/([^aeiou])tre(s)?$/, '$1ter$2')
      .replace(/ll(ed|ing|er|ers)$/, 'l$1')
      .replace(/ogue(s)?$/, 'og$1')
      .replace(/our(s|ed|ing|ful|ite|able)?$/, 'or$1')
      .replace(/ae/g, 'e');
  }
  function canon(s) { return strip(s).split(' ').map(canonWord).join(' '); }

  /** Расстояние Дамерау–Левенштейна (оптимальное выравнивание строк). */
  function dl(a, b) {
    var n = a.length, m = b.length, i, j;
    if (!n) return m; if (!m) return n;
    var d = [];
    for (i = 0; i <= n; i++) { d[i] = [i]; }
    for (j = 0; j <= m; j++) d[0][j] = j;
    for (i = 1; i <= n; i++) {
      for (j = 1; j <= m; j++) {
        var cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && a.charAt(i - 1) === b.charAt(j - 2) && a.charAt(i - 2) === b.charAt(j - 1)) {
          d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
        }
      }
    }
    return d[n][m];
  }

  function answersOf(card) {
    var list = [];
    [card.word, card.lemma].forEach(function (w) {
      String(w || '').split(/\s*[\/;|]\s*|\s*,\s*/).forEach(function (x) {
        x = x.trim();
        if (x && list.indexOf(x) < 0) list.push(x);
      });
    });
    return list;
  }

  /**
   * → { kind: 'ok'|'form'|'almost'|'wrong'|'empty', grade: 2|1|0, target, typed, note }
   */
  function check(typed, card) {
    var answers = answersOf(card);
    var t = strip(typed);
    var best = answers[0] || '';
    if (!t) return { kind: 'empty', grade: 0, target: best, typed: '' };
    var tc = canon(typed);
    var i;
    var noAp = function (x) { return x.replace(/'/g, ''); };
    for (i = 0; i < answers.length; i++) {
      if (strip(answers[i]) === t || noAp(strip(answers[i])) === noAp(t)) return { kind: 'ok', grade: 2, target: answers[i], typed: typed };
    }
    for (i = 0; i < answers.length; i++) {
      if (canon(answers[i]) === tc) return { kind: 'ok', grade: 2, target: answers[i], typed: typed, note: 'вариант написания (BrE/AmE)' };
    }
    var L = global.LexLemma;
    if (L) {
      for (i = 0; i < answers.length; i++) {
        var a = strip(answers[i]);
        if (a.indexOf(' ') < 0 && t.indexOf(' ') < 0 && (L.matches(t, a) || L.matches(a, t))) {
          return { kind: 'form', grade: 2, target: answers[i], typed: typed, note: 'другая форма слова' };
        }
      }
    }
    var bestD = Infinity;
    for (i = 0; i < answers.length; i++) {
      var dd = dl(t, strip(answers[i]));
      if (dd < bestD) { bestD = dd; best = answers[i]; }
    }
    var len = strip(best).length;
    var allow = len >= 10 ? 2 : len >= 5 ? 1 : 0;
    if (bestD <= allow) return { kind: 'almost', grade: 1, target: best, typed: typed, note: 'опечатка' };
    return { kind: 'wrong', grade: 0, target: best, typed: typed };
  }

  /**
   * Побуквенное сравнение (как у Lingvist): выравнивание typed ↔ target.
   * → [{ch, kind: 'ok'|'bad'|'miss'|'extra'}] — по символам ответа пользователя + пропущенные буквы.
   */
  function diff(typed, target) {
    var a = basic(typed), b = basic(target);
    var n = a.length, m = b.length, i, j;
    var d = [];
    for (i = 0; i <= n; i++) { d[i] = [i]; }
    for (j = 0; j <= m; j++) d[0][j] = j;
    for (i = 1; i <= n; i++) for (j = 1; j <= m; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1));
    }
    var out = [];
    i = n; j = m;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1)) {
        out.push({ ch: a.charAt(i - 1), kind: a.charAt(i - 1) === b.charAt(j - 1) ? 'ok' : 'bad', want: b.charAt(j - 1) });
        i--; j--;
      } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
        out.push({ ch: a.charAt(i - 1), kind: 'extra' });
        i--;
      } else {
        out.push({ ch: b.charAt(j - 1), kind: 'miss' });
        j--;
      }
    }
    return out.reverse();
  }

  global.LexTyping = { check: check, diff: diff, dl: dl, canon: canon, strip: strip, answersOf: answersOf };
})(typeof window !== 'undefined' ? window : self);
