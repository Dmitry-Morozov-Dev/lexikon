/**
 * Лексикон — Книги: ридер (грузится лениво при открытии вкладки «Книги»).
 * Рендер одной главы, настройки чтения, оглавление/закладки, запоминание позиции,
 * long-press по слову → пузырёк (перевод слова + предложения) и карточка в колоду книги.
 */
(function (global) {
  'use strict';

  var U = global.LexBooksUtil;
  var SETTINGS_KEY = 'lexikon-reader-settings';
  var HOLD_MS = 500;
  var HOLD_MOVE_CANCEL_PX = 10;
  var SAVE_DEBOUNCE_MS = 700;

  var DEFAULTS = {
    font: 'serif',      // serif | sans | georgia | mono-ish
    size: 19,           // px
    lh: 1.65,
    margin: 'm',        // s | m | l
    align: 'justify',   // justify | left
    theme: 'app',       // app | light | sepia | dark | black
    mode: 'scroll',     // scroll | pages
    wake: false
  };

  var FONTS = {
    serif: 'var(--font-word)',
    georgia: 'Georgia, "Times New Roman", serif',
    sans: 'var(--font-ui)',
    charter: 'Charter, "Bitstream Charter", "Sitka Text", Cambria, serif'
  };

  var MARGINS = { s: '12px', m: '22px', l: '36px' };

  var settings = loadSettings();

  // Текущее состояние ридера
  var book = null;          // метаданные (documents)
  var content = null;       // { chapters }
  var chIndex = 0;
  var paraEls = [];
  var paraWords = [];
  var currentPos = null;
  var saveTimer = null;
  var scrollRaf = 0;
  var lastScrollTop = 0;
  var chromeHidden = false;
  var wakeLock = null;
  var bound = false;
  var holdState = null;
  var lastHoldAt = 0;
  var suppressTapUntil = 0;
  var activeSpan = null;
  var bubbleEl = null;
  var translateCache = new Map();
  var onCloseCb = null;

  function $(id) { return document.getElementById(id); }

  function bridge() { return global.LexikonBridge || null; }

  function toast(msg, kind) {
    var b = bridge();
    if (b && typeof b.toast === 'function') { b.toast(msg, kind); return; }
    var host = $('toast-host');
    if (!host) return;
    var t = document.createElement('div');
    t.className = 'toast' + (kind ? ' ' + kind : '');
    t.textContent = msg;
    host.appendChild(t);
    setTimeout(function () { t.remove(); }, 3400);
  }

  var escapeHtml = U.escapeHtml;

  function softVibrate() {
    try { if (navigator.vibrate) navigator.vibrate(12); } catch (e) { /* ignore */ }
  }

  /* ================= Настройки ================= */

  function loadSettings() {
    var s = {};
    try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {}; } catch (e) { s = {}; }
    return Object.assign({}, DEFAULTS, s);
  }

  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ }
  }

  function applySettings() {
    var ov = $('reader-overlay');
    if (!ov) return;
    ov.setAttribute('data-rtheme', settings.theme);
    ov.setAttribute('data-rmode', settings.mode);
    ov.style.setProperty('--r-size', settings.size + 'px');
    ov.style.setProperty('--r-lh', String(settings.lh));
    ov.style.setProperty('--r-font', FONTS[settings.font] || FONTS.serif);
    ov.style.setProperty('--r-pad', MARGINS[settings.margin] || MARGINS.m);
    ov.style.setProperty('--r-align', settings.align === 'left' ? 'left' : 'justify');
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta && book) {
      var bg = getComputedStyle(ov).getPropertyValue('--bg').trim();
      if (bg) meta.setAttribute('content', bg);
    }
  }

  /** Изменить настройку, сохранив позицию чтения (якорь — абзац, не пиксели). */
  function changeSetting(key, value) {
    var pos = book ? computePos() : null;
    settings[key] = value;
    saveSettings();
    applySettings();
    if (key === 'wake') updateWakeLock();
    if (pos) restorePos(pos);
    renderSettingsSheet();
  }

  /* ================= Wake Lock ================= */

  function updateWakeLock() {
    var want = !!(settings.wake && book && document.visibilityState === 'visible');
    if (!('wakeLock' in navigator)) return;
    if (want && !wakeLock) {
      navigator.wakeLock.request('screen').then(function (l) {
        wakeLock = l;
        l.addEventListener('release', function () { wakeLock = null; });
      }).catch(function () { wakeLock = null; });
    } else if (!want && wakeLock) {
      try { wakeLock.release(); } catch (e) { /* ignore */ }
      wakeLock = null;
    }
  }

  /* ================= Текст / предложения ================= */

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
    return { text: text, offset: range.toString().length, para: p };
  }

  function extractSentence(fullText, offset, wordLen) {
    var text = String(fullText || '');
    if (!text) return '';
    var enders = /[.!?…]+["”»’)]?|\n/g;
    var start = 0;
    var m;
    while ((m = enders.exec(text)) !== null) {
      if (m.index + m[0].length <= offset) start = m.index + m[0].length;
      else break;
    }
    while (start < text.length && /\s/.test(text.charAt(start))) start++;
    var end = text.length;
    enders.lastIndex = offset + (wordLen || 0);
    var found = enders.exec(text);
    if (found) end = found.index + found[0].length;
    var sentence = text.slice(start, end).replace(/\s+/g, ' ').trim();
    if (sentence.length > 320) {
      var mid = offset - start;
      var lo = Math.max(0, mid - 140);
      var hi = Math.min(sentence.length, mid + 180);
      sentence = (lo > 0 ? '…' : '') + sentence.slice(lo, hi).trim() + (hi < sentence.length ? '…' : '');
    }
    if (sentence.length < 2) {
      var a = Math.max(0, offset - 60);
      var b = Math.min(text.length, offset + (wordLen || 0) + 60);
      sentence = text.slice(a, b).trim();
    }
    return sentence;
  }

  /* ================= Перевод (MyMemory) ================= */

  async function translateEnRu(text) {
    var q = String(text || '').trim();
    if (!q) return { text: '', offline: false };
    var key = 'en|ru::' + q.toLowerCase();
    if (translateCache.has(key)) return { text: translateCache.get(key), offline: false, cached: true };
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return { text: '', offline: true };
    try {
      var url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(q.slice(0, 450)) + '&langpair=en|ru';
      var res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();
      var tr = (data && data.responseData && data.responseData.translatedText) || '';
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

  /* ================= Лексикон: поиск + карточка ================= */

  function lookupSurface(surface) {
    var b = bridge();
    return b && typeof b.lookup === 'function' ? b.lookup(surface) : null;
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
      return '<a class="ext-pill" href="' + escapeHtml(L.href) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(L.label) + '</a>';
    }).join('');
  }

  function mergeExamples(sentenceEn, sentenceRu, fromCard) {
    var examples = [];
    if (sentenceEn) examples.push({ en: sentenceEn, ru: sentenceRu || '' });
    var src = [];
    if (fromCard) {
      if (Array.isArray(fromCard.examples) && fromCard.examples.length) src = fromCard.examples;
      else if (fromCard.ex || fromCard.exRu) src = [{ en: fromCard.ex || '', ru: fromCard.exRu || '' }];
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
      if (Array.isArray(hit.card.examples)) {
        var matchEx = hit.card.examples.find(function (e) { return e && e.en && e.en.trim() === sentence; });
        if (matchEx && matchEx.ru) sentenceRu = matchEx.ru;
      }
    }
    var needWord = !tr;
    var needSent = !sentenceRu && !!sentence;
    if (needSent) {
      var sRes = await translateEnRu(sentence);
      if (sRes.offline && !sRes.text) note = 'перевод недоступен офлайн';
      else sentenceRu = sRes.text || '';
    }
    if (needWord) {
      var wRes = await translateEnRu(surface);
      if (wRes.offline && !wRes.text) {
        if (!note) note = 'перевод недоступен офлайн';
        tr = '—';
      } else tr = wRes.text || '—';
    }
    return { tr: tr, sentenceRu: sentenceRu, note: note, fromLex: fromLex };
  }

  function cardIdFor(docId, lemma) {
    return 'pdf-' + docId + '-' + lemmaSlug(lemma);
  }

  /** Карточка в колоду книги: id pdf-{bookId}-{lemma}, deckId pdf:{bookId} (как у PDF раньше). */
  async function saveBookCard(opts) {
    var docId = opts.docId;
    var surface = opts.surface;
    var lemma = opts.lemma || normalizeLemma(surface);
    var sentence = opts.sentence || '';
    var hit = opts.hit;
    var trInfo = opts.trInfo;
    var cardId = cardIdFor(docId, lemma);
    var existing = null;
    try { existing = await LexDB.getCard(cardId); } catch (e) { /* ignore */ }
    var already = !!existing;
    var from = hit && hit.card ? hit.card : null;
    var examples = mergeExamples(sentence, trInfo.sentenceRu, from || existing);
    if (existing && Array.isArray(existing.examples)) {
      existing.examples.forEach(function (ex) {
        if (!ex || !ex.en) return;
        if (examples.some(function (e) { return e.en === ex.en; })) return;
        examples.push(ex);
      });
      examples = examples.slice(0, 6);
    }
    var primary = examples[0] || { en: sentence, ru: trInfo.sentenceRu || '' };
    // Все места, где слово встретилось в этой книге (новое — первым), до 8
    var contexts = [];
    if (existing && Array.isArray(existing.contexts)) contexts = existing.contexts.slice();
    else if (existing && existing.contextSentence) {
      contexts = [{ en: existing.contextSentence, ru: existing.contextSentenceRu || '', docId: docId,
        bookTitle: existing.bookTitle || (book ? book.title : ''), at: existing.createdAt || Date.now() }];
    }
    if (sentence) {
      contexts = contexts.filter(function (c) { return c && c.en !== sentence; });
      contexts.unshift({ en: sentence, ru: trInfo.sentenceRu || '', docId: docId, bookTitle: book ? book.title : '',
        ch: opts.ch != null ? opts.ch : null, para: opts.para != null ? opts.para : null, at: Date.now() });
    }
    contexts = contexts.slice(0, 8);
    var card = {
      id: cardId,
      word: surface,
      lemma: lemma,
      ipa: (from && from.ipa) || (existing && existing.ipa) || '',
      pos: (from && from.pos) || (existing && existing.pos) || 'other',
      level: (from && from.level) || (existing && existing.level) || (book && book.format !== 'pdf' ? 'book' : 'pdf'),
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
      img: (existing && existing.img) || (from && from.img) || '',
      imgSrc: (existing && existing.imgSrc) || (from && from.imgSrc) || 'letter',
      imgAlt: surface,
      source: 'pdf',
      deckId: 'pdf:' + docId,
      docId: docId,
      bookTitle: book ? book.title : '',
      contexts: contexts,
      contextSentence: sentence,
      contextSentenceRu: trInfo.sentenceRu || (existing && existing.contextSentenceRu) || '',
      updatedAt: Date.now(),
      createdAt: (existing && existing.createdAt) || Date.now()
    };
    var b = bridge();
    if (b && typeof b.putCard === 'function') await b.putCard(card);
    else {
      await LexDB.putCard(card);
      await LexDB.ensureProgress(card.id);
    }
    return { card: card, already: already };
  }

  /* ================= Пузырёк ================= */

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

  function isBubbleOpen() {
    return !!(bubbleEl && !bubbleEl.classList.contains('hidden'));
  }

  function closeBubble() {
    if (bubbleEl) {
      bubbleEl.classList.add('hidden');
      bubbleEl.innerHTML = '';
    }
    if (activeSpan) {
      activeSpan.classList.remove('rw-active');
      activeSpan = null;
    }
  }

  function positionBubble(anchorEl) {
    var el = ensureBubbleHost();
    el.classList.remove('hidden');
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
    var status = data.statusText || (data.already ? 'Уже в колоде книги' : 'Добавлено в колоду книги');
    var delBtn = data.cardId && (data.already || data.saved)
      ? '<button type="button" class="btn btn-ghost rw-bubble-del" data-action="delete">Удалить из колоды</button>'
      : '';
    el.innerHTML =
      '<div class="rw-bubble-inner">' +
      '<div class="rw-bubble-head">' +
      '<strong class="rw-bubble-word">' + escapeHtml(data.word) + '</strong>' +
      '<span class="rw-bubble-tr">' + escapeHtml(data.tr || '—') + '</span>' +
      '</div>' +
      '<div class="rw-bubble-sent">' +
      '<div class="rw-bubble-sent-en">' + escapeHtml(data.sentence) + '</div>' +
      (data.sentenceRu ? '<div class="rw-bubble-sent-ru">' + escapeHtml(data.sentenceRu) + '</div>' : '') +
      '</div>' +
      (data.note ? '<div class="rw-bubble-note">' + escapeHtml(data.note) + '</div>' : '') +
      '<div class="rw-bubble-status' + (data.already ? ' is-dup' : '') + '">' +
      escapeHtml(status) + (data.fromLex ? ' · из лексикона' : '') +
      '</div>' +
      '<div class="rw-bubble-links card-links">' + extLinksHtml(data.word, data.lemma) + '</div>' +
      delBtn +
      '</div>';
    positionBubble(data.anchor);
    var del = el.querySelector('[data-action="delete"]');
    if (del) {
      del.addEventListener('click', async function (e) {
        e.preventDefault();
        e.stopPropagation();
        try {
          var b = bridge();
          if (b && typeof b.deleteCard === 'function') await b.deleteCard(data.cardId);
          else await LexDB.deleteCard(data.cardId);
          if (data.anchor) data.anchor.classList.remove('rw-saved', 'rw-active');
          await markSavedWords();
          closeBubble();
          toast('Удалено из колоды', 'ok');
        } catch (err) {
          toast('Не удалось удалить: ' + err.message, 'error');
        }
      });
    }
  }

  var savedSet = {};

  async function markSavedWords() {
    var body = $('reader-body');
    if (!body || !book) return;
    var cards = [];
    try { cards = await LexDB.getCardsByDeck('pdf:' + book.id); } catch (e) { return; }
    var set = {};
    var b = bridge();
    cards.forEach(function (c) {
      var lem = normalizeLemma(c.lemma || c.word || '');
      var w = normalizeLemma(c.word || '');
      if (lem) set[lem] = c.id;
      if (w) set[w] = c.id;
    });
    savedSet = set;
    body.querySelectorAll('.rw').forEach(function (span) {
      span.classList.toggle('rw-saved', !!savedCardIdFor(span));
    });
    if (b) { /* no-op: bridge used in savedCardIdFor */ }
  }

  function savedCardIdFor(span) {
    var raw = normalizeLemma(span.getAttribute('data-w') || span.textContent || '');
    if (!raw) return null;
    if (savedSet[raw]) return savedSet[raw];
    var b = bridge();
    if (b && typeof b.lemmaCandidates === 'function') {
      var c = b.lemmaCandidates(raw);
      for (var i = 0; i < c.length; i++) if (savedSet[c[i]]) return savedSet[c[i]];
    }
    return null;
  }

  async function onWordHold(span) {
    if (!book || !span) return;
    var surface = (span.getAttribute('data-w') || span.textContent || '').trim();
    if (!surface || /^[0-9]+(?:[.,][0-9]+)*$/.test(surface)) return;
    softVibrate();
    lastHoldAt = Date.now();
    if (activeSpan && activeSpan !== span) activeSpan.classList.remove('rw-active');
    activeSpan = span;
    span.classList.add('rw-active');
    var lemma = normalizeLemma(surface);
    var pos = spanOffsetInParagraph(span);
    var sentence = extractSentence(pos.text, pos.offset, surface.length);
    var hit = lookupSurface(surface);
    renderBubble({
      word: surface, lemma: lemma, tr: '…', sentence: sentence, sentenceRu: '',
      already: false, fromLex: !!(hit && hit.card), note: '', cardId: null, anchor: span,
      statusText: 'Сохраняем…'
    });
    try {
      var trInfo = await resolveTranslations(surface, sentence, hit);
      if (activeSpan !== span) return;
      var saved = await saveBookCard({
        docId: book.id, surface: surface, lemma: (hit && hit.query) || lemma,
        sentence: sentence, hit: hit, trInfo: trInfo,
        ch: chIndex, para: pos.para ? +pos.para.getAttribute('data-pi') : null
      });
      if (activeSpan !== span) return;
      var key = normalizeLemma(saved.card.lemma);
      savedSet[key] = saved.card.id;
      savedSet[normalizeLemma(surface)] = saved.card.id;
      // подчёркиваем все вхождения слова в главе
      $('reader-body').querySelectorAll('.rw').forEach(function (s) {
        if (!s.classList.contains('rw-saved') && savedCardIdFor(s)) s.classList.add('rw-saved');
      });
      span.classList.add('rw-saved');
      renderBubble({
        word: surface, lemma: saved.card.lemma, tr: saved.card.tr, sentence: sentence,
        sentenceRu: saved.card.contextSentenceRu || trInfo.sentenceRu || '',
        already: saved.already, saved: true, fromLex: trInfo.fromLex, note: trInfo.note,
        cardId: saved.card.id, anchor: span
      });
    } catch (err) {
      console.error(err);
      toast('Не удалось сохранить: ' + (err && err.message ? err.message : String(err)), 'error');
      closeBubble();
    }
  }

  /** Тап по подчёркнутому слову — снова показать пузырёк (без сети и без пересохранения). */
  async function showSavedBubble(span) {
    var id = savedCardIdFor(span);
    if (!id) return false;
    var card = null;
    try { card = await LexDB.getCard(id); } catch (e) { card = null; }
    if (!card) return false;
    if (activeSpan && activeSpan !== span) activeSpan.classList.remove('rw-active');
    activeSpan = span;
    span.classList.add('rw-active');
    var surface = (span.getAttribute('data-w') || span.textContent || '').trim();
    var pos = spanOffsetInParagraph(span);
    var sentence = extractSentence(pos.text, pos.offset, surface.length);
    var ru = '';
    if (sentence === card.contextSentence) ru = card.contextSentenceRu || '';
    else if (Array.isArray(card.examples)) {
      var ex = card.examples.find(function (e) { return e && e.en === sentence; });
      if (ex) ru = ex.ru || '';
    }
    renderBubble({
      word: surface, lemma: card.lemma, tr: card.tr, sentence: sentence, sentenceRu: ru,
      already: true, fromLex: false, note: '', cardId: card.id, anchor: span,
      statusText: 'В колоде книги'
    });
    if (!ru && sentence) {
      translateEnRu(sentence).then(function (r) {
        if (activeSpan !== span || !r.text || !bubbleEl) return;
        var box = bubbleEl.querySelector('.rw-bubble-sent');
        if (box && !box.querySelector('.rw-bubble-sent-ru')) {
          var d = document.createElement('div');
          d.className = 'rw-bubble-sent-ru';
          d.textContent = r.text;
          box.appendChild(d);
          positionBubble(span);
        }
      });
    }
    return true;
  }

  /* ================= Жесты ================= */

  function clearHold() {
    if (holdState && holdState.timer) clearTimeout(holdState.timer);
    holdState = null;
  }

  function onPointerDown(e) {
    if (!book) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    var span = e.target && e.target.closest ? e.target.closest('.rw') : null;
    if (!span || !span.closest('#reader-body')) return;
    clearHold();
    holdState = {
      span: span, startX: e.clientX, startY: e.clientY, pointerId: e.pointerId,
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
    if (Math.abs(e.clientX - holdState.startX) > HOLD_MOVE_CANCEL_PX ||
      Math.abs(e.clientY - holdState.startY) > HOLD_MOVE_CANCEL_PX) clearHold();
  }

  function onPointerUp(e) {
    if (!holdState) return;
    if (holdState.pointerId != null && e.pointerId !== holdState.pointerId) return;
    if (!holdState.fired) clearHold();
    else holdState = null;
  }

  function onDocClick(e) {
    if (!isBubbleOpen()) return;
    if (bubbleEl.contains(e.target)) return;
    if (e.target && e.target.closest && e.target.closest('.rw-active')) return;
    closeBubble();
    suppressTapUntil = Date.now() + 350;
  }

  function onContextMenu(e) {
    if (e.target && e.target.closest && e.target.closest('#reader-overlay .rw')) e.preventDefault();
  }

  function onKeyDown(e) {
    if (!book) return;
    var t = e.target;
    if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (isBubbleOpen()) { closeBubble(); return; }
      if (closePanels()) return;
      closeReader();
      return;
    }
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || (e.key === ' ' && !e.shiftKey)) {
      e.preventDefault();
      pageBy(1);
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp' || (e.key === ' ' && e.shiftKey)) {
      e.preventDefault();
      pageBy(-1);
    }
  }

  /** Тап: по подчёркнутому слову — пузырёк; края в режиме «Страницы» — листание; центр — панели. */
  function onReaderTap(e) {
    if (!book) return;
    if (Date.now() - lastHoldAt < 700 || Date.now() < suppressTapUntil) return;
    if (e.target.closest('button, a, input, label, .rw-bubble, .reader-chapter-end, .reader-bar, .reader-foot')) return;
    var sel = global.getSelection && global.getSelection();
    if (sel && !sel.isCollapsed && String(sel).trim()) return;
    var span = e.target.closest('.rw.rw-saved');
    if (span) {
      showSavedBubble(span);
      return;
    }
    if (isBubbleOpen()) { closeBubble(); return; }
    var x = e.clientX / Math.max(1, window.innerWidth);
    if (settings.mode === 'pages' && x < 0.3) { pageBy(-1); return; }
    if (settings.mode === 'pages' && x > 0.7) { pageBy(1); return; }
    setChromeHidden(!chromeHidden);
  }

  /* ================= Рендер главы ================= */

  var WORD_RE = /[A-Za-zÀ-ÖØ-öø-ÿĀ-žА-Яа-яЁё]+(?:['’][A-Za-zÀ-ÖØ-öø-ÿĀ-žА-Яа-яЁё]+)?|[0-9]+(?:[.,][0-9]+)*/g;

  function wrapWordsHtml(text) {
    if (!text) return '';
    var html = '';
    var last = 0;
    var m;
    WORD_RE.lastIndex = 0;
    while ((m = WORD_RE.exec(text)) !== null) {
      if (m.index > last) html += escapeHtml(text.slice(last, m.index));
      html += '<span class="rw" data-w="' + escapeHtml(m[0]) + '">' + escapeHtml(m[0]) + '</span>';
      last = m.index + m[0].length;
    }
    if (last < text.length) html += escapeHtml(text.slice(last));
    return html;
  }

  function chapters() { return (content && content.chapters) || []; }

  function renderChapter(idx) {
    var body = $('reader-body');
    var sc = $('reader-scroll');
    if (!body || !content) return;
    var chs = chapters();
    idx = Math.max(0, Math.min(chs.length - 1, idx | 0));
    chIndex = idx;
    closeBubble();
    clearHold();
    var ch = chs[idx] || { title: '', paras: [] };
    var parts = [];
    parts.push('<h1 class="reader-p reader-ch-title" data-pi="-1">' + wrapWordsHtml(ch.title || '') + '</h1>');
    paraWords = [];
    (ch.paras || []).forEach(function (p, i) {
      var t = U.paraText(p);
      paraWords.push(U.countWords(t));
      if (typeof p === 'string') {
        parts.push('<p class="reader-p" data-pi="' + i + '">' + wrapWordsHtml(t) + '</p>');
      } else {
        parts.push('<h3 class="reader-p reader-h" data-pi="' + i + '">' + wrapWordsHtml(t) + '</h3>');
      }
    });
    var next = chs[idx + 1];
    parts.push(
      '<div class="reader-chapter-end">' +
      (next
        ? '<button type="button" class="btn btn-accent btn-block" data-act="next-ch">Дальше: ' + escapeHtml(next.title || ('Глава ' + (idx + 2))) + ' →</button>'
        : '<div class="reader-the-end"><div class="big">✓</div><p>Конец книги</p></div>') +
      '</div>'
    );
    body.innerHTML = parts.join('');
    paraEls = Array.prototype.slice.call(body.querySelectorAll('.reader-p[data-pi]')).filter(function (el) {
      return el.getAttribute('data-pi') !== '-1';
    });
    if (sc) sc.scrollTop = 0;
    lastScrollTop = 0;
    updateHeader();
    markSavedWords();
  }

  function goChapter(idx, where) {
    var chs = chapters();
    if (idx < 0 || idx >= chs.length) return;
    renderChapter(idx);
    var sc = $('reader-scroll');
    if (where === 'end' && sc) {
      requestAnimationFrame(function () {
        var endEl = document.querySelector('#reader-body .reader-chapter-end');
        var target = endEl ? endEl.offsetTop - sc.clientHeight + 40 : sc.scrollHeight;
        sc.scrollTop = Math.max(0, target);
        onScrollSettled();
      });
    } else {
      onScrollSettled();
    }
  }

  function topInset() {
    var bar = $('reader-bar');
    return (!chromeHidden && bar) ? bar.offsetHeight : 0;
  }

  /** Текущая позиция: глава + абзац + доля абзаца (переживает смену шрифта). */
  function computePos() {
    var sc = $('reader-scroll');
    var pos = { ch: chIndex, para: 0, frac: 0 };
    if (!sc || !paraEls.length) return pos;
    var ref = sc.scrollTop + topInset() + 4;
    var lo = 0, hi = paraEls.length - 1, ans = 0;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (paraEls[mid].offsetTop <= ref) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    var el = paraEls[ans];
    var h = Math.max(1, el.offsetHeight);
    pos.para = parseInt(el.getAttribute('data-pi'), 10) || 0;
    pos.frac = Math.max(0, Math.min(1, (ref - el.offsetTop) / h));
    if (sc.scrollTop <= 2) { pos.para = 0; pos.frac = 0; }
    return pos;
  }

  function restorePos(pos) {
    if (!pos) return;
    if (pos.ch !== chIndex) renderChapter(pos.ch);
    var sc = $('reader-scroll');
    if (!sc) return;
    var apply = function () {
      if (!pos.para && !pos.frac) { sc.scrollTop = 0; return; }
      var el = paraEls[Math.min(pos.para, paraEls.length - 1)];
      if (!el) return;
      sc.scrollTop = Math.max(0, el.offsetTop + (pos.frac || 0) * el.offsetHeight - topInset() - 4);
    };
    apply();
    lastScrollTop = sc.scrollTop;
    currentPos = { ch: chIndex, para: pos.para || 0, frac: pos.frac || 0 };
    updateStatus();
  }

  function bookProgress(pos) {
    var sc = $('reader-scroll');
    var chs = chapters();
    if (sc && chIndex === chs.length - 1 && sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 8 && sc.scrollTop > 0) return 1;
    if (sc && chIndex === chs.length - 1 && sc.scrollHeight <= sc.clientHeight + 8) return 1;
    return U.progressOf(book, pos, paraWords);
  }

  function chapterWordsLeft(pos) {
    var left = 0;
    for (var i = pos.para; i < paraWords.length; i++) left += paraWords[i];
    left -= (paraWords[pos.para] || 0) * (pos.frac || 0);
    return Math.max(0, left);
  }

  function updateHeader() {
    var title = $('reader-title');
    var meta = $('reader-meta');
    var chs = chapters();
    if (title) title.textContent = book ? book.title : '';
    if (meta) {
      var ch = chs[chIndex];
      meta.textContent = (ch ? ch.title : '') + (chs.length > 1 ? ' · ' + (chIndex + 1) + '/' + chs.length : '');
    }
    var prev = $('reader-prev');
    var next = $('reader-next');
    if (prev) prev.disabled = chIndex <= 0;
    if (next) next.disabled = chIndex >= chs.length - 1;
  }

  function updateStatus() {
    if (!book || !currentPos) return;
    var p = bookProgress(currentPos);
    var pct = Math.floor(p * 100);
    var status = $('reader-status');
    var fill = $('reader-progress-fill');
    var mini = $('reader-mini');
    var minLeft = chapterWordsLeft(currentPos) / U.READ_WPM;
    if (status) {
      status.textContent = pct + '% · ' + (minLeft < 1 && chIndex >= chapters().length - 1
        ? 'дочитано'
        : U.formatMinutes(minLeft) + ' до конца главы');
    }
    if (fill) fill.style.width = (p * 100).toFixed(1) + '%';
    if (mini) mini.textContent = pct + '%';
    updateBookmarkBtn();
  }

  function schedulePosSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      saveTimer = null;
      persistPos();
    }, SAVE_DEBOUNCE_MS);
  }

  async function persistPos() {
    if (!book || !currentPos) return;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    var id = book.id;
    var pos = { ch: currentPos.ch, para: currentPos.para, frac: Math.round(currentPos.frac * 1000) / 1000 };
    var progress = bookProgress(currentPos);
    book.pos = pos;
    book.progress = progress;
    book.lastOpenedAt = Date.now();
    if (progress >= 0.995 && !book.finishedAt) book.finishedAt = Date.now();
    try {
      var fresh = await LexDB.getDocument(id);
      if (!fresh) return;
      fresh.pos = pos;
      fresh.progress = progress;
      fresh.lastOpenedAt = book.lastOpenedAt;
      fresh.bookmarks = book.bookmarks || [];
      if (book.finishedAt) fresh.finishedAt = book.finishedAt;
      await LexDB.putDocument(fresh);
    } catch (e) {
      console.warn('save position failed', e);
    }
  }

  function onScrollSettled() {
    currentPos = computePos();
    updateStatus();
    schedulePosSave();
  }

  function onScroll() {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(function () {
      scrollRaf = 0;
      var sc = $('reader-scroll');
      if (!sc || !book) return;
      var st = sc.scrollTop;
      var d = st - lastScrollTop;
      if (d > 24 && st > 80 && !chromeHidden && !panelsOpen()) setChromeHidden(true);
      if (Math.abs(d) > 24) lastScrollTop = st;
      if (isBubbleOpen() && activeSpan) {
        var r = activeSpan.getBoundingClientRect();
        if (r.bottom < 0 || r.top > window.innerHeight) closeBubble();
        else positionBubble(activeSpan);
      }
      onScrollSettled();
    });
  }

  /** Листание «страницами»: на экран минус две строки; на краю главы — соседняя глава. */
  function pageBy(dir) {
    var sc = $('reader-scroll');
    if (!sc || !book) return;
    closeBubble();
    var lh = settings.size * settings.lh;
    var foot = $('reader-foot');
    var visible = sc.clientHeight - topInset() - (!chromeHidden && foot ? foot.offsetHeight : 0);
    var step = Math.max(120, visible - lh * 2);
    if (dir > 0) {
      if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 4) {
        if (chIndex < chapters().length - 1) goChapter(chIndex + 1, 'start');
        return;
      }
      sc.scrollBy({ top: step, behavior: 'smooth' });
    } else {
      if (sc.scrollTop <= 2) {
        if (chIndex > 0) goChapter(chIndex - 1, 'end');
        return;
      }
      sc.scrollBy({ top: -step, behavior: 'smooth' });
    }
  }

  function setChromeHidden(hidden) {
    chromeHidden = !!hidden;
    var ov = $('reader-overlay');
    if (ov) ov.classList.toggle('reader-chrome-hidden', chromeHidden);
  }

  /* ================= Оглавление и закладки ================= */

  var drawerTab = 'toc';

  function panelsOpen() {
    var d = $('reader-drawer');
    var s = $('reader-sheet');
    return !!((d && !d.classList.contains('hidden')) || (s && !s.classList.contains('hidden')));
  }

  function closePanels() {
    var was = panelsOpen();
    ['reader-drawer', 'reader-sheet'].forEach(function (id) {
      var el = $(id);
      if (el) el.classList.add('hidden');
    });
    var bd = $('reader-backdrop');
    if (bd) bd.classList.add('hidden');
    return was;
  }

  function openPanel(id) {
    closeBubble();
    closePanels();
    var el = $(id);
    var bd = $('reader-backdrop');
    if (el) el.classList.remove('hidden');
    if (bd) bd.classList.remove('hidden');
  }

  function findBookmark(pos) {
    var list = (book && book.bookmarks) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].ch === pos.ch && list[i].para === pos.para) return list[i];
    }
    return null;
  }

  function updateBookmarkBtn() {
    var btn = $('reader-btn-bookmark');
    if (!btn || !currentPos) return;
    var on = !!findBookmark(currentPos);
    btn.classList.toggle('is-on', on);
    btn.textContent = on ? '★' : '☆';
    btn.setAttribute('aria-label', on ? 'Убрать закладку' : 'Добавить закладку');
    btn.title = on ? 'Убрать закладку' : 'Закладка';
  }

  function toggleBookmark() {
    if (!book) return;
    var pos = computePos();
    book.bookmarks = book.bookmarks || [];
    var ex = findBookmark(pos);
    if (ex) {
      book.bookmarks = book.bookmarks.filter(function (b) { return b !== ex; });
      toast('Закладка удалена', 'ok');
    } else {
      var p = (chapters()[pos.ch] || { paras: [] }).paras[pos.para];
      var snippet = U.paraText(p).replace(/\s+/g, ' ').slice(0, 140);
      book.bookmarks.push({
        id: U.uid('bm'), ch: pos.ch, para: pos.para, frac: pos.frac,
        text: snippet, createdAt: Date.now()
      });
      book.bookmarks.sort(function (a, b) { return a.ch - b.ch || a.para - b.para; });
      toast('Закладка добавлена', 'ok');
    }
    currentPos = pos;
    updateBookmarkBtn();
    persistPos();
  }

  function renderDrawer() {
    var host = $('reader-drawer-body');
    if (!host || !book) return;
    var tabs = document.querySelectorAll('#reader-drawer [data-tab]');
    tabs.forEach(function (t) { t.classList.toggle('active', t.getAttribute('data-tab') === drawerTab); });
    var info = $('reader-drawer-info');
    if (info) {
      var p = currentPos ? bookProgress(currentPos) : (book.progress || 0);
      var leftMin = (1 - p) * (book.wordCount || 0) / U.READ_WPM;
      info.textContent = Math.floor(p * 100) + '% прочитано · осталось ' + U.formatMinutes(leftMin) +
        ' · ' + U.formatWordCount(book.wordCount || 0);
    }
    if (drawerTab === 'toc') {
      var toc = book.toc || [];
      var before = 0;
      var total = Math.max(1, book.wordCount || 1);
      host.innerHTML = '<ol class="reader-toc">' + chapters().map(function (ch, i) {
        var startPct = Math.floor(before / total * 100);
        before += (toc[i] && toc[i].words) || 0;
        return '<li><button type="button" class="reader-toc-item' + (i === chIndex ? ' is-current' : '') +
          '" data-ch="' + i + '" style="padding-left:' + (12 + Math.min(2, (ch.level || 1) - 1) * 14) + 'px">' +
          '<span class="reader-toc-title">' + escapeHtml(ch.title || ('Глава ' + (i + 1))) + '</span>' +
          '<span class="reader-toc-pct">' + startPct + '%</span></button></li>';
      }).join('') + '</ol>';
      var cur = host.querySelector('.is-current');
      if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'center' });
    } else {
      var bms = book.bookmarks || [];
      if (!bms.length) {
        host.innerHTML = '<p class="muted reader-drawer-empty">Закладок пока нет. Нажмите ☆ вверху, чтобы отметить место.</p>';
        return;
      }
      host.innerHTML = '<ul class="reader-bm-list">' + bms.map(function (b) {
        var ch = chapters()[b.ch];
        return '<li class="reader-bm"><button type="button" class="reader-bm-go" data-bm="' + escapeHtml(b.id) + '">' +
          '<span class="reader-bm-ch">' + escapeHtml(ch ? ch.title : '') + ' · ' + escapeHtml(U.formatDate(b.createdAt)) + '</span>' +
          '<span class="reader-bm-text">' + escapeHtml(b.text || '…') + '</span></button>' +
          '<button type="button" class="btn btn-ghost reader-bm-del" data-bm-del="' + escapeHtml(b.id) + '" aria-label="Удалить закладку">✕</button></li>';
      }).join('') + '</ul>';
    }
  }

  function onDrawerClick(e) {
    var tab = e.target.closest('[data-tab]');
    if (tab) { drawerTab = tab.getAttribute('data-tab'); renderDrawer(); return; }
    var item = e.target.closest('[data-ch]');
    if (item) {
      closePanels();
      goChapter(parseInt(item.getAttribute('data-ch'), 10), 'start');
      persistPos();
      return;
    }
    var del = e.target.closest('[data-bm-del]');
    if (del) {
      var did = del.getAttribute('data-bm-del');
      book.bookmarks = (book.bookmarks || []).filter(function (b) { return b.id !== did; });
      persistPos();
      renderDrawer();
      updateBookmarkBtn();
      return;
    }
    var go = e.target.closest('[data-bm]');
    if (go) {
      var bid = go.getAttribute('data-bm');
      var bm = (book.bookmarks || []).filter(function (b) { return b.id === bid; })[0];
      if (bm) {
        closePanels();
        restorePos({ ch: bm.ch, para: bm.para, frac: bm.frac || 0 });
        persistPos();
      }
    }
  }

  /* ================= Настройки чтения (лист «Aa») ================= */

  function segHtml(key, options) {
    return '<div class="seg reader-seg" data-key="' + key + '">' + options.map(function (o) {
      return '<button type="button" data-val="' + escapeHtml(String(o[0])) + '" class="' +
        (String(settings[key]) === String(o[0]) ? 'active' : '') + '">' + escapeHtml(o[1]) + '</button>';
    }).join('') + '</div>';
  }

  function renderSettingsSheet() {
    var host = $('reader-sheet-body');
    if (!host) return;
    var wakeSupported = 'wakeLock' in navigator;
    host.innerHTML =
      '<div class="reader-set-row reader-size-row">' +
      '<button type="button" class="btn reader-size-btn" data-size="-1" aria-label="Меньше">A−</button>' +
      '<input type="range" id="reader-size-range" min="14" max="30" step="1" value="' + settings.size + '" aria-label="Размер шрифта" />' +
      '<button type="button" class="btn reader-size-btn" data-size="1" aria-label="Больше">A+</button>' +
      '<span class="reader-size-val">' + settings.size + '</span>' +
      '</div>' +
      '<div class="reader-set-label">Шрифт</div>' +
      segHtml('font', [['serif', 'Книжный'], ['georgia', 'Georgia'], ['sans', 'Без засечек']]) +
      '<div class="reader-set-label">Межстрочный интервал</div>' +
      segHtml('lh', [[1.4, 'Плотно'], [1.65, 'Обычно'], [1.9, 'Свободно']]) +
      '<div class="reader-set-label">Поля</div>' +
      segHtml('margin', [['s', 'Узкие'], ['m', 'Средние'], ['l', 'Широкие']]) +
      '<div class="reader-set-label">Выравнивание</div>' +
      segHtml('align', [['justify', 'По ширине'], ['left', 'По левому краю']]) +
      '<div class="reader-set-label">Тема</div>' +
      '<div class="reader-themes" data-key="theme">' +
      [['app', 'Как в приложении'], ['light', 'Светлая'], ['sepia', 'Сепия'], ['dark', 'Тёмная'], ['black', 'Чёрная']].map(function (t) {
        return '<button type="button" class="reader-theme-swatch sw-' + t[0] + (settings.theme === t[0] ? ' active' : '') +
          '" data-val="' + t[0] + '" title="' + t[1] + '" aria-label="' + t[1] + '"><span>Аа</span></button>';
      }).join('') +
      '</div>' +
      '<div class="reader-set-label">Листание</div>' +
      segHtml('mode', [['scroll', 'Прокрутка'], ['pages', 'Страницы']]) +
      '<p class="muted reader-set-hint">' + (settings.mode === 'pages'
        ? 'Тап по левому/правому краю — страница назад/вперёд, по центру — меню.'
        : 'Листайте пальцем. Тап по центру — показать/скрыть меню.') + '</p>' +
      '<div class="row reader-set-switch"><span>Не гасить экран' + (wakeSupported ? '' : ' <small class="muted">(не поддерживается)</small>') + '</span>' +
      '<label class="switch"><input type="checkbox" id="reader-wake"' + (settings.wake ? ' checked' : '') + (wakeSupported ? '' : ' disabled') + ' /><span class="slider"></span></label></div>';
    var range = $('reader-size-range');
    if (range) {
      range.addEventListener('input', function () { changeSetting('size', parseInt(range.value, 10)); });
    }
    var wake = $('reader-wake');
    if (wake) wake.addEventListener('change', function () { changeSetting('wake', !!wake.checked); });
  }

  function onSheetClick(e) {
    var sb = e.target.closest('[data-size]');
    if (sb) {
      var v = Math.max(14, Math.min(30, settings.size + parseInt(sb.getAttribute('data-size'), 10)));
      changeSetting('size', v);
      return;
    }
    var btn = e.target.closest('[data-val]');
    var group = btn && btn.closest('[data-key]');
    if (!btn || !group) return;
    var key = group.getAttribute('data-key');
    var val = btn.getAttribute('data-val');
    if (key === 'lh') val = parseFloat(val);
    changeSetting(key, val);
  }

  /* ================= Открыть / закрыть ================= */

  var appThemeColor = null;

  async function openBook(id, opts) {
    opts = opts || {};
    var meta = await LexDB.getDocument(id);
    if (!meta) throw new Error('Книга не найдена');
    var cont = await LexDB.getBookContent(id);
    if (!cont && typeof meta.text === 'string') {
      var conv = LexDB.legacyDocToBook(meta);
      meta = conv.meta;
      cont = conv.content;
      await LexDB.putBook(meta, cont);
    }
    if (!cont || !cont.chapters || !cont.chapters.length) throw new Error('Текст книги не найден');
    book = meta;
    book.bookmarks = book.bookmarks || [];
    content = cont;
    onCloseCb = opts.onClose || null;
    var overlay = $('reader-overlay');
    var tc = document.querySelector('meta[name="theme-color"]');
    if (tc) appThemeColor = tc.getAttribute('content');
    applySettings();
    setChromeHidden(false);
    closePanels();
    overlay.classList.remove('hidden');
    overlay.setAttribute('aria-hidden', 'false');
    document.body.classList.add('reader-open');
    var pos = opts.pos || book.pos || { ch: 0, para: 0, frac: 0 };
    renderChapter(pos.ch || 0);
    // двойное восстановление: сразу и после раскладки шрифтов
    restorePos(pos);
    requestAnimationFrame(function () { restorePos(pos); });
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () { if (book && book.id === id) restorePos(currentPos || pos); });
    }
    book.lastOpenedAt = Date.now();
    persistPos();
    updateWakeLock();
    applySettings();
  }

  function closeReader() {
    if (!book) return;
    currentPos = computePos();
    persistPos();
    closeBubble();
    closePanels();
    clearHold();
    var overlay = $('reader-overlay');
    if (overlay) {
      overlay.classList.add('hidden');
      overlay.setAttribute('aria-hidden', 'true');
    }
    document.body.classList.remove('reader-open');
    var tc = document.querySelector('meta[name="theme-color"]');
    if (tc && appThemeColor) tc.setAttribute('content', appThemeColor);
    var body = $('reader-body');
    if (body) body.innerHTML = '';
    var closedId = book.id;
    book = null;
    content = null;
    paraEls = [];
    paraWords = [];
    currentPos = null;
    updateWakeLock();
    var cb = onCloseCb;
    onCloseCb = null;
    if (cb) cb(closedId);
  }

  function currentBookId() { return book ? book.id : null; }

  /* ================= Привязка событий ================= */

  function bind() {
    if (bound) return;
    bound = true;
    var sc = $('reader-scroll');
    $('reader-close').addEventListener('click', closeReader);
    $('reader-btn-toc').addEventListener('click', function () {
      drawerTab = 'toc';
      openPanel('reader-drawer');
      renderDrawer();
    });
    $('reader-btn-settings').addEventListener('click', function () {
      renderSettingsSheet();
      openPanel('reader-sheet');
    });
    $('reader-btn-bookmark').addEventListener('click', toggleBookmark);
    $('reader-prev').addEventListener('click', function () { goChapter(chIndex - 1, 'start'); persistPos(); });
    $('reader-next').addEventListener('click', function () { goChapter(chIndex + 1, 'start'); persistPos(); });
    $('reader-backdrop').addEventListener('click', closePanels);
    $('reader-drawer').addEventListener('click', onDrawerClick);
    $('reader-sheet').addEventListener('click', onSheetClick);
    document.querySelectorAll('[data-close-panel]').forEach(function (b) {
      b.addEventListener('click', closePanels);
    });
    $('reader-body').addEventListener('click', function (e) {
      var nb = e.target.closest('[data-act="next-ch"]');
      if (nb) {
        goChapter(chIndex + 1, 'start');
        persistPos();
      }
    });
    sc.addEventListener('scroll', onScroll, { passive: true });
    sc.addEventListener('click', onReaderTap);
    sc.addEventListener('pointerdown', onPointerDown, { passive: true });
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerup', onPointerUp, { passive: true });
    window.addEventListener('pointercancel', clearHold, { passive: true });
    document.addEventListener('click', onDocClick, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('contextmenu', onContextMenu, true);
    document.addEventListener('visibilitychange', function () {
      if (!book) return;
      if (document.visibilityState === 'hidden') {
        currentPos = computePos();
        persistPos();
      }
      updateWakeLock();
    });
    window.addEventListener('pagehide', function () {
      if (book) { currentPos = computePos(); persistPos(); }
    });
    window.addEventListener('resize', function () {
      if (!book || !currentPos) return;
      var keep = currentPos;
      requestAnimationFrame(function () { restorePos(keep); });
    });
  }

  function init() {
    bind();
    ensureBubbleHost();
    applySettings();
  }

  global.LexBookReader = {
    init: init,
    openBook: openBook,
    closeReader: closeReader,
    currentBookId: currentBookId,
    closeBubble: closeBubble,
    getSettings: function () { return Object.assign({}, settings); },
    // для тестов
    _computePos: computePos,
    _pageBy: pageBy
  };
})(typeof window !== 'undefined' ? window : self);
