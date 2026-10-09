/* Лексикон — Web Worker: частоты слов книги (для «% знакомых слов»). Тяжёлая часть вне UI-потока. */
/* global importScripts, LexLemma */
importScripts('../lemma.js');

self.onmessage = function (e) {
  var msg = e.data || {};
  try {
    var chapters = msg.chapters || [];
    var forms = {};      // lower → {n, lower: bool}
    var total = 0;
    var RE = /[A-Za-zÀ-ÖØ-öø-ÿĀ-ž]+(?:['’][A-Za-zÀ-ÖØ-öø-ÿĀ-ž]+)*/g;
    for (var c = 0; c < chapters.length; c++) {
      var paras = chapters[c].paras || [];
      for (var p = 0; p < paras.length; p++) {
        var t = typeof paras[p] === 'string' ? paras[p] : (paras[p] && paras[p].h) || '';
        var m;
        RE.lastIndex = 0;
        while ((m = RE.exec(t))) {
          var w = m[0];
          if (w.length === 1 && !/^[aAiI]$/.test(w)) continue;
          var low = LexLemma.norm(w);
          var f = forms[low] || (forms[low] = { n: 0, low: false });
          f.n++;
          if (w.charAt(0) === w.charAt(0).toLowerCase() || w === 'I') f.low = true;
          total++;
        }
      }
    }
    // имена собственные: форма ни разу не встретилась со строчной буквы
    var names = 0;
    var keys = Object.keys(forms);
    var real = {};
    keys.forEach(function (k) {
      if (!forms[k].low) { names += forms[k].n; return; }
      real[k] = forms[k].n;
    });
    // группировка форм в «семьи»: considered → consider, если consider тоже есть в тексте
    var groups = {};
    Object.keys(real).forEach(function (k) {
      var cands = LexLemma.candidates(k);
      var canon = k;
      for (var i = 1; i < cands.length; i++) if (real[cands[i]] != null) { canon = cands[i]; break; }
      var g = groups[canon] || (groups[canon] = { w: canon, n: 0, k: [] });
      g.n += real[k];
      cands.forEach(function (x) { if (g.k.indexOf(x) < 0) g.k.push(x); });
    });
    var list = Object.keys(groups).map(function (k) { return groups[k]; });
    list.sort(function (a, b) { return b.n - a.n; });
    self.postMessage({ id: msg.id, ok: true, stats: { total: total - names, names: names, groups: list } });
  } catch (err) {
    self.postMessage({ id: msg.id, ok: false, error: String(err && err.message || err) });
  }
};
