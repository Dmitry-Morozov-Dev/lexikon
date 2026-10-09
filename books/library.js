/**
 * Лексикон — Книги: библиотека (вкладка «Книги»). Грузится лениво.
 * Импорт (все форматы), «Продолжить чтение», обложки, прогресс, поиск/сортировка,
 * действия с книгой (в ленту, слова книги, переименовать, удалить), хранилище.
 */
(function (global) {
  'use strict';

  var U = global.LexBooksUtil;
  var VIEW_KEY = 'lexikon-library-view';
  var escapeHtml = U.escapeHtml;

  var view = loadView();
  var books = [];
  var covers = {};
  var wordCounts = {};
  var bound = false;
  var importing = false;
  var importErrors = [];

  function $(id) { return document.getElementById(id); }
  function bridge() { return global.LexikonBridge || null; }

  function toast(msg, kind) {
    var b = bridge();
    if (b && b.toast) b.toast(msg, kind);
  }

  function loadView() {
    var v = {};
    try { v = JSON.parse(localStorage.getItem(VIEW_KEY) || '{}') || {}; } catch (e) { v = {}; }
    return Object.assign({ sort: 'recent', layout: 'grid', q: '' }, v, { q: '' });
  }

  function saveView() {
    try { localStorage.setItem(VIEW_KEY, JSON.stringify({ sort: view.sort, layout: view.layout })); } catch (e) { /* ignore */ }
  }

  /* ================= Данные ================= */

  async function loadData() {
    var metas = await LexDB.getAllDocuments();
    books = metas.map(function (m) {
      // на всякий случай: старая запись с текстом (если миграция не прошла)
      if (typeof m.text === 'string') return LexDB.legacyDocToBook(m).meta;
      return m;
    });
    try {
      var cv = await LexDB.getAllCovers();
      covers = {};
      cv.forEach(function (c) { covers[c.id] = c.dataUrl; });
    } catch (e) { covers = {}; }
    wordCounts = {};
    try {
      var cards = await LexDB.getAllCards();
      cards.forEach(function (c) {
        if (c.source === 'pdf' && c.docId) wordCounts[c.docId] = (wordCounts[c.docId] || 0) + 1;
      });
    } catch (e) { /* ignore */ }
  }

  function sortedFiltered() {
    var q = view.q.trim().toLowerCase();
    var list = books.filter(function (b) {
      if (!q) return true;
      return (b.title || '').toLowerCase().indexOf(q) >= 0 || (b.author || '').toLowerCase().indexOf(q) >= 0;
    });
    list.sort(function (a, b) {
      if (view.sort === 'title') return (a.title || '').localeCompare(b.title || '', 'ru', { sensitivity: 'base' });
      if (view.sort === 'progress') return (b.progress || 0) - (a.progress || 0) || recentKey(b) - recentKey(a);
      if (view.sort === 'added') return (b.addedAt || b.createdAt || 0) - (a.addedAt || a.createdAt || 0);
      return recentKey(b) - recentKey(a);
    });
    return list;
  }

  function recentKey(b) {
    return Math.max(b.lastOpenedAt || 0, b.addedAt || b.createdAt || 0);
  }

  /* ================= Обложки ================= */

  function coverHtml(b, small) {
    var src = covers[b.id];
    if (src) {
      return '<div class="book-cover has-img' + (small ? ' is-small' : '') + '"><img src="' + escapeHtml(src) + '" alt="" loading="lazy" decoding="async" /></div>';
    }
    var c = U.coverColors(b.title + '|' + b.author);
    return '<div class="book-cover is-gen' + (small ? ' is-small' : '') + '" style="--cv-bg:' + c[0] + ';--cv-fg:' + c[1] + '">' +
      '<span class="book-cover-title">' + escapeHtml(b.title || 'Без названия') + '</span>' +
      (b.author ? '<span class="book-cover-author">' + escapeHtml(b.author) + '</span>' : '') +
      '</div>';
  }

  function pctOf(b) {
    return Math.floor((b.progress || 0) * 100);
  }

  function chapterTitleAt(b) {
    var ch = b.pos && b.toc ? b.toc[b.pos.ch] : null;
    return ch ? ch.title : '';
  }

  function minutesLeft(b) {
    return (1 - (b.progress || 0)) * (b.wordCount || 0) / U.READ_WPM;
  }

  function statsLine(b) {
    var parts = [];
    if (b.lastOpenedAt) parts.push(pctOf(b) + '%');
    else parts.push('новая');
    var wc = wordCounts[b.id] || 0;
    if (wc) parts.push(wc + ' ' + U.plural(wc, 'слово', 'слова', 'слов') + ' в колоде');
    return parts.join(' · ');
  }

  /* ================= Рендер ================= */

  function render() {
    var root = $('books-root');
    if (!root) return;
    if (!books.length) {
      root.innerHTML =
        '<div class="empty-state books-empty">' +
        '<div class="big">📚</div>' +
        '<p>Здесь будут ваши книги. Добавьте файл — текст разберётся прямо на устройстве и будет доступен офлайн.</p>' +
        '<p class="muted books-formats">EPUB · PDF · FB2 · TXT · DOCX · HTML · MD · RTF</p>' +
        '<button type="button" class="btn btn-accent" data-act="import">＋ Добавить книгу</button>' +
        '<p class="muted books-hint">Удерживайте незнакомое слово в тексте — появится перевод слова и всего предложения, а слово попадёт в колоду этой книги.</p>' +
        '</div>' + storageHtml();
      updateStorage();
      return;
    }
    var html = '';
    var last = books.filter(function (b) { return b.lastOpenedAt && (b.progress || 0) < 0.995; })
      .sort(function (a, b) { return b.lastOpenedAt - a.lastOpenedAt; })[0];
    if (last && !view.q) {
      html +=
        '<div class="book-continue" data-id="' + escapeHtml(last.id) + '">' +
        '<button type="button" class="book-continue-cover" data-open="' + escapeHtml(last.id) + '" aria-label="Продолжить">' + coverHtml(last, true) + '</button>' +
        '<div class="book-continue-info">' +
        '<span class="book-continue-label">Продолжить чтение</span>' +
        '<strong class="book-continue-title">' + escapeHtml(last.title) + '</strong>' +
        '<small class="muted">' + escapeHtml(chapterTitleAt(last) || last.author || '') + '</small>' +
        '<div class="book-progress"><i style="width:' + (last.progress || 0) * 100 + '%"></i></div>' +
        '<small class="muted">' + pctOf(last) + '% · осталось ' + escapeHtml(U.formatMinutes(minutesLeft(last))) + '</small>' +
        '</div>' +
        '<button type="button" class="btn btn-accent book-continue-btn" data-open="' + escapeHtml(last.id) + '">Читать</button>' +
        '</div>';
    }
    html +=
      '<div class="books-toolbar">' +
      '<input type="search" id="books-search" class="search-box books-search" placeholder="Поиск по названию или автору" value="' + escapeHtml(view.q) + '" enterkeyhint="search" />' +
      '<div class="books-toolbar-row">' +
      '<div class="seg books-sort" role="group" aria-label="Сортировка">' +
      [['recent', 'Недавние'], ['title', 'Название'], ['progress', 'Прогресс']].map(function (s) {
        return '<button type="button" data-sort="' + s[0] + '" class="' + (view.sort === s[0] ? 'active' : '') + '">' + s[1] + '</button>';
      }).join('') +
      '</div>' +
      '<button type="button" class="btn btn-ghost books-layout" data-layout="' + (view.layout === 'grid' ? 'list' : 'grid') + '" aria-label="Вид" title="' + (view.layout === 'grid' ? 'Списком' : 'Плиткой') + '">' + (view.layout === 'grid' ? '☰' : '▦') + '</button>' +
      '</div></div>';
    var list = sortedFiltered();
    if (!list.length) {
      html += '<p class="muted books-nothing">Ничего не найдено.</p>';
    } else {
      html += '<div class="books-grid' + (view.layout === 'list' ? ' is-list' : '') + '">' + list.map(function (b) {
        return '<div class="book-tile" data-id="' + escapeHtml(b.id) + '">' +
          '<button type="button" class="book-cover-btn" data-open="' + escapeHtml(b.id) + '" aria-label="Открыть «' + escapeHtml(b.title) + '»">' +
          coverHtml(b) +
          '<span class="book-fmt">' + escapeHtml(U.formatLabel(b.format)) + '</span>' +
          (b.lastOpenedAt ? '<span class="book-cover-progress"><i style="width:' + (b.progress || 0) * 100 + '%"></i></span>' : '') +
          '</button>' +
          '<div class="book-info">' +
          '<strong class="book-title" data-open="' + escapeHtml(b.id) + '">' + escapeHtml(b.title) + '</strong>' +
          (b.author ? '<small class="book-author">' + escapeHtml(b.author) + '</small>' : '') +
          '<small class="book-stats">' + escapeHtml(statsLine(b)) + (b.participate === false ? ' · <span class="book-off">не в ленте</span>' : '') + '</small>' +
          '</div>' +
          '<button type="button" class="btn btn-ghost book-more" data-more="' + escapeHtml(b.id) + '" aria-label="Действия с книгой">⋯</button>' +
          '</div>';
      }).join('') + '</div>';
    }
    html += storageHtml();
    root.innerHTML = html;
    var search = $('books-search');
    if (search) {
      search.addEventListener('input', function () {
        view.q = search.value;
        var pos = search.selectionStart;
        render();
        var s2 = $('books-search');
        if (s2) { s2.focus(); try { s2.setSelectionRange(pos, pos); } catch (e) { /* ignore */ } }
      });
    }
    updateStorage();
  }

  function storageHtml() {
    return '<div class="books-storage muted" id="books-storage">' +
      '<span id="books-storage-text"></span>' +
      '<button type="button" class="btn btn-ghost books-persist hidden" id="books-persist">Защитить от очистки</button>' +
      '</div>';
  }

  async function updateStorage() {
    var txt = $('books-storage-text');
    var btn = $('books-persist');
    if (!txt) return;
    var parts = [];
    var total = books.reduce(function (s, b) { return s + (b.wordCount || 0); }, 0);
    if (books.length) parts.push(books.length + ' ' + U.plural(books.length, 'книга', 'книги', 'книг') + ' · ' + U.formatWordCount(total));
    try {
      if (navigator.storage && navigator.storage.estimate) {
        var est = await navigator.storage.estimate();
        if (est && est.usage != null) parts.push('занято ' + U.formatBytes(est.usage) + (est.quota ? ' из ' + U.formatBytes(est.quota) : ''));
      }
      if (navigator.storage && navigator.storage.persisted) {
        var p = await navigator.storage.persisted();
        if (p) parts.push('защищено от автоочистки ✓');
        else if (btn && navigator.storage.persist) btn.classList.remove('hidden');
      }
    } catch (e) { /* ignore */ }
    txt.textContent = parts.join(' · ');
  }

  async function requestPersist(manual) {
    try {
      if (!navigator.storage || !navigator.storage.persist) return false;
      if (await navigator.storage.persisted()) return true;
      var ok = await navigator.storage.persist();
      if (manual) toast(ok ? 'Данные защищены от автоочистки' : 'Браузер не разрешил — добавьте приложение на экран «Домой» и делайте бэкап', ok ? 'ok' : 'error');
      return ok;
    } catch (e) { return false; }
  }

  /* ================= Импорт ================= */

  function setImportUi(state) {
    var box = $('books-import');
    if (!box) return;
    if (!state && !importErrors.length) {
      box.classList.add('hidden');
      box.innerHTML = '';
      return;
    }
    box.classList.remove('hidden');
    var html = '';
    if (state) {
      html += '<div class="books-import-row">' +
        '<span class="books-import-name">' + escapeHtml(state.name) + (state.total > 1 ? ' <small class="muted">(' + state.index + '/' + state.total + ')</small>' : '') + '</span>' +
        '<span class="books-import-pct">' + Math.round(state.frac * 100) + '%</span></div>' +
        '<div class="book-progress books-import-bar"><i style="width:' + (state.frac * 100).toFixed(1) + '%"></i></div>' +
        '<small class="muted">' + escapeHtml(state.label || '') + '</small>';
    }
    importErrors.forEach(function (er, i) {
      html += '<div class="books-import-error"><div><strong>' + escapeHtml(er.name) + '</strong><p>' + escapeHtml(er.message) + '</p></div>' +
        '<button type="button" class="btn btn-ghost" data-dismiss-err="' + i + '" aria-label="Скрыть">✕</button></div>';
    });
    box.innerHTML = html;
  }

  function loadParsers() {
    return U.loadScript('books/parsers.js').then(function () {
      if (!global.LexBookParsers) throw new Error('Парсеры не загрузились');
      return global.LexBookParsers;
    });
  }

  async function importFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []).filter(Boolean);
    if (!files.length) return;
    if (importing) { toast('Подождите — идёт импорт', 'error'); return; }
    importing = true;
    importErrors = [];
    var imported = [];
    try {
      var P = await loadParsers();
      for (var i = 0; i < files.length; i++) {
        var f = files[i];
        var st = { name: f.name, index: i + 1, total: files.length, frac: 0, label: 'Подготовка…' };
        setImportUi(st);
        var dup = books.filter(function (b) { return b.sourceName === f.name && b.size === f.size; })[0];
        if (dup && !confirm('«' + dup.title + '» уже есть в библиотеке. Добавить ещё раз?')) continue;
        try {
          var res = await P.parseFile(f, function (frac, label) {
            st.frac = Math.max(st.frac, Math.min(0.97, frac));
            st.label = label || st.label;
            setImportUi(st);
          });
          st.frac = 0.98;
          st.label = 'Сохранение…';
          setImportUi(st);
          await LexDB.putBook(res.meta, res.content, res.cover);
          imported.push(res.meta);
          books.push(res.meta);
          if (res.cover) covers[res.meta.id] = res.cover;
        } catch (err) {
          if (!(err && err.userFacing)) console.error(err);
          importErrors.push({
            name: f.name,
            message: err && err.userFacing ? err.message : 'Не удалось разобрать файл: ' + (err && err.message ? err.message : String(err))
          });
        }
      }
    } catch (err) {
      importErrors.push({ name: 'Импорт', message: err && err.message ? err.message : String(err) });
    } finally {
      importing = false;
    }
    setImportUi(null);
    if (imported.length) {
      toast(imported.length === 1
        ? 'Добавлено: «' + imported[0].title + '» · ' + U.formatWordCount(imported[0].wordCount)
        : 'Добавлено книг: ' + imported.length, 'ok');
      requestPersist(false);
    } else if (importErrors.length) {
      toast(importErrors[0].message, 'error');
    }
    await refresh();
    if (imported.length === 1 && !importErrors.length) openBook(imported[0].id);
    return imported;
  }

  /* ================= Открытие книги ================= */

  async function openBook(id, pos) {
    try {
      await global.LexBookReader.openBook(id, {
        pos: pos,
        onClose: function () { refresh(); }
      });
    } catch (err) {
      toast('Не удалось открыть: ' + (err && err.message ? err.message : String(err)), 'error');
    }
  }

  /* ================= Модальные окна ================= */

  function modal(html, onMount) {
    var host = $('modal-host');
    host.innerHTML = '';
    var back = document.createElement('div');
    back.className = 'modal-backdrop';
    back.innerHTML = '<div class="modal books-modal" role="dialog" aria-modal="true">' + html + '</div>';
    host.appendChild(back);
    function close() { host.innerHTML = ''; }
    back.addEventListener('click', function (e) { if (e.target === back) close(); });
    back.querySelectorAll('[data-close]').forEach(function (b) { b.addEventListener('click', close); });
    if (onMount) onMount(back, close);
    return close;
  }

  function findBook(id) {
    return books.filter(function (b) { return b.id === id; })[0] || null;
  }

  function bookSheet(id) {
    var b = findBook(id);
    if (!b) return;
    var wc = wordCounts[b.id] || 0;
    var chs = (b.toc || []).length;
    var details = [
      U.formatLabel(b.format),
      U.formatWordCount(b.wordCount || 0),
      chs + ' ' + U.plural(chs, 'глава', 'главы', 'глав'),
      b.size ? U.formatBytes(b.size) : '',
      'добавлена ' + U.formatDate(b.addedAt || b.createdAt)
    ].filter(Boolean).join(' · ');
    modal(
      '<div class="modal-head"><h3>Книга</h3><button type="button" class="btn btn-ghost" data-close aria-label="Закрыть">✕</button></div>' +
      '<div class="book-sheet-top">' + coverHtml(b, true) +
      '<div class="book-sheet-info"><strong>' + escapeHtml(b.title) + '</strong>' +
      (b.author ? '<span class="muted">' + escapeHtml(b.author) + '</span>' : '') +
      '<small class="muted">' + escapeHtml(details) + '</small>' +
      (b.lastOpenedAt ? '<small class="muted">Прочитано ' + pctOf(b) + '% · открыта ' + escapeHtml(U.formatDate(b.lastOpenedAt)) + '</small>' : '') +
      '</div></div>' +
      (b.annotation ? '<p class="book-annotation muted">' + escapeHtml(b.annotation.slice(0, 600)) + (b.annotation.length > 600 ? '…' : '') + '</p>' : '') +
      '<button type="button" class="btn btn-accent btn-block" data-a="open">' + (b.lastOpenedAt ? 'Продолжить чтение' : 'Читать') + '</button>' +
      '<div class="row book-sheet-row"><span>В ленте «Сегодня»<br><small class="muted">слова этой книги в повторении</small></span>' +
      '<label class="switch"><input type="checkbox" id="book-participate"' + (b.participate !== false ? ' checked' : '') + ' /><span class="slider"></span></label></div>' +
      '<button type="button" class="btn btn-block book-sheet-btn" data-a="words">Слова из книги (' + wc + ')</button>' +
      (b.lastOpenedAt ? '<button type="button" class="btn btn-block book-sheet-btn" data-a="restart">Читать с начала</button>' : '') +
      '<button type="button" class="btn btn-block book-sheet-btn" data-a="rename">Переименовать</button>' +
      '<button type="button" class="btn btn-block book-sheet-btn book-danger" data-a="delete">Удалить книгу</button>',
      function (root, close) {
        root.querySelector('[data-a="open"]').addEventListener('click', function () { close(); openBook(b.id); });
        var restart = root.querySelector('[data-a="restart"]');
        if (restart) restart.addEventListener('click', function () { close(); openBook(b.id, { ch: 0, para: 0, frac: 0 }); });
        root.querySelector('[data-a="words"]').addEventListener('click', function () { close(); wordsSheet(b.id); });
        root.querySelector('[data-a="rename"]').addEventListener('click', function () { close(); renameSheet(b.id); });
        root.querySelector('[data-a="delete"]').addEventListener('click', function () { close(); deleteSheet(b.id); });
        var sw = root.querySelector('#book-participate');
        sw.addEventListener('change', function () { setParticipate(b.id, sw.checked, sw); });
      }
    );
  }

  async function setParticipate(id, on, input) {
    try {
      var fresh = await LexDB.getDocument(id);
      if (!fresh) return;
      fresh.participate = !!on;
      await LexDB.putDocument(fresh);
      var b = findBook(id);
      if (b) b.participate = !!on;
      var br = bridge();
      if (br && br.onPdfParticipateChange) await br.onPdfParticipateChange();
      toast(on ? 'Слова книги участвуют в ленте' : 'Слова книги исключены из ленты', 'ok');
      render();
    } catch (err) {
      if (input) input.checked = !on;
      toast('Не удалось сохранить: ' + err.message, 'error');
    }
  }

  async function wordsSheet(id) {
    var b = findBook(id);
    if (!b) return;
    var cards = [];
    try { cards = await LexDB.getCardsByDeck('pdf:' + id); } catch (e) { cards = []; }
    cards.sort(function (x, y) { return (y.createdAt || 0) - (x.createdAt || 0); });
    modal(
      '<div class="modal-head"><h3>Слова из «' + escapeHtml(b.title) + '»</h3><button type="button" class="btn btn-ghost" data-close aria-label="Закрыть">✕</button></div>' +
      (cards.length
        ? '<p class="muted">' + cards.length + ' ' + U.plural(cards.length, 'слово', 'слова', 'слов') + (b.participate === false ? ' · колода не участвует в ленте' : ' · участвуют в ленте «Сегодня»') + '</p>' +
        '<ul class="word-list book-words">' + cards.map(function (c) {
          return '<li data-cid="' + escapeHtml(c.id) + '"><div class="book-word-main"><strong>' + escapeHtml(c.word) + '</strong> <span class="muted">— ' + escapeHtml(c.tr || '') + '</span>' +
            (c.contextSentence ? '<small class="muted book-word-ctx">' + escapeHtml(c.contextSentence) + '</small>' : '') + '</div>' +
            '<button type="button" class="btn btn-ghost" data-del-card="' + escapeHtml(c.id) + '" aria-label="Удалить слово">✕</button></li>';
        }).join('') + '</ul>'
        : '<p class="muted">Пока пусто. Откройте книгу и удерживайте незнакомое слово ~0,5 с — оно появится здесь и в ленте.</p>') +
      '<button type="button" class="btn btn-ghost btn-block" data-close>Закрыть</button>',
      function (root) {
        root.addEventListener('click', async function (e) {
          var del = e.target.closest('[data-del-card]');
          if (!del) return;
          var cid = del.getAttribute('data-del-card');
          var br = bridge();
          try {
            if (br && br.deleteCard) await br.deleteCard(cid);
            else await LexDB.deleteCard(cid);
            var li = del.closest('li');
            if (li) li.remove();
            wordCounts[id] = Math.max(0, (wordCounts[id] || 1) - 1);
            render();
          } catch (err) {
            toast('Не удалось удалить: ' + err.message, 'error');
          }
        });
      }
    );
  }

  function renameSheet(id) {
    var b = findBook(id);
    if (!b) return;
    modal(
      '<div class="modal-head"><h3>Переименовать</h3><button type="button" class="btn btn-ghost" data-close aria-label="Закрыть">✕</button></div>' +
      '<div class="field"><label for="bk-title">Название</label><input id="bk-title" value="' + escapeHtml(b.title) + '" autocomplete="off" /></div>' +
      '<div class="field"><label for="bk-author">Автор</label><input id="bk-author" value="' + escapeHtml(b.author || '') + '" autocomplete="off" /></div>' +
      '<button type="button" class="btn btn-accent btn-block" data-a="save">Сохранить</button>' +
      '<button type="button" class="btn btn-ghost btn-block" data-close style="margin-top:8px">Отмена</button>',
      function (root, close) {
        root.querySelector('[data-a="save"]').addEventListener('click', async function () {
          var t = root.querySelector('#bk-title').value.trim();
          var a = root.querySelector('#bk-author').value.trim();
          if (!t) { toast('Нужно название', 'error'); return; }
          try {
            var fresh = await LexDB.getDocument(id);
            fresh.title = t;
            fresh.author = a;
            await LexDB.putDocument(fresh);
            close();
            toast('Сохранено', 'ok');
            refresh();
          } catch (err) {
            toast('Ошибка: ' + err.message, 'error');
          }
        });
      }
    );
  }

  function deleteSheet(id) {
    var b = findBook(id);
    if (!b) return;
    var wc = wordCounts[id] || 0;
    modal(
      '<div class="modal-head"><h3>Удалить книгу?</h3><button type="button" class="btn btn-ghost" data-close aria-label="Закрыть">✕</button></div>' +
      '<p>«' + escapeHtml(b.title) + '» будет удалена с устройства вместе с позицией чтения и закладками.</p>' +
      (wc
        ? '<label class="book-del-words"><input type="checkbox" id="bk-del-words" /> <span>Удалить и сохранённые слова (' + wc + ')</span></label>' +
        '<p class="muted book-del-note">Если не отмечать — слова останутся в ваших карточках («Свои») вместе с прогрессом и примерами из книги.</p>'
        : '') +
      '<button type="button" class="btn btn-block book-danger-solid" data-a="del">Удалить</button>' +
      '<button type="button" class="btn btn-ghost btn-block" data-close style="margin-top:8px">Отмена</button>',
      function (root, close) {
        root.querySelector('[data-a="del"]').addEventListener('click', async function () {
          var chk = root.querySelector('#bk-del-words');
          var delWords = !!(chk && chk.checked);
          try {
            await deleteBook(id, delWords);
            close();
            toast('Книга удалена' + (wc ? (delWords ? ' вместе со словами' : ' · слова сохранены') : ''), 'ok');
          } catch (err) {
            toast('Не удалось удалить: ' + err.message, 'error');
          }
        });
      }
    );
  }

  async function deleteBook(id, deleteWords) {
    var b = findBook(id);
    var cards = await LexDB.getCardsByDeck('pdf:' + id);
    var br = bridge();
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      if (deleteWords) {
        if (br && br.deleteCard) await br.deleteCard(c.id);
        else await LexDB.deleteCard(c.id);
      } else {
        // карточка становится «своей»: id и прогресс сохраняются
        c.source = 'own';
        c.deckId = 'own';
        c.fromBook = (b && b.title) || c.bookTitle || '';
        if (c.fromBook && (c.note || '').indexOf(c.fromBook) < 0) {
          c.note = (c.note ? c.note + ' · ' : '') + 'из «' + c.fromBook + '»';
        }
        delete c.docId;
        await LexDB.putCard(c);
      }
    }
    if (global.LexBookReader && global.LexBookReader.currentBookId() === id) global.LexBookReader.closeReader();
    await LexDB.deleteDocument(id);
    if (br && br.refreshOwnCards) await br.refreshOwnCards();
    if (br && br.onPdfParticipateChange) await br.onPdfParticipateChange();
    await refresh();
  }

  /* ================= События ================= */

  function onRootClick(e) {
    var t = e.target;
    var open = t.closest('[data-open]');
    if (open) { openBook(open.getAttribute('data-open')); return; }
    var more = t.closest('[data-more]');
    if (more) { bookSheet(more.getAttribute('data-more')); return; }
    var sort = t.closest('[data-sort]');
    if (sort) { view.sort = sort.getAttribute('data-sort'); saveView(); render(); return; }
    var lay = t.closest('[data-layout]');
    if (lay) { view.layout = lay.getAttribute('data-layout'); saveView(); render(); return; }
    if (t.closest('[data-act="import"]')) { pick(); return; }
    if (t.closest('#books-persist')) { requestPersist(true).then(updateStorage); return; }
    var dis = t.closest('[data-dismiss-err]');
    if (dis) {
      importErrors.splice(parseInt(dis.getAttribute('data-dismiss-err'), 10), 1);
      setImportUi(null);
    }
  }

  function pick() {
    var input = $('book-file');
    if (!input) return;
    input.value = '';
    input.click();
  }

  function bindDragDrop() {
    var screen = $('screen-books');
    if (!screen) return;
    var depth = 0;
    screen.addEventListener('dragenter', function (e) {
      if (!e.dataTransfer || Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') < 0) return;
      e.preventDefault();
      depth++;
      screen.classList.add('is-drop');
    });
    screen.addEventListener('dragover', function (e) {
      if (!e.dataTransfer) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    screen.addEventListener('dragleave', function () {
      depth = Math.max(0, depth - 1);
      if (!depth) screen.classList.remove('is-drop');
    });
    screen.addEventListener('drop', function (e) {
      e.preventDefault();
      depth = 0;
      screen.classList.remove('is-drop');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) importFiles(e.dataTransfer.files);
    });
  }

  function bind() {
    if (bound) return;
    bound = true;
    var screen = $('screen-books');
    if (screen) screen.addEventListener('click', onRootClick);
    // кнопка «＋ Добавить» в шапке привязана в app.js (работает и до загрузки модуля)
    bindDragDrop();
  }

  async function refresh() {
    try {
      await loadData();
    } catch (err) {
      toast('Ошибка библиотеки: ' + err.message, 'error');
      return;
    }
    render();
  }

  function init() {
    bind();
    return refresh();
  }

  global.LexLibrary = {
    init: init,
    refresh: refresh,
    importFiles: importFiles,
    openBook: openBook,
    pick: pick,
    deleteBook: deleteBook
  };
})(typeof window !== 'undefined' ? window : self);
