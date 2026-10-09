/**
 * IndexedDB слой «Лексикон».
 * Хранилища:
 *   cards     — пользовательские + кэш встроенных метаданных прогресса не здесь
 *   progress  — SM-2 прогресс по id карточки
 *   reviews   — лог ответов для статистики (дата, quality)
 *   meta      — служебные ключи
 *   documents   — метаданные книг (title, author, format, cover, toc, позиция, participate). Лёгкие:
 *                 лента читает отсюда только participate.
 *   bookContent — текст книг: { id, chapters: [{ title, paras: [string | {h: string}] }] }
 *                 (с v3; раньше текст PDF лежал в documents.text — мигрируется).
 *   bookCovers  — миниатюры обложек { id, dataUrl } (грузятся только библиотекой).
 *
 * Настройки — в localStorage (не здесь).
 */
(function (global) {
  'use strict';

  var DB_NAME = 'lexikon-db';
  var DB_VERSION = 3;
  var PART_WORDS = 5000;
  var dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains('cards')) {
          var cards = db.createObjectStore('cards', { keyPath: 'id' });
          cards.createIndex('deckId', 'deckId', { unique: false });
          cards.createIndex('word', 'word', { unique: false });
          cards.createIndex('source', 'source', { unique: false });
        }
        if (!db.objectStoreNames.contains('progress')) {
          var prog = db.createObjectStore('progress', { keyPath: 'id' });
          prog.createIndex('due', 'due', { unique: false });
          prog.createIndex('state', 'state', { unique: false });
        }
        if (!db.objectStoreNames.contains('reviews')) {
          var revs = db.createObjectStore('reviews', { keyPath: 'rid', autoIncrement: true });
          revs.createIndex('day', 'day', { unique: false });
          revs.createIndex('cardId', 'cardId', { unique: false });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('documents')) {
          var docs = db.createObjectStore('documents', { keyPath: 'id' });
          docs.createIndex('createdAt', 'createdAt', { unique: false });
        }
        if (!db.objectStoreNames.contains('bookContent')) {
          db.createObjectStore('bookContent', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('bookCovers')) {
          db.createObjectStore('bookCovers', { keyPath: 'id' });
        }
        // v2 → v3: текст старых PDF-документов переносим в bookContent (главы/абзацы)
        if (e.oldVersion > 0 && e.oldVersion < 3) {
          var utx = e.target.transaction;
          var docStore = utx.objectStore('documents');
          var contentStore = utx.objectStore('bookContent');
          docStore.openCursor().onsuccess = function (ev) {
            var cur = ev.target.result;
            if (!cur) return;
            var conv = legacyDocToBook(cur.value);
            if (conv.content) contentStore.put(conv.content);
            cur.update(conv.meta);
            cur.continue();
          };
        }
      };
      req.onblocked = function () {
        console.warn('lexikon-db upgrade blocked: закройте другие вкладки');
      };
      req.onsuccess = function () {
        var db = req.result;
        // новая версия в другой вкладке — отпускаем соединение, чтобы апгрейд не завис
        db.onversionchange = function () {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = function () { dbPromise = null; reject(req.error); };
    });
    return dbPromise;
  }

  function countWords(text) {
    var m = String(text || '').match(/[A-Za-zÀ-ÖØ-öø-ÿĀ-žА-Яа-яЁё0-9]+(?:['’-][A-Za-zÀ-ÖØ-öø-ÿĀ-žА-Яа-яЁё0-9]+)*/g);
    return m ? m.length : 0;
  }

  function paraText(p) {
    return typeof p === 'string' ? p : (p && p.h) || '';
  }

  /** Сводка глав для метаданных (оглавление без загрузки текста). */
  function summarizeChapters(chapters) {
    var toc = [];
    var total = 0;
    (chapters || []).forEach(function (ch) {
      var w = 0;
      (ch.paras || []).forEach(function (p) { w += countWords(paraText(p)); });
      toc.push({ title: ch.title || '', words: w, level: ch.level || 1 });
      total += w;
    });
    return { toc: toc, wordCount: total };
  }

  /**
   * Старый документ v2 ({text}) → { meta, content }. Документы в новом формате
   * возвращаются как есть (content = null).
   */
  function legacyDocToBook(doc) {
    if (!doc || typeof doc.text !== 'string') return { meta: doc, content: null };
    var paras = doc.text.split(/\n\n+/).map(function (p) { return p.trim(); }).filter(Boolean);
    var chapters = [];
    var cur = [];
    var words = 0;
    paras.forEach(function (p) {
      var w = countWords(p);
      if (cur.length && words + w > PART_WORDS) {
        chapters.push({ title: '', paras: cur });
        cur = [];
        words = 0;
      }
      cur.push(p);
      words += w;
    });
    if (cur.length || !chapters.length) chapters.push({ title: '', paras: cur });
    chapters.forEach(function (ch, i) {
      ch.title = chapters.length > 1 ? 'Часть ' + (i + 1) : (doc.title || 'Текст');
    });
    var sum = summarizeChapters(chapters);
    var meta = Object.assign({}, doc);
    delete meta.text;
    meta.format = meta.format || 'pdf';
    meta.addedAt = meta.addedAt || meta.createdAt || Date.now();
    meta.author = meta.author || '';
    meta.toc = sum.toc;
    meta.wordCount = sum.wordCount;
    meta.participate = doc.participate !== false;
    meta.schema = 3;
    return { meta: meta, content: { id: doc.id, chapters: chapters } };
  }

  function txDone(tx) {
    return new Promise(function (resolve, reject) {
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
      tx.onabort = function () { reject(tx.error || new Error('abort')); };
    });
  }

  function reqToPromise(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function getStore(db, name, mode) {
    return db.transaction(name, mode).objectStore(name);
  }

  async function putCard(card) {
    var db = await openDB();
    var tx = db.transaction('cards', 'readwrite');
    tx.objectStore('cards').put(card);
    await txDone(tx);
  }

  async function putCards(cards) {
    var db = await openDB();
    var tx = db.transaction('cards', 'readwrite');
    var store = tx.objectStore('cards');
    cards.forEach(function (c) { store.put(c); });
    await txDone(tx);
  }

  async function getCard(id) {
    var db = await openDB();
    return reqToPromise(getStore(db, 'cards', 'readonly').get(id));
  }

  async function deleteCard(id) {
    var db = await openDB();
    var tx = db.transaction(['cards', 'progress'], 'readwrite');
    tx.objectStore('cards').delete(id);
    tx.objectStore('progress').delete(id);
    await txDone(tx);
  }

  async function getAllCards() {
    var db = await openDB();
    return reqToPromise(getStore(db, 'cards', 'readonly').getAll());
  }

  async function getCardsByDeck(deckId) {
    var db = await openDB();
    var idx = getStore(db, 'cards', 'readonly').index('deckId');
    return reqToPromise(idx.getAll(deckId));
  }

  async function getProgress(id) {
    var db = await openDB();
    return reqToPromise(getStore(db, 'progress', 'readonly').get(id));
  }

  async function getAllProgress() {
    var db = await openDB();
    return reqToPromise(getStore(db, 'progress', 'readonly').getAll());
  }

  async function putProgress(p) {
    var db = await openDB();
    var tx = db.transaction('progress', 'readwrite');
    tx.objectStore('progress').put(p);
    await txDone(tx);
  }

  async function ensureProgress(cardId) {
    var p = await getProgress(cardId);
    if (p) return p;
    p = LexSRS.createProgress(cardId);
    await putProgress(p);
    return p;
  }

  function dayKey(ts) {
    var d = new Date(ts);
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  async function addReview(cardId, quality) {
    var db = await openDB();
    var t = Date.now();
    var tx = db.transaction('reviews', 'readwrite');
    tx.objectStore('reviews').add({
      cardId: cardId,
      quality: quality,
      ts: t,
      day: dayKey(t)
    });
    await txDone(tx);
  }

  async function getReviewsSince(ts) {
    var db = await openDB();
    var all = await reqToPromise(getStore(db, 'reviews', 'readonly').getAll());
    return all.filter(function (r) { return r.ts >= ts; });
  }

  async function getAllReviews() {
    var db = await openDB();
    return reqToPromise(getStore(db, 'reviews', 'readonly').getAll());
  }

  async function getMeta(key) {
    var db = await openDB();
    var row = await reqToPromise(getStore(db, 'meta', 'readonly').get(key));
    return row ? row.value : undefined;
  }

  async function setMeta(key, value) {
    var db = await openDB();
    var tx = db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put({ key: key, value: value });
    await txDone(tx);
  }

  /* ---- Documents (PDF text) ---- */

  async function putDocument(doc) {
    var db = await openDB();
    var tx = db.transaction('documents', 'readwrite');
    tx.objectStore('documents').put(doc);
    await txDone(tx);
  }

  async function getDocument(id) {
    var db = await openDB();
    return reqToPromise(getStore(db, 'documents', 'readonly').get(id));
  }

  async function getAllDocuments() {
    var db = await openDB();
    return reqToPromise(getStore(db, 'documents', 'readonly').getAll());
  }

  async function deleteDocument(id) {
    var db = await openDB();
    var tx = db.transaction(['documents', 'bookContent', 'bookCovers'], 'readwrite');
    tx.objectStore('documents').delete(id);
    tx.objectStore('bookContent').delete(id);
    tx.objectStore('bookCovers').delete(id);
    await txDone(tx);
  }

  /** Книга целиком: метаданные + текст одной транзакцией. */
  async function putBook(meta, content, cover) {
    var db = await openDB();
    var tx = db.transaction(['documents', 'bookContent', 'bookCovers'], 'readwrite');
    tx.objectStore('documents').put(meta);
    tx.objectStore('bookContent').put(Object.assign({}, content, { id: meta.id }));
    if (cover) tx.objectStore('bookCovers').put({ id: meta.id, dataUrl: cover });
    await txDone(tx);
  }

  /** Обложки отдельно, чтобы список метаданных (и лента) оставался лёгким. */
  async function getAllCovers() {
    var db = await openDB();
    return reqToPromise(getStore(db, 'bookCovers', 'readonly').getAll());
  }

  async function getBookContent(id) {
    var db = await openDB();
    return reqToPromise(getStore(db, 'bookContent', 'readonly').get(id));
  }

  async function getAllBookContent() {
    var db = await openDB();
    return reqToPromise(getStore(db, 'bookContent', 'readonly').getAll());
  }

  /** Полный бэкап IndexedDB → JSON-объект */
  async function exportAll() {
    var cards = await getAllCards();
    var progress = await getAllProgress();
    var reviews = await getAllReviews();
    var documents = await getAllDocuments();
    var bookContent = await getAllBookContent();
    var bookCovers = await getAllCovers();
    var db = await openDB();
    var metaRows = await reqToPromise(getStore(db, 'meta', 'readonly').getAll());
    return {
      version: 3,
      exportedAt: new Date().toISOString(),
      cards: cards,
      progress: progress,
      reviews: reviews,
      documents: documents,
      bookContent: bookContent,
      bookCovers: bookCovers,
      meta: metaRows
    };
  }

  /** Импорт полного бэкапа (заменяет данные) */
  async function importAll(data, replace) {
    if (!data || !Array.isArray(data.cards)) throw new Error('Некорректный файл бэкапа');
    var db = await openDB();
    var storeNames = ['cards', 'progress', 'reviews', 'meta', 'documents', 'bookContent', 'bookCovers'];
    var tx = db.transaction(storeNames, 'readwrite');
    if (replace) {
      storeNames.forEach(function (n) { tx.objectStore(n).clear(); });
    }
    data.cards.forEach(function (c) { tx.objectStore('cards').put(c); });
    (data.progress || []).forEach(function (p) { tx.objectStore('progress').put(p); });
    (data.reviews || []).forEach(function (r) {
      var copy = Object.assign({}, r);
      delete copy.rid;
      tx.objectStore('reviews').add(copy);
    });
    (data.meta || []).forEach(function (m) { tx.objectStore('meta').put(m); });
    (data.documents || []).forEach(function (d) {
      // бэкап v2: текст PDF внутри документа → конвертируем
      var conv = legacyDocToBook(d);
      tx.objectStore('documents').put(conv.meta);
      if (conv.content) tx.objectStore('bookContent').put(conv.content);
    });
    (data.bookContent || []).forEach(function (c) { tx.objectStore('bookContent').put(c); });
    (data.bookCovers || []).forEach(function (c) { tx.objectStore('bookCovers').put(c); });
    await txDone(tx);
  }

  async function clearAll() {
    var db = await openDB();
    var tx = db.transaction(['cards', 'progress', 'reviews', 'meta', 'documents', 'bookContent', 'bookCovers'], 'readwrite');
    tx.objectStore('cards').clear();
    tx.objectStore('progress').clear();
    tx.objectStore('reviews').clear();
    tx.objectStore('meta').clear();
    tx.objectStore('documents').clear();
    tx.objectStore('bookContent').clear();
    tx.objectStore('bookCovers').clear();
    await txDone(tx);
  }

  global.LexDB = {
    open: openDB,
    putCard: putCard,
    putCards: putCards,
    getCard: getCard,
    deleteCard: deleteCard,
    getAllCards: getAllCards,
    getCardsByDeck: getCardsByDeck,
    getProgress: getProgress,
    getAllProgress: getAllProgress,
    putProgress: putProgress,
    ensureProgress: ensureProgress,
    addReview: addReview,
    getReviewsSince: getReviewsSince,
    getAllReviews: getAllReviews,
    getMeta: getMeta,
    setMeta: setMeta,
    putDocument: putDocument,
    getDocument: getDocument,
    getAllDocuments: getAllDocuments,
    deleteDocument: deleteDocument,
    putBook: putBook,
    getBookContent: getBookContent,
    getAllCovers: getAllCovers,
    summarizeChapters: summarizeChapters,
    legacyDocToBook: legacyDocToBook,
    countWords: countWords,
    PART_WORDS: PART_WORDS,
    exportAll: exportAll,
    importAll: importAll,
    clearAll: clearAll,
    dayKey: dayKey
  };
})(typeof window !== 'undefined' ? window : self);
