/**
 * Лексикон — полная резервная копия (один .zip → всё 1:1 на другом телефоне).
 * В архиве: manifest.json (формат, версия схемы БД и приложения, счётчики), все хранилища IndexedDB
 * (карточки, прогресс SRS, история ответов, мета, книги: метаданные/позиции/закладки, тексты по книгам,
 * обложки) и все настройки localStorage «lexikon-*» (приложение, колоды, читалка, библиотека, отмена).
 * Кэш «% знакомых слов» не сохраняется — пересчитается сам.
 * Импорт: .zip (v4) и старые .json (v2/v3), проверка, сводка, «Заменить» или «Объединить».
 */
(function (global) {
  'use strict';

  var FORMAT = 'lexikon-backup';
  var FORMAT_VERSION = 4;
  var LS_PREFIX = 'lexikon-';
  var LS_SKIP = /^lexikon-test-/;

  function loadZip() {
    if (global.JSZip) return Promise.resolve(global.JSZip);
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'lib/jszip.min.js';
      s.onload = function () { resolve(global.JSZip); };
      s.onerror = function () { reject(new Error('Не удалось загрузить JSZip')); };
      document.head.appendChild(s);
    });
  }

  async function appVersion() {
    try {
      var r = await fetch('sw.js', { cache: 'no-store' }).catch(function () { return caches.match('sw.js'); });
      var t = r ? await r.text() : '';
      var m = t.match(/CACHE_SHELL\s*=\s*'([^']+)'/);
      if (m) return m[1];
    } catch (e) { /* ignore */ }
    return 'unknown';
  }

  function readLocalStorage() {
    var out = {};
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.indexOf(LS_PREFIX) === 0 && !LS_SKIP.test(k)) out[k] = localStorage.getItem(k);
    }
    return out;
  }

  function countSummary(d) {
    var cards = d.cards || [];
    var prog = d.progress || [];
    return {
      cards: cards.length,
      ownCards: cards.filter(function (c) { return c.source === 'own' || c.source === 'csv' || !c.source; }).length,
      bookCards: cards.filter(function (c) { return c.source === 'pdf'; }).length,
      progress: prog.length,
      known: prog.filter(function (p) { return p.state === 'known'; }).length,
      learning: prog.filter(function (p) { return p.state === 'learning' || p.state === 'relearning' || p.state === 'review'; }).length,
      hidden: prog.filter(function (p) { return p.state === 'hidden'; }).length,
      reviews: (d.reviews || []).length,
      books: (d.documents || []).length,
      settings: Object.keys(d.localStorage || {}).length
    };
  }

  function safeName(s) { return String(s).replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 80); }

  /** Собрать архив. → {blob, filename, summary, bytes} */
  async function build(onProgress) {
    var JSZip = await loadZip();
    var data = await LexDB.exportAll();
    var ls = readLocalStorage();
    var zip = new JSZip();
    var summary = countSummary(Object.assign({}, data, { localStorage: ls }));
    var manifest = {
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      dbVersion: LexDB.DB_VERSION || 3,
      appVersion: await appVersion(),
      exportedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      summary: summary,
      books: []
    };
    zip.file('db/cards.json', JSON.stringify(data.cards || []));
    zip.file('db/progress.json', JSON.stringify(data.progress || []));
    zip.file('db/reviews.json', JSON.stringify(data.reviews || []));
    zip.file('db/meta.json', JSON.stringify(data.meta || []));
    zip.file('db/documents.json', JSON.stringify(data.documents || []));
    // тексты — по файлу на книгу (меньше пиковой памяти на iPhone)
    (data.bookContent || []).forEach(function (c, i) {
      var name = 'books/' + i + '-' + safeName(c.id) + '.json';
      manifest.books.push({ id: c.id, file: name });
      zip.file(name, JSON.stringify(c));
    });
    data.bookContent = null;
    zip.file('db/bookCovers.json', JSON.stringify(data.bookCovers || []));
    zip.file('localStorage.json', JSON.stringify(ls));
    zip.file('manifest.json', JSON.stringify(manifest, null, 2));
    var blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 }, streamFiles: true, mimeType: 'application/zip' },
      function (meta) { if (onProgress) onProgress(meta.percent / 100); });
    var d = new Date();
    var stamp = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + '-' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0');
    return { blob: blob, filename: 'lexikon-backup-' + stamp + '.zip', summary: summary, bytes: blob.size, manifest: manifest };
  }

  function isArr(x) { return Array.isArray(x); }

  /** Прочитать файл копии (.zip v4 или старый .json) → {manifest, data} с проверкой. */
  async function parse(file) {
    var head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    var data, manifest;
    if (head[0] === 0x50 && head[1] === 0x4B) {
      var JSZip = await loadZip();
      var zip = await JSZip.loadAsync(file);
      var mf = zip.file('manifest.json');
      if (!mf) throw new Error('В архиве нет manifest.json — это не копия «Лексикона»');
      manifest = JSON.parse(await mf.async('string'));
      if (manifest.format !== FORMAT) throw new Error('Неизвестный формат архива');
      if (manifest.formatVersion > FORMAT_VERSION) throw new Error('Копия сделана более новой версией приложения — обновите приложение («Обновить колоды»)');
      var read = async function (name, def) {
        var f = zip.file(name);
        return f ? JSON.parse(await f.async('string')) : def;
      };
      data = {
        cards: await read('db/cards.json', []),
        progress: await read('db/progress.json', []),
        reviews: await read('db/reviews.json', []),
        meta: await read('db/meta.json', []),
        documents: await read('db/documents.json', []),
        bookCovers: await read('db/bookCovers.json', []),
        bookContent: [],
        localStorage: await read('localStorage.json', {})
      };
      for (var i = 0; i < (manifest.books || []).length; i++) {
        var c = await read(manifest.books[i].file, null);
        if (c) data.bookContent.push(c);
      }
    } else {
      // старый JSON-бэкап (v2: тексты PDF внутри documents; v3: + bookContent/bookCovers; settings отдельно)
      var raw;
      try { raw = JSON.parse(await file.text()); } catch (e) { throw new Error('Файл не читается как копия (не ZIP и не JSON)'); }
      if (!raw || !isArr(raw.cards)) throw new Error('Некорректный файл копии: нет карточек');
      data = {
        cards: raw.cards, progress: raw.progress || [], reviews: raw.reviews || [], meta: raw.meta || [],
        documents: raw.documents || [], bookContent: raw.bookContent || [], bookCovers: raw.bookCovers || [],
        localStorage: raw.localStorage || {}
      };
      if (raw.settings && !data.localStorage['lexikon-settings']) data.localStorage['lexikon-settings'] = JSON.stringify(raw.settings);
      manifest = { format: FORMAT, formatVersion: raw.version || 2, dbVersion: raw.version || 2, appVersion: 'старый JSON', exportedAt: raw.exportedAt || '' };
    }
    ['cards', 'progress', 'reviews', 'meta', 'documents', 'bookContent', 'bookCovers'].forEach(function (k) {
      if (!isArr(data[k])) throw new Error('Повреждён раздел «' + k + '»');
    });
    if (data.cards.some(function (c) { return !c || !c.id; })) throw new Error('Повреждены карточки (нет id)');
    if (data.progress.some(function (p) { return !p || !p.id; })) throw new Error('Повреждён прогресс (нет id)');
    data.meta = data.meta.filter(function (m) { return m && m.key && !/^bookStats:/.test(m.key); });
    manifest.summary = countSummary(data);
    return { manifest: manifest, data: data };
  }

  /** Применить: 'replace' — всё как в копии; 'merge' — объединить (новее побеждает). */
  async function apply(parsed, mode) {
    var data = parsed.data;
    var ls = data.localStorage || {};
    if (mode === 'merge') {
      var cur = await LexDB.exportAll();
      var curProg = {};
      cur.progress.forEach(function (p) { curProg[p.id] = p; });
      data = Object.assign({}, data);
      data.progress = data.progress.filter(function (p) {
        var c = curProg[p.id];
        return !c || (p.last || 0) >= (c.last || 0);
      });
      var seen = {};
      cur.reviews.forEach(function (r) { seen[r.cardId + '|' + r.ts + '|' + r.quality] = true; });
      data.reviews = data.reviews.filter(function (r) { return !seen[r.cardId + '|' + r.ts + '|' + r.quality]; });
      var curMeta = {};
      cur.meta.forEach(function (m) { curMeta[m.key] = true; });
      data.meta = data.meta.filter(function (m) { return !curMeta[m.key]; });
      await LexDB.importAll(data, false);
      // настройки: объединяем выбор колод, остальное — оставляем текущее, если есть
      Object.keys(ls).forEach(function (k) {
        if (k === 'lexikon-settings') {
          try {
            var mine = JSON.parse(localStorage.getItem(k) || '{}');
            var theirs = JSON.parse(ls[k] || '{}');
            var merged = Object.assign({}, theirs, mine);
            merged.participate = Object.assign({}, theirs.participate || {}, mine.participate || {});
            localStorage.setItem(k, JSON.stringify(merged));
          } catch (e) { /* ignore */ }
        } else if (localStorage.getItem(k) == null) localStorage.setItem(k, ls[k]);
      });
    } else {
      await LexDB.importAll(data, true);
      var drop = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(LS_PREFIX) === 0 && !LS_SKIP.test(k)) drop.push(k);
      }
      drop.forEach(function (k) { localStorage.removeItem(k); });
      Object.keys(ls).forEach(function (k) { if (!LS_SKIP.test(k)) localStorage.setItem(k, ls[k]); });
    }
    return countSummary(parsed.data);
  }

  global.LexBackup = { build: build, parse: parse, apply: apply, FORMAT_VERSION: FORMAT_VERSION };
})(window);
