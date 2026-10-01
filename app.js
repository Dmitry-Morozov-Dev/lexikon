/**
 * Лексикон — основной UI и логика.
 * Зависит от LexSRS (srs.js) и LexDB (db.js).
 */
(function () {
  'use strict';

  var SETTINGS_KEY = 'lexikon-settings';
  var ONBOARD_KEY = 'lexikon-onboard-done';
  var SWIPE_THRESHOLD = 110;

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
    todayKey: ''
  };

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

  function showCard(card) {
    state.current = card;
    state.revealed = false;
    var node = els.card;
    node.classList.remove('hidden', 'swipe-left', 'swipe-right', 'dragging');
    node.style.transform = '';
    node.style.opacity = '';
    els.cardWord.textContent = card.word || '';
    els.cardIpa.textContent = card.ipa || '';
    els.cardPos.textContent = card.pos || '';
    els.reveal.classList.add('hidden');
    els.gradeRow.classList.add('hidden');
    els.btnReveal.classList.remove('hidden');
    els.cardTr.textContent = card.tr || '';
    els.cardEx.textContent = card.ex ? '“' + card.ex + '”' : '';
    els.cardExRu.textContent = card.exRu || '';
    if (card.colloc) {
      els.cardColloc.textContent = '⇄ ' + card.colloc;
      els.cardColloc.classList.remove('hidden');
    } else {
      els.cardColloc.classList.add('hidden');
    }
    if (card.note) {
      els.cardNote.textContent = card.note;
      els.cardNote.classList.remove('hidden');
    } else {
      els.cardNote.classList.add('hidden');
    }
    renderCardImage(els.cardImgWrap, card);
    els.todayEmpty.classList.add('hidden');
    els.studyArea.classList.remove('hidden');
    updateSpeakBtn(card.word);
  }

  function revealCard() {
    if (!state.current) return;
    state.revealed = true;
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

  async function buildQueue() {
    var progressList = await LexDB.getAllProgress();
    var byId = {};
    progressList.forEach(function (p) { byId[p.id] = p; });

    var part = participatingDeckIds();
    var pool = [];
    part.forEach(function (id) {
      pool = pool.concat(state.deckCards[id] || []);
    });
    // свои карточки всегда в пуле
    pool = pool.concat(state.ownCards);

    var due = [];
    var news = [];
    var now = Date.now();

    pool.forEach(function (card) {
      var p = byId[card.id];
      if (!p || p.state === 'new' || (p.repetition === 0 && p.state !== 'learning' && p.state !== 'relearning' && p.state !== 'review')) {
        news.push(card);
      } else if (LexSRS.isDue(p, now)) {
        due.push(card);
      }
    });

    // Перемешиваем: due и новые из всех выбранных колод вперемешку
    shuffleInPlace(due);
    shuffleInPlace(news);

    // лимит новых
    var limit = state.settings.newPerDay;
    var shownKey = 'newShown:' + todayKey();
    var shown = parseInt(sessionStorage.getItem(shownKey) || '0', 10) || 0;
    if (limit > 0) {
      news = news.slice(0, Math.max(0, limit - shown));
    }

    // Сначала повторы (уже перемешанные), потом новые из разных колод
    state.queue = due.concat(news);
    state.newShownToday = shown;

    els.todayCounts.textContent =
      'Повторы: ' + due.length + ' · Новые: ' + news.length;

    if (!state.queue.length) {
      els.card.classList.add('hidden');
      els.gradeRow.classList.add('hidden');
      els.todayEmpty.classList.remove('hidden');
      els.btnSpeak.classList.add('hidden');
      state.current = null;
      return;
    }
    showCard(state.queue[0]);
  }

  async function grade(quality) {
    var card = state.current;
    if (!card) return;
    // Свайп и кнопки работают и до «Показать»

    var prog = await LexDB.ensureProgress(card.id);
    var wasNew = prog.state === 'new';
    var next = LexSRS.review(prog, quality);
    await LexDB.putProgress(next);
    await LexDB.addReview(card.id, quality);

    if (wasNew) {
      var shownKey = 'newShown:' + todayKey();
      var shown = (parseInt(sessionStorage.getItem(shownKey) || '0', 10) || 0) + 1;
      sessionStorage.setItem(shownKey, String(shown));
    }

    // swipe visual
    var dir = quality === 0 || quality === 1 ? 'swipe-left' : 'swipe-right';
    els.card.classList.add(dir);
    setTimeout(function () {
      state.queue.shift();
      // «Снова»: вернуть карточку в очередь через пару позиций — повтор в этой же сессии
      if (quality === 0) {
        var insertAt = Math.min(3, state.queue.length);
        state.queue.splice(insertAt, 0, card);
      }
      if (!state.queue.length) {
        buildQueue();
      } else {
        showCard(state.queue[0]);
      }
      refreshStatsQuiet();
    }, 240);
  }

  /* ---- Decks ---- */
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
        var r = await fetch(d.path, { cache: 'default' });
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
    var card = {
      id: existingId || uid('own'),
      word: data.word,
      lemma: data.lemma || data.word,
      ipa: data.ipa || '',
      pos: data.pos || 'other',
      level: data.level || 'custom',
      tr: data.tr || '',
      note: data.note || '',
      ex: data.ex || '',
      exRu: data.exRu || '',
      colloc: data.colloc || '',
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
      '<div class="field"><label>Пример EN</label><textarea id="e-ex">' + escapeHtml(card.ex) + '</textarea></div>' +
      '<div class="field"><label>Пример RU</label><textarea id="e-exRu">' + escapeHtml(card.exRu) + '</textarea></div>' +
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
        note: $('e-note').value.trim(),
        img: $('e-img').value.trim(),
        pos: card.pos,
        level: card.level
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
        showCard(saved);
        if (state.revealed) revealCard();
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
      return p.state === 'review' && p.repetition >= 2;
    }).length;
    els.stLearned.textContent = String(learned);

    var tmr = startOfTomorrow() + 24 * 60 * 60 * 1000;
    var dueTmr = progress.filter(function (p) {
      return p.state !== 'new' && p.due > 0 && p.due <= tmr;
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
      body: 'Сначала вспомните перевод, затем «Показать». Снова / Трудно / Хорошо / Легко — или свайп влево/вправо по карточке.'
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

  /* ---- Swipe ---- */
  function setupSwipe() {
    var card = els.card;
    var startX = 0, startY = 0, dx = 0, dy = 0, active = false;

    function onStart(x, y) {
      if (!state.current) return;
      active = true;
      startX = x; startY = y; dx = 0; dy = 0;
      card.classList.add('dragging');
    }
    function clearSwipeTint() {
      card.classList.remove('tint-know', 'tint-again');
      card.style.transform = '';
      card.style.opacity = '';
      card.style.removeProperty('--swipe-tint');
    }
    function onMove(x, y) {
      if (!active) return;
      dx = x - startX; dy = y - startY;
      if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 12) {
        // vertical scroll intent
        return;
      }
      var rot = dx / 28;
      card.style.transform = 'translateX(' + dx + 'px) rotate(' + rot + 'deg)';
      card.style.opacity = String(Math.max(0.55, 1 - Math.abs(dx) / 520));
      // Полупрозрачный оттенок в стиле палитры
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
    }
    function onEnd() {
      if (!active) return;
      active = false;
      card.classList.remove('dragging');
      // Свайп без «Показать»: вправо — знаю, влево — повторить
      if (dx > SWIPE_THRESHOLD) {
        grade(2);
      } else if (dx < -SWIPE_THRESHOLD) {
        grade(0);
      } else {
        clearSwipeTint();
      }
    }

    card.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) return;
      onStart(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });
    card.addEventListener('touchmove', function (e) {
      if (!active || e.touches.length !== 1) return;
      onMove(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });
    card.addEventListener('touchend', onEnd);
    card.addEventListener('touchcancel', function () {
      active = false;
      card.classList.remove('dragging');
      clearSwipeTint();
    });

    // mouse fallback
    card.addEventListener('mousedown', function (e) {
      onStart(e.clientX, e.clientY);
    });
    window.addEventListener('mousemove', function (e) {
      if (active) onMove(e.clientX, e.clientY);
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
      cardEx: $('card-ex'),
      cardExRu: $('card-ex-ru'),
      cardColloc: $('card-colloc'),
      cardNote: $('card-note'),
      reveal: $('card-reveal'),
      btnReveal: $('btn-reveal'),
      btnSpeak: $('btn-speak'),
      btnEdit: $('btn-edit-card'),
      gradeRow: $('grade-row'),
      todayCounts: $('today-counts'),
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
      if (e.target.closest('button')) return;
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
