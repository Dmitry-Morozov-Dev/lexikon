/**
 * Лексикон — чтение PDF (STAGE A + B + C).
 * Извлечение текста через pdf.js, IDB documents, ридер.
 * Long-press → bubble + карточка в колоду файла; lookup / MyMemory.
 */
(function (global) {
  'use strict';

  var PDFJS_VERSION = '6.3.289';
  var PDFJS_BASE = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@' + PDFJS_VERSION + '/build/';
  var PDFJS_MAIN = PDFJS_BASE + 'pdf.min.mjs';
  var PDFJS_WORKER = PDFJS_BASE + 'pdf.worker.min.mjs';

  var HOLD_MS = 500;
  var HOLD_MOVE_CANCEL_PX = 10;

  var pdfjsLib = null;
  var pdfjsLoading = null;
  var currentDocId = null;
  var bound = false;
  var holdState = null;
  var activeSpan = null;
  var bubbleEl = null;
  var bubbleCardId = null;
  var translateCache = new Map();

  function $(id) { return document.getElementById(id); }

  function bridge() {
    return global.LexikonBridge || null;
  }

  function toast(msg, kind) {
    var b = bridge();
    if (b && typeof b.toast === 'function') {
      b.toast(msg, kind);
      return;
    }
    var host = $('toast-host');
    if (!host) return;
    var t = document.createElement('div');
    t.className = 'toast' + (kind ? ' ' + kind : '');
    t.textContent = msg;
    host.appendChild(t);
    setTimeout(function () {
      t.style.opacity = '0';
      setTimeout(function () { t.remove(); }, 220);
    }, 3200);
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function uid(prefix) {
    return (prefix || 'doc') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  }

  function formatWordCount(n) {
    n = n || 0;
    var mod10 = n % 10;
    var mod100 = n % 100;
    var word;
    if (mod10 === 1 && mod100 !== 11) word = 'слово';
    else if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) word = 'слова';
    else word = 'слов';
    return n.toLocaleString('ru-RU') + ' ' + word;
  }

  function titleFromFileName(name) {
    var base = String(name || 'Документ').replace(/\.pdf$/i, '').trim();
    return base || 'Документ';
  }

  function softVibrate() {
    try {
      if (navigator.vibrate) navigator.vibrate(12);
    } catch (e) { /* ignore */ }
  }

  /* ---- Text cleanup ---- */

  function cleanupText(raw) {
    var t = String(raw || '');
    t = t.replace(/\f+/g, '\n');
    t = t.replace(/\u00ad+/g, '');
    t = t.replace(/\r\n?/g, '\n');
    t = t.replace(/([A-Za-zА-Яа-яЁё])-\n([A-Za-zА-Яа-яЁё])/g, '$1$2');
    t = t.replace(/[ \t\u00a0\u2000-\u200b]+/g, ' ');
    t = t.split('\n').map(function (line) { return line.trim(); }).join('\n');
    t = t.replace(/([^\n])\n(?!\n)/g, '$1 ');
    t = t.replace(/[ \t]+/g, ' ');
    t = t.replace(/\n{3,}/g, '\n\n');
    return t.trim();
  }

  function countWords(text) {
    var m = String(text || '').match(/[A-Za-zА-Яа-яЁё0-9]+(?:['’-][A-Za-zА-Яа-яЁё0-9]+)*/g);
    return m ? m.length : 0;
  }

  /* ---- pdf.js text extraction ---- */

  function pageItemsToText(items) {
    var out = '';
    var lastY = null;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it || typeof it.str !== 'string') continue;
      var y = it.transform ? it.transform[5] : null;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 6) {
        if (out && !/\n$/.test(out)) out += '\n';
      } else if (out && !/\s$/.test(out) && it.str.length && !/^\s/.test(it.str)) {
        if (!/^[,.;:!?…)\]}'"»%]/.test(it.str)) {
          out += ' ';
        }
      }
      out += it.str;
      if (it.hasEOL) out += '\n';
      if (y !== null) lastY = y;
    }
    return out;
  }

  function loadPdfJs() {
    if (pdfjsLib) return Promise.resolve(pdfjsLib);
    if (pdfjsLoading) return pdfjsLoading;
    pdfjsLoading = import(/* webpackIgnore: true */ PDFJS_MAIN).then(function (mod) {
      pdfjsLib = mod;
      if (pdfjsLib.GlobalWorkerOptions) {
        pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      }
      return pdfjsLib;
    }).catch(function (err) {
      pdfjsLoading = null;
      throw err;
    });
    return pdfjsLoading;
  }

  async function extractTextFromPdf(file) {
    var lib = await loadPdfJs();
    var buf = await file.arrayBuffer();
    var pdf = await lib.getDocument({ data: buf }).promise;
    var parts = [];
    for (var pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      var page = await pdf.getPage(pageNum);
      var content = await page.getTextContent();
      parts.push(pageItemsToText(content.items || []));
      if (typeof page.cleanup === 'function') page.cleanup();
    }
    try {
      if (typeof pdf.cleanup === 'function') pdf.cleanup();
      if (typeof pdf.destroy === 'function') {
        var d = pdf.destroy();
        if (d && typeof d.then === 'function') await d;
      }
    } catch (e) { /* ignore cleanup */ }
    return cleanupText(parts.join('\n\n'));
  }

  /* ---- Lemma / sentence helpers ---- */

  function normalizeLemma(surface) {
    return String(surface || '')
      .replace(/^[^A-Za-zÀ-ÖØ-öø-ÿĀ-žА-Яа-яЁё0-9]+|[^A-Za-zÀ-ÖØ-öø-ÿĀ-žА-Яа-яЁё0-9]+$/g, '')
      .toLowerCase();
  }

  function lemmaSlug(lemma) {
    return String(lemma || '')
      .toLowerCase()
      .replace(/['’]/g, '')
      .replace(/[^a-z0-9а-яё]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'word';
  }

  function spanOffsetInParagraph(span) {
    var p = span.closest('.reader-p');
    if (!p) return { text: span.textContent || '', offset: 0 };
    var text = p.textContent || '';
    var range = document.createRange();
    range.selectNodeContents(p);
    range.setEnd(span, 0);
    var offset = range.toString().length;
    return { text: text, offset: offset, para: p };
  }

  function extractSentence(fullText, offset, wordLen) {
    var text = String(fullText || '');
    if (!text) return '';
    var enders = /[.!?…]/g;
    var start = 0;
    var m;
    enders.lastIndex = 0;
    while ((m = enders.exec(text)) !== null) {
      if (m.index + m[0].length <= offset) {
        start = m.index + m[0].length;
      } else {
        break;
      }
    }
    while (start < text.length && /\s/.test(text.charAt(start))) start++;

    var end = text.length;
    enders.lastIndex = offset + (wordLen || 0);
    var found = enders.exec(text);
    if (found) end = found.index + found[0].length;

    var sentence = text.slice(start, end).trim();
    // Reasonable bounds
    if (sentence.length > 320) {
      var mid = offset - start;
      var lo = Math.max(0, mid - 140);
      var hi = Math.min(sentence.length, mid + 180);
      sentence = (lo > 0 ? '…' : '') + sentence.slice(lo, hi).trim() + (hi < sentence.length ? '…' : '');
    }
    if (sentence.length < 2) {
      // fallback: ~words around
      var a = Math.max(0, offset - 60);
      var b = Math.min(text.length, offset + (wordLen || 0) + 60);
      sentence = text.slice(a, b).trim();
    }
    return sentence;
  }

  /* ---- Translate (MyMemory) ---- */

  function cacheKey(q, pair) {
    return pair + '::' + String(q || '').trim().toLowerCase();
  }

  async function translateEnRu(text) {
    var q = String(text || '').trim();
    if (!q) return { text: '', offline: false };
    var key = cacheKey(q, 'en|ru');
    if (translateCache.has(key)) {
      return { text: translateCache.get(key), offline: false, cached: true };
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return { text: '', offline: true };
    }
    try {
      var url = 'https://api.mymemory.translated.net/get?q=' +
        encodeURIComponent(q.slice(0, 450)) + '&langpair=en|ru';
      var res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();
      var tr = (data && data.responseData && data.responseData.translatedText) || '';
      // MyMemory sometimes echoes the source on failure / quota
      if (!tr || tr.toLowerCase() === q.toLowerCase()) {
        var status = data && data.responseStatus;
        if (status && status !== 200) throw new Error('translate status ' + status);
      }
      tr = String(tr || '').trim();
      if (tr) translateCache.set(key, tr);
      return { text: tr, offline: false };
    } catch (err) {
      console.warn('translate failed', err);
      return { text: '', offline: true };
    }
  }

  /* ---- Lexicon lookup + card build ---- */

  function lookupSurface(surface) {
    var b = bridge();
    if (b && typeof b.lookup === 'function') {
      return b.lookup(surface);
    }
    return null;
  }

  function extLinksHtml(word, lemma) {
    var b = bridge();
    var links = (b && typeof b.buildExtLinks === 'function')
      ? b.buildExtLinks(word, lemma)
      : [
        { label: 'Google', href: 'https://www.google.com/search?q=' + encodeURIComponent('define ' + word) },
        { label: 'Reverso', href: 'https://context.reverso.net/translation/english-russian/' + encodeURIComponent(word) },
        { label: 'YouGlish', href: 'https://youglish.com/pronounce/' + encodeURIComponent(word) + '/english/us' },
        { label: 'Cambridge', href: 'https://dictionary.cambridge.org/dictionary/english/' + encodeURIComponent(lemma || word) }
      ];
    return links.map(function (L) {
      return '<a class="ext-pill" href="' + escapeHtml(L.href) +
        '" target="_blank" rel="noopener noreferrer">' + escapeHtml(L.label) + '</a>';
    }).join('');
  }

  function mergeExamples(sentenceEn, sentenceRu, fromCard) {
    var examples = [];
    if (sentenceEn) {
      examples.push({ en: sentenceEn, ru: sentenceRu || '' });
    }
    var src = [];
    if (fromCard) {
      if (Array.isArray(fromCard.examples) && fromCard.examples.length) {
        src = fromCard.examples;
      } else if (fromCard.ex || fromCard.exRu) {
        src = [{ en: fromCard.ex || '', ru: fromCard.exRu || '' }];
      }
    }
    src.forEach(function (ex) {
      if (!ex) return;
      var en = (ex.en || '').trim();
      var ru = (ex.ru || '').trim();
      if (!en && !ru) return;
      if (sentenceEn && en === sentenceEn) return;
      examples.push({ en: en, ru: ru });
    });
    return examples.slice(0, 6);
  }

  async function resolveTranslations(surface, sentence, hit) {
    var tr = '';
    var sentenceRu = '';
    var note = '';
    var fromLex = false;

    if (hit && hit.card) {
      fromLex = true;
      tr = hit.card.tr || '';
      // Prefer an example RU matching sentence if present; else first example RU
      if (Array.isArray(hit.card.examples)) {
        var matchEx = hit.card.examples.find(function (e) {
          return e && e.en && e.en.trim() === sentence;
        });
        if (matchEx && matchEx.ru) sentenceRu = matchEx.ru;
      }
    }

    var needWord = !tr;
    var needSent = !sentenceRu && !!sentence;

    if (needWord || needSent) {
      if (needSent) {
        var sRes = await translateEnRu(sentence);
        if (sRes.offline && !sRes.text) {
          note = 'перевод недоступен офлайн';
        } else {
          sentenceRu = sRes.text || '';
        }
      }
      if (needWord) {
        var wRes = await translateEnRu(surface);
        if (wRes.offline && !wRes.text) {
          if (!note) note = 'перевод недоступен офлайн';
          tr = '—';
        } else {
          tr = wRes.text || '—';
        }
      }
    }

    return { tr: tr, sentenceRu: sentenceRu, note: note, fromLex: fromLex };
  }

  async function savePdfCard(opts) {
    var docId = opts.docId;
    var surface = opts.surface;
    var lemma = opts.lemma || normalizeLemma(surface);
    var sentence = opts.sentence || '';
    var hit = opts.hit;
    var trInfo = opts.trInfo;

    var cardId = 'pdf-' + docId + '-' + lemmaSlug(lemma);
    var existing = null;
    try {
      existing = await LexDB.getCard(cardId);
    } catch (e) { /* ignore */ }

    var already = !!existing;
    var from = hit && hit.card ? hit.card : null;
    var examples = mergeExamples(sentence, trInfo.sentenceRu, from || existing);

    // If enriching existing: keep older examples too
    if (existing && Array.isArray(existing.examples)) {
      existing.examples.forEach(function (ex) {
        if (!ex || !ex.en) return;
        if (examples.some(function (e) { return e.en === ex.en; })) return;
        examples.push(ex);
      });
      examples = examples.slice(0, 6);
    }

    var primary = examples[0] || { en: sentence, ru: trInfo.sentenceRu || '' };
    var card = {
      id: cardId,
      word: surface,
      lemma: lemma,
      ipa: (from && from.ipa) || (existing && existing.ipa) || '',
      pos: (from && from.pos) || (existing && existing.pos) || 'other',
      level: (from && from.level) || (existing && existing.level) || 'pdf',
      tr: trInfo.tr || (existing && existing.tr) || '—',
      note: trInfo.note || (from && from.note) || (existing && existing.note) || '',
      ex: primary.en || '',
      exRu: primary.ru || '',
      examples: examples,
      colloc: (from && (from.colloc || from.collocs)) || (existing && existing.colloc) || '',
      collocs: (from && from.collocs) || (existing && existing.collocs) || undefined,
      pattern: (from && from.pattern) || (existing && existing.pattern) || '',
      syn: (from && from.syn) || (existing && existing.syn) || '',
      ant: (from && from.ant) || (existing && existing.ant) || '',
      rank: (from && from.rank) || (existing && existing.rank) || undefined,
      img: (existing && existing.img) || '',
      imgSrc: (existing && existing.imgSrc) || 'letter',
      imgAlt: surface,
      source: 'pdf',
      deckId: 'pdf:' + docId,
      docId: docId,
      contextSentence: sentence,
      contextSentenceRu: trInfo.sentenceRu || (existing && existing.contextSentenceRu) || '',
      updatedAt: Date.now(),
      createdAt: (existing && existing.createdAt) || Date.now()
    };

    var b = bridge();
    if (b && typeof b.putCard === 'function') {
      await b.putCard(card);
    } else {
      await LexDB.putCard(card);
      await LexDB.ensureProgress(card.id);
    }

    return { card: card, already: already };
  }

  /* ---- Bubble UI ---- */

  function ensureBubbleHost() {
    if (bubbleEl && bubbleEl.isConnected) return bubbleEl;
    var overlay = $('reader-overlay');
    bubbleEl = document.createElement('div');
    bubbleEl.id = 'rw-bubble';
    bubbleEl.className = 'rw-bubble hidden';
    bubbleEl.setAttribute('role', 'dialog');
    bubbleEl.setAttribute('aria-live', 'polite');
    (overlay || document.body).appendChild(bubbleEl);
    return bubbleEl;
  }

  function closeBubble() {
    if (bubbleEl) {
      bubbleEl.classList.add('hidden');
      bubbleEl.innerHTML = '';
    }
    bubbleCardId = null;
    if (activeSpan) {
      activeSpan.classList.remove('rw-active');
      activeSpan = null;
    }
  }

  function positionBubble(anchorEl) {
    var el = ensureBubbleHost();
    el.classList.remove('hidden');
    // Measure after content
    var rect = anchorEl.getBoundingClientRect();
    var bw = el.offsetWidth || 280;
    var bh = el.offsetHeight || 160;
    var margin = 10;
    var vw = window.innerWidth;
    var vh = window.innerHeight;

    var left = rect.left + rect.width / 2 - bw / 2;
    left = Math.max(margin, Math.min(left, vw - bw - margin));

    var top = rect.bottom + 8;
    var flip = false;
    if (top + bh > vh - margin && rect.top - 8 - bh > margin) {
      top = rect.top - 8 - bh;
      flip = true;
    }
    top = Math.max(margin, Math.min(top, vh - bh - margin));

    el.style.left = Math.round(left) + 'px';
    el.style.top = Math.round(top) + 'px';
    el.classList.toggle('rw-bubble-flip', flip);
  }

  function renderBubble(data) {
    var el = ensureBubbleHost();
    var status = data.already
      ? 'Уже в колоде'
      : 'Добавлено в колоду файла';
    var trLine = data.tr || '—';
    var offlineNote = data.note
      ? '<div class="rw-bubble-note">' + escapeHtml(data.note) + '</div>'
      : '';
    var delBtn = data.already
      ? '<button type="button" class="btn btn-ghost rw-bubble-del" data-action="delete">Удалить из колоды</button>'
      : '';

    el.innerHTML =
      '<div class="rw-bubble-inner">' +
      '<div class="rw-bubble-head">' +
      '<strong class="rw-bubble-word">' + escapeHtml(data.word) + '</strong>' +
      '<span class="rw-bubble-tr">' + escapeHtml(trLine) + '</span>' +
      '</div>' +
      '<div class="rw-bubble-sent">' +
      '<div class="rw-bubble-sent-en">' + escapeHtml(data.sentence) + '</div>' +
      (data.sentenceRu
        ? '<div class="rw-bubble-sent-ru">' + escapeHtml(data.sentenceRu) + '</div>'
        : '') +
      '</div>' +
      offlineNote +
      '<div class="rw-bubble-status' + (data.already ? ' is-dup' : '') + '">' +
      escapeHtml(status) +
      (data.fromLex ? ' · из лексикона' : '') +
      '</div>' +
      '<div class="rw-bubble-links card-links">' + extLinksHtml(data.word, data.lemma) + '</div>' +
      delBtn +
      '</div>';

    bubbleCardId = data.cardId;
    positionBubble(data.anchor);

    var del = el.querySelector('[data-action="delete"]');
    if (del) {
      del.addEventListener('click', async function (e) {
        e.preventDefault();
        e.stopPropagation();
        try {
          var b = bridge();
          if (b && typeof b.deleteCard === 'function') {
            await b.deleteCard(data.cardId);
          } else {
            await LexDB.deleteCard(data.cardId);
          }
          if (data.anchor) data.anchor.classList.remove('rw-saved', 'rw-active');
          await markSavedWords(currentDocId);
          closeBubble();
          toast('Удалено из колоды', 'ok');
        } catch (err) {
          toast('Не удалось удалить: ' + err.message, 'error');
        }
      });
    }
  }

  async function markSavedWords(docId) {
    var body = $('reader-body');
    if (!body || !docId) return;
    var cards = [];
    try {
      cards = await LexDB.getCardsByDeck('pdf:' + docId);
    } catch (e) {
      return;
    }
    var set = {};
    cards.forEach(function (c) {
      var lem = normalizeLemma(c.lemma || c.word || '');
      var w = normalizeLemma(c.word || '');
      if (lem) set[lem] = true;
      if (w) set[w] = true;
      var b = bridge();
      if (b && typeof b.lemmaCandidates === 'function') {
        b.lemmaCandidates(lem || w).forEach(function (x) { set[x] = true; });
      }
    });
    body.querySelectorAll('.rw').forEach(function (span) {
      var raw = normalizeLemma(span.getAttribute('data-w') || span.textContent || '');
      var saved = !!set[raw];
      if (!saved && bridge() && bridge().lemmaCandidates) {
        saved = bridge().lemmaCandidates(raw).some(function (x) { return set[x]; });
      }
      span.classList.toggle('rw-saved', saved);
    });
  }

  async function onWordHold(span) {
    if (!currentDocId || !span) return;
    var surface = (span.getAttribute('data-w') || span.textContent || '').trim();
    if (!surface) return;
    // Skip pure numbers
    if (/^[0-9]+(?:[.,][0-9]+)*$/.test(surface)) return;

    softVibrate();
    if (activeSpan && activeSpan !== span) activeSpan.classList.remove('rw-active');
    activeSpan = span;
    span.classList.add('rw-active');

    var lemma = normalizeLemma(surface);
    var pos = spanOffsetInParagraph(span);
    var sentence = extractSentence(pos.text, pos.offset, surface.length);
    var hit = lookupSurface(surface);

    // Show loading bubble quickly
    renderBubble({
      word: surface,
      lemma: lemma,
      tr: '…',
      sentence: sentence,
      sentenceRu: '',
      already: false,
      fromLex: !!(hit && hit.card),
      note: '',
      cardId: null,
      anchor: span
    });
    var statusEl = bubbleEl && bubbleEl.querySelector('.rw-bubble-status');
    if (statusEl) statusEl.textContent = 'Сохраняем…';

    try {
      var trInfo = await resolveTranslations(surface, sentence, hit);
      if (activeSpan !== span) return; // superseded
      var saved = await savePdfCard({
        docId: currentDocId,
        surface: surface,
        lemma: (hit && hit.query) || lemma,
        sentence: sentence,
        hit: hit,
        trInfo: trInfo
      });
      if (activeSpan !== span) return;
      span.classList.add('rw-saved');
      renderBubble({
        word: surface,
        lemma: saved.card.lemma,
        tr: saved.card.tr,
        sentence: sentence,
        sentenceRu: saved.card.contextSentenceRu || trInfo.sentenceRu || '',
        already: saved.already,
        fromLex: trInfo.fromLex,
        note: trInfo.note,
        cardId: saved.card.id,
        anchor: span
      });
    } catch (err) {
      console.error(err);
      toast('Не удалось сохранить: ' + (err && err.message ? err.message : String(err)), 'error');
      closeBubble();
    }
  }

  /* ---- Long-press gesture (delegation) ---- */

  function clearHold() {
    if (holdState && holdState.timer) {
      clearTimeout(holdState.timer);
    }
    holdState = null;
  }

  function onPointerDown(e) {
    if (!currentDocId) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    var span = e.target && e.target.closest ? e.target.closest('.rw') : null;
    if (!span || !span.closest('#reader-body')) return;

    clearHold();
    var startX = e.clientX;
    var startY = e.clientY;
    var pointerId = e.pointerId;
    holdState = {
      span: span,
      startX: startX,
      startY: startY,
      pointerId: pointerId,
      timer: setTimeout(function () {
        if (!holdState || holdState.span !== span) return;
        holdState.timer = null;
        holdState.fired = true;
        onWordHold(span);
      }, HOLD_MS)
    };
  }

  function onPointerMove(e) {
    if (!holdState || holdState.fired) return;
    if (holdState.pointerId != null && e.pointerId !== holdState.pointerId) return;
    var dx = e.clientX - holdState.startX;
    var dy = e.clientY - holdState.startY;
    if (Math.abs(dx) > HOLD_MOVE_CANCEL_PX || Math.abs(dy) > HOLD_MOVE_CANCEL_PX) {
      clearHold();
    }
  }

  function onPointerUp(e) {
    if (!holdState) return;
    if (holdState.pointerId != null && e.pointerId !== holdState.pointerId) return;
    if (!holdState.fired) clearHold();
    else holdState = null;
  }

  function onPointerCancel() {
    clearHold();
  }

  function onDocClick(e) {
    if (!bubbleEl || bubbleEl.classList.contains('hidden')) return;
    if (bubbleEl.contains(e.target)) return;
    if (e.target && e.target.closest && e.target.closest('.rw-active')) return;
    closeBubble();
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      if (bubbleEl && !bubbleEl.classList.contains('hidden')) {
        e.preventDefault();
        e.stopPropagation();
        closeBubble();
        return;
      }
      if (currentDocId) closeReader();
    }
  }

  function onContextMenu(e) {
    if (e.target && e.target.closest && e.target.closest('.rw')) {
      e.preventDefault();
    }
  }

  /* ---- Render reader body (paragraphs + word spans) ---- */

  var WORD_RE = /[A-Za-zÀ-ÖØ-öø-ÿĀ-žА-Яа-яЁё]+(?:['’][A-Za-zÀ-ÖØ-öø-ÿĀ-žА-Яа-яЁё]+)?|[0-9]+(?:[.,][0-9]+)*/g;

  function wrapParagraphHtml(para) {
    if (!para) return '';
    var html = '';
    var last = 0;
    var m;
    WORD_RE.lastIndex = 0;
    while ((m = WORD_RE.exec(para)) !== null) {
      if (m.index > last) {
        html += escapeHtml(para.slice(last, m.index));
      }
      html += '<span class="rw" data-w="' + escapeHtml(m[0]) + '">' + escapeHtml(m[0]) + '</span>';
      last = m.index + m[0].length;
    }
    if (last < para.length) html += escapeHtml(para.slice(last));
    return html;
  }

  function renderReaderText(text) {
    var body = $('reader-body');
    if (!body) return;
    closeBubble();
    body.innerHTML = '';
    var paras = String(text || '').split(/\n\n+/);
    var frag = document.createDocumentFragment();
    paras.forEach(function (p) {
      p = p.trim();
      if (!p) return;
      var el = document.createElement('p');
      el.className = 'reader-p';
      el.innerHTML = wrapParagraphHtml(p);
      frag.appendChild(el);
    });
    if (!frag.childNodes.length) {
      var empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = 'В этом PDF не удалось извлечь текст (возможно, это скан без OCR).';
      frag.appendChild(empty);
    }
    body.appendChild(frag);
  }

  /* ---- Overlay ---- */

  async function openReader(doc) {
    currentDocId = doc.id;
    var overlay = $('reader-overlay');
    var title = $('reader-title');
    var meta = $('reader-meta');
    if (!overlay) return;
    if (title) title.textContent = doc.title || 'Документ';
    if (meta) {
      meta.textContent = formatWordCount(doc.wordCount || countWords(doc.text));
    }
    renderReaderText(doc.text || '');
    overlay.classList.remove('hidden');
    overlay.setAttribute('aria-hidden', 'false');
    document.body.classList.add('reader-open');
    var scroll = $('reader-scroll');
    if (scroll) scroll.scrollTop = 0;
    await markSavedWords(doc.id);
  }

  function closeReader() {
    closeBubble();
    clearHold();
    var overlay = $('reader-overlay');
    if (!overlay) return;
    overlay.classList.add('hidden');
    overlay.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('reader-open');
    currentDocId = null;
    var body = $('reader-body');
    if (body) body.innerHTML = '';
  }

  /* ---- Document list ---- */

  async function refreshList() {
    var list = $('pdf-doc-list');
    var empty = $('pdf-empty');
    if (!list) return;
    var docs;
    try {
      docs = await LexDB.getAllDocuments();
    } catch (err) {
      toast('Ошибка списка PDF: ' + err.message, 'error');
      return;
    }
    docs.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
    list.innerHTML = '';
    if (!docs.length) {
      if (empty) empty.classList.remove('hidden');
      return;
    }
    if (empty) empty.classList.add('hidden');

    docs.forEach(function (doc) {
      var item = document.createElement('div');
      item.className = 'pdf-doc-item';
      item.setAttribute('data-id', doc.id);

      var info = document.createElement('div');
      info.className = 'pdf-doc-info';
      info.innerHTML =
        '<strong class="pdf-doc-title">' + escapeHtml(doc.title || 'Документ') + '</strong>' +
        '<small>' + escapeHtml(formatWordCount(doc.wordCount)) +
        (doc.sourceName ? ' · ' + escapeHtml(doc.sourceName) : '') +
        '</small>';

      var actions = document.createElement('div');
      actions.className = 'pdf-doc-actions';

      var openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'btn btn-ghost pdf-doc-open';
      openBtn.textContent = 'Открыть';
      openBtn.addEventListener('click', function () {
        openReader(doc);
      });

      var delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn btn-ghost pdf-doc-del';
      delBtn.setAttribute('aria-label', 'Удалить');
      delBtn.title = 'Удалить';
      delBtn.textContent = '✕';
      delBtn.addEventListener('click', async function () {
        if (!confirm('Удалить «' + (doc.title || 'документ') + '»? Текст и карточки файла будут потеряны.')) return;
        try {
          var deckCards = await LexDB.getCardsByDeck('pdf:' + doc.id);
          for (var i = 0; i < deckCards.length; i++) {
            var b = bridge();
            if (b && typeof b.deleteCard === 'function') await b.deleteCard(deckCards[i].id);
            else await LexDB.deleteCard(deckCards[i].id);
          }
          await LexDB.deleteDocument(doc.id);
          if (currentDocId === doc.id) closeReader();
          var br = bridge();
          if (br && typeof br.onPdfParticipateChange === 'function') {
            await br.onPdfParticipateChange();
          }
          toast('Документ удалён', 'ok');
          refreshList();
        } catch (err) {
          toast('Не удалось удалить: ' + err.message, 'error');
        }
      });

      var lab = document.createElement('label');
      lab.className = 'switch';
      lab.title = 'Участвует в ленте Сегодня';
      var inp = document.createElement('input');
      inp.type = 'checkbox';
      inp.checked = doc.participate !== false;
      inp.addEventListener('change', async function () {
        try {
          doc.participate = !!inp.checked;
          await LexDB.putDocument(doc);
          var br = bridge();
          if (br && typeof br.onPdfParticipateChange === 'function') {
            await br.onPdfParticipateChange();
          }
          toast(doc.participate ? 'Участвует в ленте' : 'Исключён из ленты', 'ok');
        } catch (err) {
          inp.checked = !inp.checked;
          toast('Не удалось сохранить: ' + err.message, 'error');
        }
      });
      var slider = document.createElement('span');
      slider.className = 'slider';
      lab.appendChild(inp);
      lab.appendChild(slider);

      actions.appendChild(openBtn);
      actions.appendChild(delBtn);
      actions.appendChild(lab);

      item.appendChild(info);
      item.appendChild(actions);
      info.addEventListener('click', function (e) {
        if (e.target.closest('button, label, input')) return;
        openReader(doc);
      });
      list.appendChild(item);
    });
  }

  /* ---- Import ---- */

  async function importPdfFile(file) {
    if (!file) {
      toast('Выберите PDF', 'error');
      return;
    }
    var name = file.name || '';
    if (file.type && file.type !== 'application/pdf' && !/\.pdf$/i.test(name)) {
      toast('Нужен файл PDF', 'error');
      return;
    }
    toast('Извлекаем текст…');
    try {
      var text = await extractTextFromPdf(file);
      if (!text) {
        toast('Текст не найден (скан?). Попробуйте другой PDF.', 'error');
        return;
      }
      var wordCount = countWords(text);
      var doc = {
        id: uid('doc'),
        title: titleFromFileName(name),
        sourceName: name,
        createdAt: Date.now(),
        text: text,
        charCount: text.length,
        wordCount: wordCount,
        participate: true
      };
      await LexDB.putDocument(doc);
      toast('Сохранено: ' + formatWordCount(wordCount), 'ok');
      await refreshList();
      openReader(doc);
    } catch (err) {
      console.error(err);
      toast('Ошибка PDF: ' + (err && err.message ? err.message : String(err)), 'error');
    }
  }

  function pickPdf() {
    var input = $('pdf-file');
    if (!input) return;
    input.value = '';
    input.click();
  }

  function bindUi() {
    if (bound) return;
    bound = true;

    var input = $('pdf-file');
    if (input) {
      input.addEventListener('change', function () {
        var f = input.files && input.files[0];
        if (f) importPdfFile(f);
      });
    }

    var btn = $('btn-import-pdf');
    if (btn) btn.addEventListener('click', pickPdf);

    var btnAdd = $('btn-import-pdf-add');
    if (btnAdd) btnAdd.addEventListener('click', pickPdf);

    var closeBtn = $('reader-close');
    if (closeBtn) closeBtn.addEventListener('click', closeReader);

    var body = $('reader-body');
    var scroll = $('reader-scroll');
    var target = scroll || body || document;
    target.addEventListener('pointerdown', onPointerDown, { passive: true });
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerup', onPointerUp, { passive: true });
    window.addEventListener('pointercancel', onPointerCancel, { passive: true });
    document.addEventListener('click', onDocClick, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('contextmenu', onContextMenu, true);
  }

  function init() {
    bindUi();
    ensureBubbleHost();
    return refreshList();
  }

  global.LexReader = {
    init: init,
    refreshList: refreshList,
    importPdfFile: importPdfFile,
    openReader: openReader,
    closeReader: closeReader,
    pickPdf: pickPdf,
    cleanupText: cleanupText,
    closeBubble: closeBubble,
    markSavedWords: markSavedWords
  };
})(typeof window !== 'undefined' ? window : self);
