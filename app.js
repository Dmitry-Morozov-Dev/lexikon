/**
 * Лексикон — основной UI и логика.
 * Зависит от LexSRS (srs.js) и LexDB (db.js).
 */
(function () {
  'use strict';

  var SETTINGS_KEY = 'lexikon-settings';
  var ONBOARD_KEY = 'lexikon-onboard-done';
  var UNDO_KNOWN_KEY = 'lexikon-undo-known';
  var NEW_TODAY_KEY = 'lexikon-new-today';
  var SWIPE_THRESHOLD = 110;
  var SWIPE_UP_THRESHOLD = 90;
  var AXIS_LOCK_PX = 12;
  var HOLD_DISMISS_MS = 2500;
  var HOLD_MOVE_CANCEL_PX = 12;
  var REVERSE_REVIEW_CHANCE = 0.45;
  var QUEUE_REFILL_AT = 8;
  var QUEUE_TARGET = 24;
  var NEW_PAUSE_HIGH = 40;
  var NEW_PAUSE_LOW = 25;
  var LIGHT_REQUEUE_MS = 5 * 60 * 1000;

  /** Перемешать массив на месте (Фишер–Йейтс). */
  function shuffleInPlace(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }

  var state = {
    settings: {
      theme: 'dark',
      newPerDay: 20,
      participate: {}
    },
    decksMeta: [],
    deckCards: {},      // deckId -> [cards]
    deckAvailable: {},  // deckId -> bool
    ownCards: [],
    queue: [],
    current: null,
    revealed: false,
    newShownToday: 0,
    newTodayIds: {},
    todayKey: '',
    gradingBusy: false,
    reversePrompt: false,
    streamUnknown: 0,
    streamKnown: 0,
    streamDue: 0,
    pauseNew: false
  };

  /** После long-press не срабатывать click→reveal. */
  var suppressCardClick = false;

  var els = {};

  function $(id) { return document.getElementById(id); }

  function loadSettings() {
    try {
      var raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        state.settings = Object.assign(state.settings, parsed);
      }
    } catch (e) { /* ignore */ }
  }

  function saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  }

  function applyTheme(theme) {
    state.settings.theme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === 'light' ? '#F4F1EA' : '#0E1114';
    saveSettings();
    document.querySelectorAll('#theme-seg button').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-theme') === theme);
    });
  }

  function toast(msg, kind) {
    var host = els.toastHost;
    var t = document.createElement('div');
    t.className = 'toast' + (kind ? ' ' + kind : '');
    t.textContent = msg;
    host.appendChild(t);
    setTimeout(function () {
      t.style.opacity = '0';
      setTimeout(function () { t.remove(); }, 220);
    }, 3200);
  }

  function todayKey() {
    return LexDB.dayKey(Date.now());
  }

  function startOfTomorrow() {
    var d = new Date();
    d.setHours(24, 0, 0, 0);
    return d.getTime();
  }

  function conceptFor(card) {
    var pos = (card.pos || '').toLowerCase();
    if (pos === 'verb') return 'action';
    if (pos === 'adj' || pos === 'adv') return 'emotion';
    if (pos === 'phrase') return 'speech';
    if (pos === 'prep' || pos === 'conj') return 'idea';
    return 'object';
  }

  function renderCardImage(wrap, card) {
    wrap.innerHTML = '';
    var letter = ((card.word || '?')[0] || '?').toUpperCase();
    var fallback = document.createElement('div');
    fallback.className = 'card-img-fallback';
    fallback.textContent = letter;

    var src = card.img || '';
    if (!src || card.imgSrc === 'letter') {
      wrap.appendChild(fallback);
      return;
    }

    if (src.indexOf('/icons/concepts/') === 0 || card.imgSrc === 'svg') {
      var imgSvg = document.createElement('img');
      imgSvg.loading = 'lazy';
      imgSvg.referrerPolicy = 'no-referrer';
      imgSvg.alt = card.imgAlt || card.word || '';
      imgSvg.src = src || ('icons/concepts/' + conceptFor(card) + '.svg');
      imgSvg.onerror = function () {
        wrap.innerHTML = '';
        wrap.appendChild(fallback);
      };
      wrap.appendChild(imgSvg);
      return;
    }

    var img = document.createElement('img');
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.alt = card.imgAlt || card.word || '';
    img.src = src;
    img.onerror = function () {
      wrap.innerHTML = '';
      var local = document.createElement('img');
      local.loading = 'lazy';
      local.referrerPolicy = 'no-referrer';
      local.alt = card.imgAlt || card.word || '';
      local.src = 'icons/concepts/' + conceptFor(card) + '.svg';
      local.onerror = function () {
        wrap.innerHTML = '';
        wrap.appendChild(fallback);
      };
      wrap.appendChild(local);
    };
    wrap.appendChild(img);
  }

  /** Сбросить оттенки/свайп/инлайн-стили карточки (без leftover tint). */
  function clearCardChrome(opts) {
    opts = opts || {};
    var node = els.card;
    node.classList.remove(
      'tint-know', 'tint-again', 'swipe-left', 'swipe-right', 'swipe-up',
      'dragging', 'holding', 'reverse-prompt'
    );
    if (!opts.keepEnter) node.classList.remove('card-enter');
    node.style.removeProperty('--swipe-tint');
    if (!opts.keepTransform) node.style.transform = '';
    if (!opts.keepOpacity) node.style.opacity = '';
  }

  function collectExamples(card) {
    var list = [];
    if (Array.isArray(card.examples) && card.examples.length) {
      card.examples.forEach(function (ex) {
        if (!ex) return;
        var en = (ex.en || '').trim();
        var ru = (ex.ru || '').trim();
        if (en) list.push({ en: en, ru: ru });
      });
    }
    if (!list.length && (card.ex || card.exRu)) {
      list.push({ en: (card.ex || '').trim(), ru: (card.exRu || '').trim() });
    }
    return list;
  }

  function collectCollocs(card) {
    if (Array.isArray(card.collocs) && card.collocs.length) {
      return card.collocs.map(function (c) { return String(c || '').trim(); }).filter(Boolean);
    }
    var raw = (card.colloc || '').trim();
    if (!raw) return [];
    return raw.split(/\s*[·•|,;/]\s*|\s+\/\s+/).map(function (s) { return s.trim(); }).filter(Boolean);
  }

  function renderExamples(card) {
    var host = els.cardExamples;
    host.innerHTML = '';
    var list = collectExamples(card);
    if (!list.length) {
      host.classList.add('hidden');
      return;
    }
    host.classList.remove('hidden');
    var ul = document.createElement('ul');
    ul.className = 'ex-list';
    list.forEach(function (item) {
      var li = document.createElement('li');
      li.className = 'ex-item';
      var en = document.createElement('div');
      en.className = 'ex-en';
      en.textContent = '“' + item.en + '”';
      li.appendChild(en);
      if (item.ru) {
        var ru = document.createElement('div');
        ru.className = 'ex-ru';
        ru.textContent = item.ru;
        li.appendChild(ru);
      }
      ul.appendChild(li);
    });
    host.appendChild(ul);
  }

  function renderCollocs(card) {
    var host = els.cardColloc;
    host.innerHTML = '';
    var items = collectCollocs(card);
    if (!items.length) {
      host.classList.add('hidden');
      return;
    }
    host.classList.remove('hidden');
    var label = document.createElement('span');
    label.className = 'colloc-label';
    label.textContent = '⇄';
    host.appendChild(label);
    items.forEach(function (c) {
      var chip = document.createElement('span');
      chip.className = 'colloc-chip';
      chip.textContent = c;
      host.appendChild(chip);
    });
  }

  var RANK_LABELS = { core: 'Ядро', useful: 'Полезно', rare: 'Редкое' };

  function renderMeta(card) {
    var host = els.cardMeta;
    host.innerHTML = '';
    var has = false;
    var rank = card.rank;
    if (rank && RANK_LABELS[rank]) {
      var chip = document.createElement('span');
      chip.className = 'rank-chip rank-' + rank;
      chip.textContent = RANK_LABELS[rank];
      chip.title = rank;
      host.appendChild(chip);
      has = true;
    }
    var bits = [];
    if (card.pattern) bits.push({ k: 'frame', v: card.pattern });
    if (card.syn) bits.push({ k: 'syn', v: card.syn });
    if (card.ant) bits.push({ k: 'ant', v: card.ant });
    bits.forEach(function (b) {
      var span = document.createElement('span');
      span.className = 'meta-bit meta-' + b.k;
      var lab = document.createElement('em');
      lab.textContent = b.k === 'frame' ? 'pattern' : b.k;
      span.appendChild(lab);
      span.appendChild(document.createTextNode(' ' + b.v));
      host.appendChild(span);
      has = true;
    });
    host.classList.toggle('hidden', !has);
  }

  function renderLinks(card) {
    var host = els.cardLinks;
    host.innerHTML = '';
    var word = (card.word || card.lemma || '').trim();
    if (!word) {
      host.classList.add('hidden');
      return;
    }
    host.classList.remove('hidden');
    var lemma = (card.lemma || word).trim();
    var links = [
      { label: 'Google', href: 'https://www.google.com/search?q=' + encodeURIComponent('define ' + word) },
      { label: 'Reverso', href: 'https://context.reverso.net/translation/english-russian/' + encodeURIComponent(word) },
      { label: 'YouGlish', href: 'https://youglish.com/pronounce/' + encodeURIComponent(word) + '/english/us' },
      { label: 'Cambridge', href: 'https://dictionary.cambridge.org/dictionary/english/' + encodeURIComponent(lemma || word) }
    ];
    links.forEach(function (L) {
      var a = document.createElement('a');
      a.className = 'ext-pill';
      a.href = L.href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = L.label;
      host.appendChild(a);
    });
  }

  /**
   * Показать карточку. Для learning/review иногда (~45%) reverse: RU на лицевой,
   * EN+IPA после «Показать» / свайп вверх.
   */
  async function showCard(card) {
    state.current = card;
    state.revealed = false;
    state.reversePrompt = false;
    var node = els.card;
    clearCardChrome({ keepOpacity: true, keepTransform: true, keepEnter: true });
    node.classList.remove('hidden');
    // Если не в середине fly→enter, нормализуем видимость
    if (!node.classList.contains('no-transition')) {
      node.style.transform = '';
      node.style.opacity = '';
      node.classList.remove('card-enter');
    }

    var prog = null;
    try { prog = await LexDB.getProgress(card.id); } catch (e) { /* ignore */ }
    if (state.current !== card) return;

    var isRepeat = !!(prog && (LexSRS.isLearning(prog) || prog.state === 'review'));
    state.reversePrompt = isRepeat && Math.random() < REVERSE_REVIEW_CHANCE;
    node.classList.toggle('reverse-prompt', !!state.reversePrompt);

    if (state.reversePrompt) {
      els.cardWord.textContent = card.tr || '';
      els.cardIpa.textContent = '';
      els.cardIpa.classList.add('hidden');
      updateSpeakBtn('');
    } else {
      els.cardWord.textContent = card.word || '';
      els.cardIpa.textContent = card.ipa || '';
      els.cardIpa.classList.remove('hidden');
      updateSpeakBtn(card.word);
    }
    els.cardPos.textContent = card.pos || '';
    els.reveal.classList.add('hidden');
    els.gradeRow.classList.add('hidden');
    els.btnReveal.classList.remove('hidden');
    els.cardTr.textContent = card.tr || '';
    renderExamples(card);
    renderCollocs(card);
    renderMeta(card);
    if (card.note) {
      els.cardNote.textContent = card.note;
      els.cardNote.classList.remove('hidden');
    } else {
      els.cardNote.textContent = '';
      els.cardNote.classList.add('hidden');
    }
    renderLinks(card);
    renderCardImage(els.cardImgWrap, card);
    els.todayEmpty.classList.add('hidden');
    els.studyArea.classList.remove('hidden');
    updateStreamCounts();
  }

  function revealCard() {
    if (!state.current || state.revealed) return;
    var card = state.current;
    state.revealed = true;
    if (state.reversePrompt) {
      // Лицевая была RU — после показа: EN + IPA, перевод RU внизу
      els.cardWord.textContent = card.word || '';
      els.cardIpa.textContent = card.ipa || '';
      els.cardIpa.classList.remove('hidden');
      els.cardTr.textContent = card.tr || '';
      updateSpeakBtn(card.word);
      els.card.classList.remove('reverse-prompt');
    }
    els.reveal.classList.remove('hidden');
    els.gradeRow.classList.remove('hidden');
    els.btnReveal.classList.add('hidden');
  }

  function updateSpeakBtn(word) {
    var btn = els.btnSpeak;
    if (!('speechSynthesis' in window)) {
      btn.classList.add('hidden');
      return;
    }
    btn.classList.toggle('hidden', !word);
  }

  function speak(word) {
    if (!('speechSynthesis' in window) || !word) return;
    try {
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(word);
      u.lang = 'en-US';
      u.rate = 0.95;
      window.speechSynthesis.speak(u);
    } catch (e) {
      toast('Не удалось произнести', 'error');
    }
  }

  function allLoadedCards() {
    var list = [];
    Object.keys(state.deckCards).forEach(function (id) {
      list = list.concat(state.deckCards[id]);
    });
    return list.concat(state.ownCards);
  }

  function participatingDeckIds() {
    return state.decksMeta
      .filter(function (d) {
        return state.deckAvailable[d.id] && state.settings.participate[d.id] !== false;
      })
      .map(function (d) { return d.id; });
  }

  function studyPool() {
    var part = participatingDeckIds();
    var pool = [];
    part.forEach(function (id) {
      pool = pool.concat(state.deckCards[id] || []);
    });
    return pool.concat(state.ownCards);
  }

  function updateStreamCounts() {
    els.todayCounts.textContent =
      'осталось ' + state.streamUnknown +
      ' · выучено ' + state.streamKnown +
      ' · due ' + state.streamDue;
  }

  function showEmptyStream() {
    clearCardChrome();
    els.card.classList.add('hidden');
    els.card.classList.remove('no-transition');
    els.gradeRow.classList.add('hidden');
    els.todayEmpty.classList.remove('hidden');
    els.btnSpeak.classList.add('hidden');
    state.current = null;
    state.reversePrompt = false;
    updateStreamCounts();
  }

  /** Вставить карточку в живую очередь через min..max позиций. */
  function requeueCard(card, minGap, maxGap) {
    var gap = minGap + Math.floor(Math.random() * (maxGap - minGap + 1));
    var at = Math.min(gap, state.queue.length);
    state.queue.splice(at, 0, card);
  }

  function loadNewToday() {
    try {
      var raw = localStorage.getItem(NEW_TODAY_KEY);
      if (raw) {
        var o = JSON.parse(raw);
        if (o && o.day === todayKey()) {
          state.newShownToday = o.count || 0;
          state.newTodayIds = o.ids || {};
          state.todayKey = o.day;
          return;
        }
      }
    } catch (e) { /* ignore */ }
    state.newShownToday = 0;
    state.newTodayIds = {};
    state.todayKey = todayKey();
    saveNewToday();
  }

  function saveNewToday() {
    state.todayKey = todayKey();
    localStorage.setItem(NEW_TODAY_KEY, JSON.stringify({
      day: state.todayKey,
      count: state.newShownToday,
      ids: state.newTodayIds || {}
    }));
  }

  function loadUndoKnown() {
    try {
      var raw = localStorage.getItem(UNDO_KNOWN_KEY);
      if (raw) {
        var arr = JSON.parse(raw);
        if (Array.isArray(arr)) return arr.slice(0, 20);
      }
    } catch (e) { /* ignore */ }
    return [];
  }

  function saveUndoKnown(list) {
    localStorage.setItem(UNDO_KNOWN_KEY, JSON.stringify((list || []).slice(0, 20)));
  }

  function pushUndoKnown(card) {
    pushUndoEntry(card, 'known', null);
  }

  /**
   * Единый стек отмены (~20): type 'known' (вправо навсегда) | 'dismissed' (удержание).
   * Для dismissed сохраняем prevProgress, чтобы вернуть learning/review.
   */
  function pushUndoEntry(card, type, prevProgress) {
    var list = loadUndoKnown().filter(function (x) { return x.id !== card.id; });
    var entry = {
      id: card.id,
      word: card.word || '',
      tr: card.tr || '',
      at: Date.now(),
      type: type || 'known'
    };
    if (type === 'dismissed' && prevProgress) {
      var snap = Object.assign({}, prevProgress);
      delete snap._firstTimeKnown;
      entry.prevProgress = snap;
    }
    list.unshift(entry);
    saveUndoKnown(list.slice(0, 20));
  }

  /**
   * Разбить пул: dueNow / learningLater / new / (review future + known — skip).
   */
  async function partitionStudyPool() {
    var progressList = await LexDB.getAllProgress();
    var byId = {};
    progressList.forEach(function (p) { byId[p.id] = p; });

    var pool = studyPool();
    var t = Date.now();
    var endToday = startOfTomorrow();
    var dueNow = [];
    var learningLater = [];
    var news = [];
    var knownCount = 0;
    var dueToday = 0;
    var unknownCount = 0;

    pool.forEach(function (card) {
      var p = byId[card.id];
      if (LexSRS.isHidden(p)) {
        // Убрано удержанием — никогда в поток
        return;
      }
      if (LexSRS.isKnown(p)) {
        knownCount += 1;
        return;
      }
      unknownCount += 1;
      if (!p || LexSRS.isNew(p)) {
        news.push(card);
        return;
      }
      if ((p.due || 0) > 0 && p.due <= endToday) dueToday += 1;
      if (LexSRS.isDue(p, t)) {
        dueNow.push(card);
        return;
      }
      if (LexSRS.isLearning(p)) {
        learningLater.push(card);
        return;
      }
      // review не due — пропускаем до срока
    });

    return {
      byId: byId,
      dueNow: dueNow,
      learningLater: learningLater,
      news: news,
      knownCount: knownCount,
      dueToday: dueToday,
      unknownCount: unknownCount
    };
  }

  function updatePauseNew(dueCount) {
    if (dueCount > NEW_PAUSE_HIGH) state.pauseNew = true;
    if (dueCount < NEW_PAUSE_LOW) state.pauseNew = false;
  }

  /**
   * Набрать очередь: due (shuffle) + new с балансом ~1:3; soft newPerDay;
   * при отсутствии due — продолжаем давать new; learningLater если нужно.
   */
  function composeQueue(parts, existingIds, target) {
    loadNewToday();
    var dueNow = parts.dueNow.filter(function (c) { return !existingIds[c.id]; });
    var news = parts.news.filter(function (c) { return !existingIds[c.id]; });
    var learningLater = parts.learningLater.filter(function (c) { return !existingIds[c.id]; });
    shuffleInPlace(dueNow);
    shuffleInPlace(news);
    learningLater.sort(function (a, b) {
      var da = (parts.byId[a.id] && parts.byId[a.id].due) || 0;
      var db = (parts.byId[b.id] && parts.byId[b.id].due) || 0;
      return da - db;
    });

    updatePauseNew(parts.dueNow.length);
    if (!state.newTodayIds) state.newTodayIds = {};

    // Уже введенные сегодня new — всегда можно вернуть в очередь;
    // soft cap / pause — только на свежие.
    var alreadyNews = [];
    var freshNews = [];
    news.forEach(function (c) {
      if (state.newTodayIds[c.id]) alreadyNews.push(c);
      else freshNews.push(c);
    });

    var softCap = state.settings.newPerDay; // 0 = ∞
    var dueExist = parts.dueNow.length > 0;
    var allowFresh = !state.pauseNew;
    var remainingCap;
    if (!allowFresh) {
      remainingCap = 0;
    } else if (!dueExist) {
      remainingCap = freshNews.length;
    } else if (softCap === 0) {
      remainingCap = freshNews.length;
    } else {
      remainingCap = Math.max(0, softCap - state.newShownToday);
    }

    var maxNewByRatio = dueExist
      ? Math.max(1, Math.ceil(Math.min(dueNow.length, target) / 3))
      : remainingCap;
    var freshBudget = Math.min(freshNews.length, remainingCap, maxNewByRatio);
    if (!dueExist) freshBudget = Math.min(freshNews.length, remainingCap);

    var newsToUse = alreadyNews.concat(freshNews.slice(0, freshBudget));
    var queue = [];
    var di = 0;
    var ni = 0;
    var introduced = 0;
    if (!state.newTodayIds) state.newTodayIds = {};

    function pushNewCard(c) {
      queue.push(c);
      if (!state.newTodayIds[c.id]) {
        state.newTodayIds[c.id] = 1;
        introduced += 1;
      }
    }

    while (queue.length < target && (di < dueNow.length || ni < newsToUse.length)) {
      var batch = 0;
      while (batch < 3 && di < dueNow.length && queue.length < target) {
        queue.push(dueNow[di++]);
        batch += 1;
      }
      if (ni < newsToUse.length && queue.length < target) {
        pushNewCard(newsToUse[ni++]);
      }
      if (batch === 0 && ni >= newsToUse.length) break;
    }

    while (queue.length < target && di < dueNow.length) {
      queue.push(dueNow[di++]);
    }
    while (queue.length < target && ni < newsToUse.length) {
      pushNewCard(newsToUse[ni++]);
    }

    // Активный learning ещё не due — чтобы сессия не обрывалась
    var li = 0;
    while (queue.length < target && li < learningLater.length) {
      queue.push(learningLater[li++]);
    }

    if (introduced > 0) {
      state.newShownToday += introduced;
      saveNewToday();
    }

    return queue;
  }

  /**
   * Бесконечный поток: due + new (баланс) + learning; review future / known — skip.
   * Сессия не заканчивается, пока есть не-known (кроме чистого future review).
   */
  async function buildQueue() {
    var parts = await partitionStudyPool();
    state.streamUnknown = parts.unknownCount;
    state.streamKnown = parts.knownCount;
    state.streamDue = parts.dueToday;

    var ids = {};
    state.queue = composeQueue(parts, ids, QUEUE_TARGET);

    if (!state.queue.length) {
      showEmptyStream();
      return;
    }
    await showCard(state.queue[0]);
  }

  async function refillQueue() {
    if (state.queue.length >= QUEUE_REFILL_AT) {
      // обновим счётчики без набора
      var snap = await partitionStudyPool();
      state.streamUnknown = snap.unknownCount;
      state.streamKnown = snap.knownCount;
      state.streamDue = snap.dueToday;
      updateStreamCounts();
      return;
    }

    var parts = await partitionStudyPool();
    state.streamUnknown = parts.unknownCount;
    state.streamKnown = parts.knownCount;
    state.streamDue = parts.dueToday;

    var inQueue = {};
    state.queue.forEach(function (c) { inQueue[c.id] = true; });
    if (state.current) inQueue[state.current.id] = true;

    var need = Math.max(QUEUE_TARGET - state.queue.length, 0);
    if (need > 0) {
      var extra = composeQueue(parts, inQueue, need);
      state.queue = state.queue.concat(extra);
    }
    updateStreamCounts();
  }

  function playCardEnter(done) {
    var node = els.card;
    node.classList.add('no-transition');
    node.style.opacity = '0';
    node.style.transform = '';
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        node.classList.remove('no-transition');
        node.style.opacity = '';
        node.classList.remove('card-enter');
        void node.offsetWidth;
        node.classList.add('card-enter');
        setTimeout(function () {
          node.classList.remove('card-enter');
          if (done) done();
        }, 300);
      });
    });
  }

  function openUndoModal() {
    var list = loadUndoKnown();
    var host = els.modalHost;
    host.innerHTML = '';
    var back = document.createElement('div');
    back.className = 'modal-backdrop';
    var rows = list.length
      ? list.map(function (item, idx) {
          var kind = item.type === 'dismissed' ? 'удержание' : 'вправо';
          return (
            '<button type="button" class="undo-item" data-idx="' + idx + '">' +
            '<span class="undo-item-top">' +
            '<span class="undo-word">' + escapeHtml(item.word) + '</span>' +
            '<span class="undo-kind">' + kind + '</span>' +
            '</span>' +
            '<span class="undo-tr">' + escapeHtml(item.tr) + '</span>' +
            '</button>'
          );
        }).join('')
      : '<p class="muted" style="margin:8px 0">Пока нечего отменять: вправо навсегда или удержание.</p>';
    back.innerHTML =
      '<div class="modal" role="dialog" aria-label="Отмена">' +
      '<div class="modal-head"><h3>Отмена</h3>' +
      '<button type="button" class="btn btn-ghost" id="undo-close" aria-label="Закрыть">✕</button></div>' +
      '<p class="muted" style="margin:0 0 10px;font-size:0.85rem">Последние 20: «вправо» (выучено навсегда) и «удержание» (убрано из ленты). Вернёт карточку в поток.</p>' +
      '<div class="undo-list">' + rows + '</div>' +
      '</div>';
    host.appendChild(back);
    function close() { host.innerHTML = ''; }
    back.addEventListener('click', function (e) { if (e.target === back) close(); });
    var closeBtn = $('undo-close');
    if (closeBtn) closeBtn.addEventListener('click', close);
    back.querySelectorAll('.undo-item').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var idx = parseInt(btn.getAttribute('data-idx'), 10);
        close();
        undoStackItem(idx);
      });
    });
  }

  async function undoStackItem(idx) {
    var list = loadUndoKnown();
    var item = list[idx];
    if (!item) return;
    list.splice(idx, 1);
    saveUndoKnown(list);

    var restored;
    if (item.type === 'dismissed' && item.prevProgress && item.prevProgress.id) {
      restored = Object.assign({}, item.prevProgress);
      delete restored._firstTimeKnown;
    } else {
      restored = LexSRS.createProgress(item.id);
    }
    try {
      await LexDB.putProgress(restored);
    } catch (e) {
      toast('Не удалось откатить', 'error');
      return;
    }

    // Найти карточку в пуле
    var pool = studyPool();
    var card = null;
    for (var i = 0; i < pool.length; i++) {
      if (pool[i].id === item.id) { card = pool[i]; break; }
    }
    if (!card) {
      card = {
        id: item.id,
        word: item.word,
        tr: item.tr,
        ipa: '',
        pos: '',
        ex: '',
        exRu: ''
      };
    }

    // Убрать дубликаты из очереди, вставить следующей
    state.queue = state.queue.filter(function (c) { return c.id !== card.id; });
    var insertAt = state.current && state.queue[0] && state.queue[0].id === state.current.id ? 1 : 0;
    state.queue.splice(insertAt, 0, card);

    if (item.type !== 'dismissed') {
      state.streamKnown = Math.max(0, state.streamKnown - 1);
    }
    state.streamUnknown += 1;
    updateStreamCounts();

    if (!state.current) {
      await showCard(state.queue[0]);
    }
    toast('«' + (card.word || item.word) + '» снова в потоке', 'ok');
    refreshStatsQuiet();
  }

  /** Совместимость: старое имя. */
  async function undoFirstTimeKnown(idx) {
    return undoStackItem(idx);
  }

  /**
   * Убрать текущую карточку из ленты навсегда (long-press).
   * Пишет state 'hidden', кладёт в общий undo-стек.
   */
  async function dismissCurrentCard() {
    var card = state.current;
    if (!card || state.gradingBusy) return;
    state.gradingBusy = true;
    suppressCardClick = true;

    var prev = null;
    try {
      prev = await LexDB.getProgress(card.id);
      var base = prev ? Object.assign({}, prev) : LexSRS.createProgress(card.id);
      delete base._firstTimeKnown;
      LexSRS.markHidden(base);
      await LexDB.putProgress(base);
      pushUndoEntry(card, 'dismissed', prev || null);
    } catch (e) {
      state.gradingBusy = false;
      toast('Не удалось убрать', 'error');
      return;
    }

    try {
      if (navigator.vibrate) navigator.vibrate(28);
    } catch (e) { /* ignore */ }
    toast('Убрано из ленты · ↩ отмена', 'ok');

    var node = els.card;
    node.classList.remove('dragging', 'holding', 'tint-know', 'tint-again');
    node.style.transform = '';
    node.style.opacity = '';
    node.classList.add('swipe-up');

    setTimeout(async function () {
      node.classList.add('no-transition');
      node.classList.remove('swipe-up', 'swipe-left', 'swipe-right', 'tint-know', 'tint-again', 'dragging', 'holding');
      node.style.removeProperty('--swipe-tint');
      node.style.opacity = '0';
      node.style.transform = '';

      if (state.queue.length && state.queue[0] && state.queue[0].id === card.id) {
        state.queue.shift();
      } else {
        state.queue = state.queue.filter(function (c) { return c.id !== card.id; });
      }

      await refillQueue();

      if (!state.queue.length) {
        var parts = await partitionStudyPool();
        state.streamUnknown = parts.unknownCount;
        state.streamKnown = parts.knownCount;
        state.streamDue = parts.dueToday;
        if (parts.dueNow.length || parts.news.length || parts.learningLater.length) {
          state.queue = composeQueue(parts, {}, QUEUE_TARGET);
        }
      }

      if (!state.queue.length) {
        showEmptyStream();
        state.gradingBusy = false;
        refreshStatsQuiet();
        return;
      }

      await showCard(state.queue[0]);
      playCardEnter(function () {
        state.gradingBusy = false;
      });
      refreshStatsQuiet();
    }, 280);
  }

  async function grade(quality) {
    var card = state.current;
    if (!card || state.gradingBusy) return;
    state.gradingBusy = true;

    var next = null;
    var firstTimeKnown = false;
    try {
      var prog = await LexDB.ensureProgress(card.id);
      next = LexSRS.review(prog, quality);
      firstTimeKnown = !!next._firstTimeKnown;
      var toSave = Object.assign({}, next);
      delete toSave._firstTimeKnown;
      await LexDB.putProgress(toSave);
      await LexDB.addReview(card.id, quality);
      if (firstTimeKnown) pushUndoKnown(card);
    } catch (e) {
      state.gradingBusy = false;
      toast('Не удалось сохранить ответ', 'error');
      return;
    }

    var node = els.card;
    var dir = quality === 0 || quality === 1 ? 'swipe-left' : 'swipe-right';
    node.classList.remove('dragging');
    node.style.transform = '';
    node.style.opacity = '';
    if (quality === 0 || quality === 1) {
      node.classList.add('tint-again');
      node.classList.remove('tint-know');
      if (!node.style.getPropertyValue('--swipe-tint')) {
        node.style.setProperty('--swipe-tint', '0.32');
      }
    } else {
      node.classList.add('tint-know');
      node.classList.remove('tint-again');
      if (!node.style.getPropertyValue('--swipe-tint')) {
        node.style.setProperty('--swipe-tint', '0.32');
      }
    }
    node.classList.add(dir);

    setTimeout(async function () {
      node.classList.add('no-transition');
      node.classList.remove('swipe-left', 'swipe-right', 'swipe-up', 'tint-know', 'tint-again', 'dragging', 'holding', 'reverse-prompt');
      node.style.removeProperty('--swipe-tint');
      node.style.opacity = '0';
      node.style.transform = '';

      if (state.queue.length && state.queue[0] && state.queue[0].id === card.id) {
        state.queue.shift();
      } else {
        state.queue = state.queue.filter(function (c) { return c.id !== card.id; });
      }

      // Again → 2–4; Hard learning → 6–10; Good learning с due скоро — лёгкий requeue
      if (quality === 0) {
        requeueCard(card, 2, 4);
      } else if (quality === 1 && next && LexSRS.isLearning(next)) {
        requeueCard(card, 6, 10);
      } else if (
        quality === 2 &&
        next &&
        LexSRS.isLearning(next) &&
        (next.due - Date.now()) <= LIGHT_REQUEUE_MS
      ) {
        requeueCard(card, 8, 14);
      }

      await refillQueue();

      if (!state.queue.length) {
        var parts = await partitionStudyPool();
        state.streamUnknown = parts.unknownCount;
        state.streamKnown = parts.knownCount;
        state.streamDue = parts.dueToday;
        if (parts.dueNow.length || parts.news.length || parts.learningLater.length) {
          state.queue = composeQueue(parts, {}, QUEUE_TARGET);
        }
      }

      if (!state.queue.length) {
        showEmptyStream();
        state.gradingBusy = false;
        refreshStatsQuiet();
        return;
      }

      await showCard(state.queue[0]);
      playCardEnter(function () {
        state.gradingBusy = false;
      });
      refreshStatsQuiet();
    }, 280);
  }

  /* ---- Decks ---- */
  async function refreshDecksCache() {
    toast('Обновляю колоды…');
    try {
      if (window.caches) {
        var keys = await caches.keys();
        await Promise.all(keys.map(function (k) {
          if (/lexikon-(shell|data)-/.test(k)) return caches.delete(k);
          return null;
        }));
      }
      if (navigator.serviceWorker) {
        var regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(function (r) { return r.unregister(); }));
      }
    } catch (e) { /* ignore */ }
    // жёсткая перезагрузка с сети
    location.reload(true);
  }

  async function loadDecks() {
    var res = await fetch('decks.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('Не удалось загрузить decks.json');
    var data = await res.json();
    state.decksMeta = data.decks || [];

    // defaults participate
    state.decksMeta.forEach(function (d) {
      if (state.settings.participate[d.id] === undefined) {
        state.settings.participate[d.id] = !!d.defaultParticipate;
      }
    });
    saveSettings();

    await Promise.all(state.decksMeta.map(async function (d) {
      try {
        var r = await fetch(d.path, { cache: 'no-cache' });
        if (!r.ok) throw new Error('missing');
        var json = await r.json();
        var cards = Array.isArray(json) ? json : (json.cards || []);
        cards.forEach(function (c) {
          c.deckId = d.id;
          c.source = 'builtin';
        });
        state.deckCards[d.id] = cards;
        state.deckAvailable[d.id] = true;
      } catch (e) {
        state.deckCards[d.id] = [];
        state.deckAvailable[d.id] = false;
      }
    }));

    state.ownCards = (await LexDB.getAllCards()).filter(function (c) {
      return c.source === 'own' || c.source === 'csv' || !c.source;
    });

    renderDeckList();
  }

  function renderDeckList() {
    var host = els.deckList;
    host.innerHTML = '';
    state.decksMeta.forEach(function (d) {
      var available = !!state.deckAvailable[d.id];
      var count = (state.deckCards[d.id] || []).length;
      var item = document.createElement('div');
      item.className = 'deck-item' + (available ? '' : ' unavailable');
      var checked = state.settings.participate[d.id] !== false;
      item.innerHTML =
        '<div class="deck-swatch" style="background:' + (d.color || 'var(--accent)') + '"></div>' +
        '<div class="deck-info"><strong>' + escapeHtml(d.title) + '</strong>' +
        '<small>' + (available ? (count + ' карточек') : 'Файл ещё не добавлен') +
        ' · ' + escapeHtml(d.description || '') + '</small></div>';
      var lab = document.createElement('label');
      lab.className = 'switch';
      lab.title = 'Участвует в Сегодня';
      var inp = document.createElement('input');
      inp.type = 'checkbox';
      inp.checked = checked && available;
      inp.disabled = !available;
      inp.addEventListener('change', function () {
        state.settings.participate[d.id] = inp.checked;
        saveSettings();
        if (els.screenToday.classList.contains('active')) buildQueue();
      });
      var slider = document.createElement('span');
      slider.className = 'slider';
      lab.appendChild(inp);
      lab.appendChild(slider);
      item.appendChild(lab);
      host.appendChild(item);
    });
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ---- Search ---- */
  function doSearch(q) {
    q = (q || '').trim().toLowerCase();
    var ul = els.searchResults;
    ul.innerHTML = '';
    if (q.length < 1) return;
    var all = allLoadedCards();
    var hits = all.filter(function (c) {
      return (c.word || '').toLowerCase().indexOf(q) >= 0 ||
        (c.tr || '').toLowerCase().indexOf(q) >= 0 ||
        (c.lemma || '').toLowerCase().indexOf(q) >= 0;
    }).slice(0, 40);
    hits.forEach(function (c) {
      var li = document.createElement('li');
      li.innerHTML = '<div class="w-main"><strong>' + escapeHtml(c.word) + '</strong><small>' +
        escapeHtml(c.tr) + ' · ' + escapeHtml(c.level || '') + '</small></div>';
      var actions = document.createElement('div');
      var open = document.createElement('button');
      open.type = 'button';
      open.className = 'btn btn-ghost';
      open.textContent = '→';
      open.addEventListener('click', function () {
        navigate('today');
        state.queue = [c];
        showCard(c);
      });
      actions.appendChild(open);
      if (c.source === 'own' || c.source === 'csv') {
        var del = document.createElement('button');
        del.type = 'button';
        del.className = 'btn btn-ghost';
        del.textContent = '✕';
        del.addEventListener('click', async function () {
          await LexDB.deleteCard(c.id);
          state.ownCards = state.ownCards.filter(function (x) { return x.id !== c.id; });
          doSearch(els.searchInput.value);
          toast('Карточка удалена', 'ok');
        });
        actions.appendChild(del);
      }
      li.appendChild(actions);
      ul.appendChild(li);
    });
    if (!hits.length) {
      ul.innerHTML = '<li class="muted">Ничего не найдено</li>';
    }
  }

  /* ---- Add / edit ---- */
  function uid(prefix) {
    return (prefix || 'own') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  }

  async function saveOwnCard(data, existingId) {
    var examples = Array.isArray(data.examples) ? data.examples.slice() : [];
    if (!examples.length) {
      if (data.ex || data.exRu) examples.push({ en: data.ex || '', ru: data.exRu || '' });
      if (data.ex2 || data.ex2Ru) examples.push({ en: data.ex2 || '', ru: data.ex2Ru || '' });
    }
    examples = examples.filter(function (e) { return e && ((e.en || '').trim() || (e.ru || '').trim()); });
    var primary = examples[0] || { en: data.ex || '', ru: data.exRu || '' };
    var card = {
      id: existingId || uid('own'),
      word: data.word,
      lemma: data.lemma || data.word,
      ipa: data.ipa || '',
      pos: data.pos || 'other',
      level: data.level || 'custom',
      tr: data.tr || '',
      note: data.note || '',
      ex: primary.en || data.ex || '',
      exRu: primary.ru || data.exRu || '',
      examples: examples,
      colloc: data.colloc || '',
      pattern: data.pattern || '',
      syn: data.syn || '',
      ant: data.ant || '',
      img: data.img || '',
      imgSrc: data.img ? (data.img.indexOf('/icons/') === 0 ? 'svg' : 'url') : 'letter',
      imgAlt: data.word,
      deckId: 'own',
      source: 'own'
    };
    await LexDB.putCard(card);
    var idx = state.ownCards.findIndex(function (c) { return c.id === card.id; });
    if (idx >= 0) state.ownCards[idx] = card;
    else state.ownCards.push(card);
    return card;
  }

  function openEditModal(card) {
    var host = els.modalHost;
    host.innerHTML = '';
    var back = document.createElement('div');
    back.className = 'modal-backdrop';
    back.innerHTML =
      '<div class="modal" role="dialog">' +
      '<h3>Редактировать</h3>' +
      '<div class="field"><label>Слово</label><input id="e-word" value="' + escapeHtml(card.word) + '"/></div>' +
      '<div class="field"><label>IPA</label><input id="e-ipa" value="' + escapeHtml(card.ipa) + '"/></div>' +
      '<div class="field"><label>Перевод</label><input id="e-tr" value="' + escapeHtml(card.tr) + '"/></div>' +
      '<div class="field"><label>Пример 1 EN</label><textarea id="e-ex">' + escapeHtml(card.ex || (card.examples && card.examples[0] && card.examples[0].en) || '') + '</textarea></div>' +
      '<div class="field"><label>Пример 1 RU</label><textarea id="e-exRu">' + escapeHtml(card.exRu || (card.examples && card.examples[0] && card.examples[0].ru) || '') + '</textarea></div>' +
      '<div class="field"><label>Пример 2 EN</label><textarea id="e-ex2">' + escapeHtml((card.examples && card.examples[1] && card.examples[1].en) || '') + '</textarea></div>' +
      '<div class="field"><label>Пример 2 RU</label><textarea id="e-ex2Ru">' + escapeHtml((card.examples && card.examples[1] && card.examples[1].ru) || '') + '</textarea></div>' +
      '<div class="field"><label>Коллокации</label><input id="e-colloc" value="' + escapeHtml(card.colloc || '') + '"/></div>' +
      '<div class="field"><label>Заметка</label><input id="e-note" value="' + escapeHtml(card.note || '') + '"/></div>' +
      '<div class="field"><label>Картинка</label><input id="e-img" value="' + escapeHtml(card.img || '') + '"/></div>' +
      '<button type="button" class="btn btn-accent btn-block" id="e-save">Сохранить</button>' +
      (card.source === 'own' || card.source === 'csv'
        ? '<button type="button" class="btn btn-block" id="e-del" style="margin-top:8px;color:var(--again)">Удалить</button>'
        : '<p class="muted" style="margin-top:8px">Встроенная карточка: правка сохранится как своя копия.</p>') +
      '<button type="button" class="btn btn-ghost btn-block" id="e-cancel" style="margin-top:8px">Отмена</button>' +
      '</div>';
    host.appendChild(back);
    function close() { host.innerHTML = ''; }
    back.addEventListener('click', function (e) { if (e.target === back) close(); });
    $('e-cancel').addEventListener('click', close);
    $('e-save').addEventListener('click', async function () {
      var data = {
        word: $('e-word').value.trim(),
        ipa: $('e-ipa').value.trim(),
        tr: $('e-tr').value.trim(),
        ex: $('e-ex').value.trim(),
        exRu: $('e-exRu').value.trim(),
        ex2: ($('e-ex2') && $('e-ex2').value.trim()) || '',
        ex2Ru: ($('e-ex2Ru') && $('e-ex2Ru').value.trim()) || '',
        colloc: ($('e-colloc') && $('e-colloc').value.trim()) || '',
        note: $('e-note').value.trim(),
        img: $('e-img').value.trim(),
        pos: card.pos,
        level: card.level,
        pattern: card.pattern || '',
        syn: card.syn || '',
        ant: card.ant || ''
      };
      if (!data.word || !data.tr) {
        toast('Нужны слово и перевод', 'error');
        return;
      }
      var id = (card.source === 'own' || card.source === 'csv') ? card.id : uid('own');
      var saved = await saveOwnCard(Object.assign({}, card, data), id);
      // если правили встроенную — прогресс можно перенести
      if (id !== card.id) {
        var p = await LexDB.getProgress(card.id);
        if (p) {
          p.id = id;
          await LexDB.putProgress(p);
        }
      }
      close();
      toast('Сохранено', 'ok');
      if (state.current && (state.current.id === card.id || state.current.id === saved.id)) {
        var wasRevealed = state.revealed;
        showCard(saved).then(function () {
          if (wasRevealed) revealCard();
        });
      }
    });
    var delBtn = $('e-del');
    if (delBtn) {
      delBtn.addEventListener('click', async function () {
        await LexDB.deleteCard(card.id);
        state.ownCards = state.ownCards.filter(function (x) { return x.id !== card.id; });
        close();
        toast('Удалено', 'ok');
        buildQueue();
      });
    }
  }

  /* ---- CSV ---- */
  function parseCsv(text) {
    var lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(function (l) { return l.trim(); });
    if (!lines.length) return [];
    var headers = splitCsvLine(lines[0]).map(function (h) { return h.trim().toLowerCase(); });
    var rows = [];
    for (var i = 1; i < lines.length; i++) {
      var cols = splitCsvLine(lines[i]);
      var obj = {};
      headers.forEach(function (h, j) { obj[h] = (cols[j] || '').trim(); });
      rows.push(obj);
    }
    return rows;
  }

  function splitCsvLine(line) {
    var out = [];
    var cur = '';
    var q = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (ch === '"') {
        if (q && line[i + 1] === '"') { cur += '"'; i++; }
        else q = !q;
      } else if (ch === ',' && !q) {
        out.push(cur); cur = '';
      } else cur += ch;
    }
    out.push(cur);
    return out;
  }

  async function importCsvFile(file) {
    var text = await file.text();
    var rows = parseCsv(text);
    if (!rows.length) {
      toast('CSV пуст', 'error');
      return;
    }
    var cards = rows.map(function (r) {
      var word = r.word || r.en || '';
      return {
        id: uid('csv'),
        word: word,
        lemma: word,
        ipa: r.ipa || '',
        pos: r.pos || 'other',
        level: r.level || 'custom',
        tr: r.tr || r.ru || '',
        note: r.note || '',
        ex: r.ex || '',
        exRu: r.exru || r.exRu || '',
        colloc: r.colloc || '',
        img: r.img || '',
        imgSrc: r.img ? 'url' : 'letter',
        imgAlt: word,
        deckId: 'own',
        source: 'csv'
      };
    }).filter(function (c) { return c.word && c.tr; });
    await LexDB.putCards(cards);
    state.ownCards = state.ownCards.concat(cards);
    toast('Импортировано: ' + cards.length, 'ok');
  }

  /* ---- Stats ---- */
  async function refreshStatsQuiet() {
    try { await renderStats(); } catch (e) { /* ignore */ }
  }

  async function renderStats() {
    var reviews = await LexDB.getAllReviews();
    var progress = await LexDB.getAllProgress();
    var today = todayKey();
    var todayCount = reviews.filter(function (r) { return r.day === today; }).length;
    els.stToday.textContent = String(todayCount);

    var learned = progress.filter(function (p) {
      return LexSRS.isKnown(p);
    }).length;
    els.stLearned.textContent = String(learned);

    // «Завтра»: due к концу завтрашнего дня (review/learning), не known
    var tmr = startOfTomorrow() + 24 * 60 * 60 * 1000;
    var dueTmr = progress.filter(function (p) {
      return !LexSRS.isKnown(p) && !LexSRS.isHidden(p) && p.state !== 'new' && (p.due || 0) > 0 && p.due <= tmr;
    }).length;
    els.stDueTmr.textContent = String(dueTmr);

    // streak: consecutive days with ≥1 review ending today or yesterday
    var days = {};
    reviews.forEach(function (r) { days[r.day] = true; });
    var streak = 0;
    var cursor = new Date();
    // if no reviews today, start from yesterday
    var key = LexDB.dayKey(cursor.getTime());
    if (!days[key]) {
      cursor.setDate(cursor.getDate() - 1);
      key = LexDB.dayKey(cursor.getTime());
    }
    while (days[LexDB.dayKey(cursor.getTime())]) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    }
    els.stStreak.textContent = String(streak);

    // 14-day heat
    var heat = els.heatMap;
    heat.innerHTML = '';
    for (var i = 13; i >= 0; i--) {
      var d = new Date();
      d.setDate(d.getDate() - i);
      var k = LexDB.dayKey(d.getTime());
      var n = reviews.filter(function (r) { return r.day === k; }).length;
      var cell = document.createElement('div');
      cell.className = 'heat-cell' + (n > 0 ? (n >= 20 ? ' hot' : ' on') : '');
      cell.title = k + ': ' + n;
      cell.textContent = String(d.getDate());
      heat.appendChild(cell);
    }
  }

  /* ---- Onboarding ---- */
  var ONBOARD_SCREENS = [
    {
      title: 'Добро пожаловать в Лексикон',
      body: 'Учите английские слова до уровня C1. Карточки с интервальным повторением SM-2 — коротко и каждый день.'
    },
    {
      title: 'Как отвечать',
      body: 'Сначала вспомните перевод, затем «Показать» или свайп вверх. Вправо — знаю, влево — снова. Удержание ~2.5 с — убрать из ленты (↩ отмена). На повторах иногда сначала русский.'
    },
    {
      title: 'На iPhone',
      body: 'Safari → кнопка «Поделиться» → «На экран „Домой“». Данные хранятся только на устройстве: сделайте резервную копию в Настройках. Картинки из интернета кэшируются после первого показа; офлайн — SVG-заглушки.'
    }
  ];

  function showOnboard(force) {
    if (!force && localStorage.getItem(ONBOARD_KEY)) return;
    var host = els.onboard;
    var step = 0;
    host.classList.remove('hidden');
    function render() {
      var s = ONBOARD_SCREENS[step];
      host.innerHTML =
        '<h1>' + s.title + '</h1><p>' + s.body + '</p>' +
        '<div class="onboard-dots">' +
        ONBOARD_SCREENS.map(function (_, i) {
          return '<span class="' + (i === step ? 'on' : '') + '"></span>';
        }).join('') + '</div>' +
        '<button type="button" class="btn btn-accent btn-block" id="ob-next">' +
        (step === ONBOARD_SCREENS.length - 1 ? 'Начать' : 'Далее') + '</button>';
      $('ob-next').addEventListener('click', function () {
        if (step < ONBOARD_SCREENS.length - 1) {
          step++;
          render();
        } else {
          localStorage.setItem(ONBOARD_KEY, '1');
          host.classList.add('hidden');
          host.innerHTML = '';
        }
      });
    }
    render();
  }

  /* ---- Navigation ---- */
  function navigate(name) {
    document.querySelectorAll('.screen').forEach(function (s) {
      s.classList.toggle('active', s.getAttribute('data-screen') === name);
    });
    document.querySelectorAll('.bottom-nav button').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-nav') === name);
    });
    if (name === 'today') buildQueue();
    if (name === 'stats') renderStats();
    if (name === 'decks') renderDeckList();
  }

  /* ---- Swipe / hold / swipe-up ---- */
  function setupSwipe() {
    var card = els.card;
    var startX = 0, startY = 0, dx = 0, dy = 0, active = false;
    var axis = null; // 'h' | 'v' | null
    var holdTimer = null;
    var holdPulseTimer = null;
    var holdFired = false;
    var movedFar = false;

    function clearHoldTimers() {
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
      if (holdPulseTimer) { clearTimeout(holdPulseTimer); holdPulseTimer = null; }
      card.classList.remove('holding');
    }

    function armHold() {
      clearHoldTimers();
      holdFired = false;
      movedFar = false;
      // Мягкая подсветка через ~1 с удержания
      holdPulseTimer = setTimeout(function () {
        holdPulseTimer = null;
        if (active && !movedFar && !holdFired) card.classList.add('holding');
      }, 900);
      holdTimer = setTimeout(function () {
        holdTimer = null;
        if (!active || movedFar || holdFired || state.gradingBusy) return;
        if (Math.abs(dx) > HOLD_MOVE_CANCEL_PX || Math.abs(dy) > HOLD_MOVE_CANCEL_PX) return;
        holdFired = true;
        active = false;
        clearHoldTimers();
        card.classList.remove('dragging');
        clearSwipeTint();
        suppressCardClick = true;
        dismissCurrentCard();
      }, HOLD_DISMISS_MS);
    }

    function onStart(x, y) {
      if (!state.current || state.gradingBusy) return;
      // Не начинать жест с кнопок/ссылок на карточке
      active = true;
      axis = null;
      holdFired = false;
      movedFar = false;
      startX = x; startY = y; dx = 0; dy = 0;
      card.classList.add('dragging');
      armHold();
    }

    function clearSwipeTint() {
      card.classList.remove('tint-know', 'tint-again', 'swipe-left', 'swipe-right', 'swipe-up');
      card.style.transform = '';
      card.style.opacity = '';
      card.style.removeProperty('--swipe-tint');
    }

    function onMove(x, y, ev) {
      if (!active || holdFired) return;
      dx = x - startX;
      dy = y - startY;

      if (Math.abs(dx) > HOLD_MOVE_CANCEL_PX || Math.abs(dy) > HOLD_MOVE_CANCEL_PX) {
        movedFar = true;
        clearHoldTimers();
      }

      if (!axis) {
        if (Math.abs(dx) < AXIS_LOCK_PX && Math.abs(dy) < AXIS_LOCK_PX) return;
        axis = Math.abs(dx) >= Math.abs(dy) ? 'h' : 'v';
      }

      if (axis === 'h') {
        if (ev && ev.cancelable) ev.preventDefault();
        var rot = dx / 28;
        card.style.transform = 'translateX(' + dx + 'px) rotate(' + rot + 'deg)';
        card.style.opacity = String(Math.max(0.55, 1 - Math.abs(dx) / 520));
        var strength = Math.min(1, Math.abs(dx) / SWIPE_THRESHOLD);
        if (dx > 24) {
          card.classList.add('tint-know');
          card.classList.remove('tint-again');
          card.style.setProperty('--swipe-tint', String(0.12 + 0.28 * strength));
        } else if (dx < -24) {
          card.classList.add('tint-again');
          card.classList.remove('tint-know');
          card.style.setProperty('--swipe-tint', String(0.12 + 0.28 * strength));
        } else {
          card.classList.remove('tint-know', 'tint-again');
          card.style.removeProperty('--swipe-tint');
        }
        return;
      }

      // vertical: вверх = reveal (если ещё не показано); вниз — сброс
      if (dy < 0 && !state.revealed) {
        if (ev && ev.cancelable) ev.preventDefault();
        var lift = Math.min(36, -dy * 0.4);
        card.style.transform = 'translateY(' + (-lift) + 'px) scale(' + (1 + lift / 900) + ')';
        card.style.opacity = String(Math.max(0.82, 1 + dy / 500));
        card.classList.remove('tint-know', 'tint-again');
        card.style.removeProperty('--swipe-tint');
      } else if (dy > 0) {
        // лёгкий сдвиг вниз без конфликта со скроллом страницы
        card.style.transform = '';
        card.style.opacity = '';
      }
    }

    function onEnd() {
      if (holdFired) {
        active = false;
        return;
      }
      if (!active) return;
      active = false;
      clearHoldTimers();
      card.classList.remove('dragging');

      if (axis === 'h') {
        if (dx > SWIPE_THRESHOLD) {
          grade(2);
        } else if (dx < -SWIPE_THRESHOLD) {
          grade(0);
        } else {
          clearSwipeTint();
        }
        return;
      }

      if (axis === 'v') {
        if (dy < -SWIPE_UP_THRESHOLD && !state.revealed) {
          clearSwipeTint();
          revealCard();
        } else {
          clearSwipeTint();
        }
        return;
      }

      clearSwipeTint();
    }

    function onCancel() {
      if (holdFired) return;
      active = false;
      clearHoldTimers();
      card.classList.remove('dragging');
      clearSwipeTint();
    }

    card.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) return;
      if (e.target && e.target.closest && e.target.closest('button, a')) return;
      onStart(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });
    card.addEventListener('touchmove', function (e) {
      if (!active || e.touches.length !== 1) return;
      onMove(e.touches[0].clientX, e.touches[0].clientY, e);
    }, { passive: false });
    card.addEventListener('touchend', onEnd);
    card.addEventListener('touchcancel', onCancel);

    // mouse fallback (десктоп / отладка)
    card.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      if (e.target && e.target.closest && e.target.closest('button, a')) return;
      onStart(e.clientX, e.clientY);
    });
    window.addEventListener('mousemove', function (e) {
      if (active) onMove(e.clientX, e.clientY, null);
    });
    window.addEventListener('mouseup', onEnd);
  }

  /* ---- Backup ---- */
  async function exportBackup() {
    var data = await LexDB.exportAll();
    data.settings = state.settings;
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'lexikon-backup-' + todayKey() + '.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    toast('Экспорт готов', 'ok');
  }

  async function importBackup(file) {
    var text = await file.text();
    var data = JSON.parse(text);
    await LexDB.importAll(data, true);
    if (data.settings) {
      state.settings = Object.assign(state.settings, data.settings);
      saveSettings();
      applyTheme(state.settings.theme || 'dark');
    }
    state.ownCards = (await LexDB.getAllCards()).filter(function (c) {
      return c.source === 'own' || c.source === 'csv' || !c.source;
    });
    toast('Импорт завершён', 'ok');
    buildQueue();
    renderStats();
  }

  /* ---- Init ---- */
  function cacheEls() {
    els = {
      toastHost: $('toast-host'),
      onboard: $('onboard'),
      modalHost: $('modal-host'),
      card: $('vocab-card'),
      cardImgWrap: $('card-img-wrap'),
      cardWord: $('card-word'),
      cardIpa: $('card-ipa'),
      cardPos: $('card-pos'),
      cardTr: $('card-tr'),
      cardExamples: $('card-examples'),
      cardColloc: $('card-colloc'),
      cardMeta: $('card-meta'),
      cardNote: $('card-note'),
      cardLinks: $('card-links'),
      reveal: $('card-reveal'),
      btnReveal: $('btn-reveal'),
      btnSpeak: $('btn-speak'),
      btnEdit: $('btn-edit-card'),
      gradeRow: $('grade-row'),
      todayCounts: $('today-counts'),
      btnUndoKnown: $('btn-undo-known'),
      todayEmpty: $('today-empty'),
      studyArea: $('study-area'),
      deckList: $('deck-list'),
      searchInput: $('search-input'),
      searchResults: $('search-results'),
      screenToday: $('screen-today'),
      stStreak: $('st-streak'),
      stLearned: $('st-learned'),
      stDueTmr: $('st-due-tmr'),
      stToday: $('st-today'),
      heatMap: $('heat-map')
    };
  }

  function bind() {
    document.querySelectorAll('.bottom-nav button').forEach(function (b) {
      b.addEventListener('click', function () {
        navigate(b.getAttribute('data-nav'));
      });
    });

    $('btn-theme').addEventListener('click', function () {
      applyTheme(state.settings.theme === 'dark' ? 'light' : 'dark');
    });

    document.querySelectorAll('#theme-seg button').forEach(function (b) {
      b.addEventListener('click', function () {
        applyTheme(b.getAttribute('data-theme'));
      });
    });

    document.querySelectorAll('#new-per-day .chip').forEach(function (b) {
      b.addEventListener('click', function () {
        state.settings.newPerDay = parseInt(b.getAttribute('data-n'), 10);
        saveSettings();
        document.querySelectorAll('#new-per-day .chip').forEach(function (c) {
          c.classList.toggle('active', c === b);
        });
        buildQueue();
      });
    });

    els.btnReveal.addEventListener('click', revealCard);
    els.card.addEventListener('click', function (e) {
      if (e.target.closest('button, a')) return;
      if (suppressCardClick) {
        suppressCardClick = false;
        return;
      }
      if (!state.revealed) revealCard();
    });
    els.btnSpeak.addEventListener('click', function () {
      if (state.current) speak(state.current.word);
    });
    els.btnEdit.addEventListener('click', function () {
      if (state.current) openEditModal(state.current);
    });

    els.gradeRow.querySelectorAll('.grade-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        grade(parseInt(b.getAttribute('data-q'), 10));
      });
    });

    if (els.btnUndoKnown) {
      els.btnUndoKnown.addEventListener('click', openUndoModal);
    }

    els.searchInput.addEventListener('input', function () {
      doSearch(els.searchInput.value);
    });

    $('form-add').addEventListener('submit', async function (e) {
      e.preventDefault();
      var data = {
        word: $('f-word').value.trim(),
        ipa: $('f-ipa').value.trim(),
        pos: $('f-pos').value,
        tr: $('f-tr').value.trim(),
        ex: $('f-ex').value.trim(),
        exRu: $('f-exRu').value.trim(),
        ex2: ($('f-ex2') && $('f-ex2').value.trim()) || '',
        ex2Ru: ($('f-ex2Ru') && $('f-ex2Ru').value.trim()) || '',
        colloc: ($('f-colloc') && $('f-colloc').value.trim()) || '',
        level: $('f-level').value,
        img: $('f-img').value.trim(),
        note: $('f-note').value.trim()
      };
      if (!data.word || !data.tr) {
        toast('Нужны слово и перевод', 'error');
        return;
      }
      await saveOwnCard(data);
      $('form-add').reset();
      toast('Карточка добавлена', 'ok');
    });

    $('btn-import-csv').addEventListener('click', async function () {
      var f = $('csv-file').files[0];
      if (!f) { toast('Выберите CSV', 'error'); return; }
      try { await importCsvFile(f); }
      catch (err) { toast('Ошибка CSV: ' + err.message, 'error'); }
    });

    $('btn-refresh-decks').addEventListener('click', function () {
      refreshDecksCache();
    });
    $('btn-export').addEventListener('click', function () {
      exportBackup().catch(function (err) { toast(err.message, 'error'); });
    });
    $('btn-import-backup').addEventListener('click', async function () {
      var f = $('backup-file').files[0];
      if (!f) { toast('Выберите файл', 'error'); return; }
      try { await importBackup(f); }
      catch (err) { toast('Ошибка импорта: ' + err.message, 'error'); }
    });

    $('btn-reset-onboard').addEventListener('click', function () {
      localStorage.removeItem(ONBOARD_KEY);
      showOnboard(true);
    });

    setupSwipe();
  }

  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('./sw.js').catch(function () {
      /* тихо: file:// или ограниченный контекст */
    });
  }

  async function init() {
    cacheEls();
    loadSettings();
    applyTheme(state.settings.theme || 'dark');
    document.querySelectorAll('#new-per-day .chip').forEach(function (c) {
      var n = parseInt(c.getAttribute('data-n'), 10);
      c.classList.toggle('active', n === state.settings.newPerDay);
    });
    if (!('speechSynthesis' in window)) {
      els.btnSpeak.classList.add('hidden');
    }
    bind();
    registerSW();
    showOnboard(false);
    try {
      await LexDB.open();
      await loadDecks();
      await buildQueue();
    } catch (err) {
      toast('Ошибка загрузки: ' + err.message, 'error');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
