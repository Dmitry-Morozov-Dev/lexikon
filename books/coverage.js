/**
 * Лексикон — «% знакомых слов» книги (покрытие текста, как в исследованиях чтения: 95–98% — комфортно).
 * Частоты считаются в Web Worker один раз и кэшируются в IndexedDB (meta: bookStats:<id>).
 * Знакомо: слово в любой колоде в состоянии known / review / hidden + служебные слова.
 * Не знакомо: новые, на изучении, сохранённые из книг. Имена собственные не учитываются.
 */
(function (global) {
  'use strict';

  var STATS_V = 1;
  var memStats = {};
  var known = null;
  var knownSig = '';

  function statsKey(id) { return 'bookStats:' + id; }
  function sigOf(meta) { return STATS_V + '|' + (meta.wordCount || 0) + '|' + (meta.textFix || 0); }

  function runWorker(id, chapters) {
    return new Promise(function (resolve, reject) {
      var w;
      try { w = new Worker('books/stats-worker.js'); } catch (e) { reject(e); return; }
      var done = false;
      var timer = setTimeout(function () { if (!done) { done = true; w.terminate(); reject(new Error('timeout')); } }, 60000);
      w.onmessage = function (e) {
        if (done) return;
        done = true; clearTimeout(timer); w.terminate();
        if (e.data && e.data.ok) resolve(e.data.stats); else reject(new Error((e.data && e.data.error) || 'worker'));
      };
      w.onerror = function (e) { if (done) return; done = true; clearTimeout(timer); w.terminate(); reject(new Error(e.message || 'worker error')); };
      w.postMessage({ id: id, chapters: chapters });
    });
  }

  async function getMeta(key) {
    try { return await LexDB.getMeta(key); } catch (e) { return null; }
  }
  async function setMeta(key, value) {
    try { await LexDB.setMeta(key, value); } catch (e) { /* ignore */ }
  }

  /** Частоты слов книги (из кэша или пересчёт в воркере). */
  async function ensureStats(meta) {
    var sig = sigOf(meta);
    var m = memStats[meta.id];
    if (m && m.sig === sig) return m.stats;
    var cached = await getMeta(statsKey(meta.id));
    if (cached && cached.sig === sig && cached.stats) {
      memStats[meta.id] = { sig: sig, stats: cached.stats };
      return cached.stats;
    }
    var content = await LexDB.getBookContent(meta.id);
    if (!content || !content.chapters) return null;
    var stats = await runWorker(meta.id, content.chapters);
    memStats[meta.id] = { sig: sig, stats: stats };
    await setMeta(statsKey(meta.id), { sig: sig, stats: stats, at: Date.now() });
    return stats;
  }

  var KNOWN_STATES = { known: true, review: true, hidden: true };

  /** Множество знакомых лемм/форм (по всем колодам). Пересобирается, если поменялся прогресс. */
  async function knownSet() {
    var progress = await LexDB.getAllProgress();
    var ids = {};
    var n = 0, last = 0;
    progress.forEach(function (p) {
      if (KNOWN_STATES[p.state]) { ids[p.id] = true; n++; last = Math.max(last, p.last || 0); }
    });
    var b = global.LexikonBridge;
    var all = b && b.allCards ? b.allCards() : [];
    var sig = n + ':' + last + ':' + all.length;
    if (known && sig === knownSig) return known;
    var set = {};
    var L = global.LexLemma;
    all.forEach(function (c) {
      if (!ids[c.id]) return;
      [c.word, c.lemma].forEach(function (w) {
        if (!w) return;
        String(w).split(/\s*[\/;,]\s*/).forEach(function (x) { var k = L.norm(x); if (k) set[k] = true; });
      });
    });
    // карточки книг (не загружены в колоды ленты, если книга «не в ленте») — из IDB
    try {
      var own = await LexDB.getAllCards();
      own.forEach(function (c) {
        if (!ids[c.id]) return;
        [c.word, c.lemma].forEach(function (w) { var k = w && L.norm(w); if (k) set[k] = true; });
      });
    } catch (e) { /* ignore */ }
    known = set;
    knownSig = sig;
    return set;
  }

  function isKnownGroup(g, set) {
    var L = global.LexLemma;
    if (L.isFunctionWord(g.w)) return true;
    for (var i = 0; i < g.k.length; i++) {
      if (set[g.k[i]] || L.isFunctionWord(g.k[i])) return true;
    }
    return false;
  }

  /** → {pct, knownTokens, total, unique, unknownUnique, names, top: [{w, n}]} */
  function compute(stats, set, topN) {
    var knownTokens = 0, unknownUnique = 0, top = [];
    stats.groups.forEach(function (g) {
      if (isKnownGroup(g, set)) knownTokens += g.n;
      else {
        unknownUnique++;
        if (top.length < (topN || 30) && g.w.length >= 3) top.push({ w: g.w, n: g.n });
      }
    });
    return {
      pct: stats.total ? knownTokens / stats.total : 0,
      knownTokens: knownTokens,
      total: stats.total,
      unique: stats.groups.length,
      unknownUnique: unknownUnique,
      names: stats.names,
      top: top
    };
  }

  async function coverageFor(meta, topN) {
    var stats = await ensureStats(meta);
    if (!stats) return null;
    var set = await knownSet();
    return compute(stats, set, topN);
  }

  function invalidateKnown() { known = null; knownSig = ''; }
  function forget(id) { delete memStats[id]; return setMeta(statsKey(id), null); }

  global.LexCoverage = {
    ensureStats: ensureStats,
    knownSet: knownSet,
    compute: compute,
    coverageFor: coverageFor,
    invalidateKnown: invalidateKnown,
    forget: forget
  };
})(typeof window !== 'undefined' ? window : self);
