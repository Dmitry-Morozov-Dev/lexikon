/**
 * IndexedDB слой «Лексикон».
 * Хранилища:
 *   cards     — пользовательские + кэш встроенных метаданных прогресса не здесь
 *   progress  — SM-2 прогресс по id карточки
 *   reviews   — лог ответов для статистики (дата, quality)
 *   meta      — служебные ключи
 *   documents — тексты из PDF (без blob)
 *
 * Настройки — в localStorage (не здесь).
 */
(function (global) {
  'use strict';

  var DB_NAME = 'lexikon-db';
  var DB_VERSION = 2;
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
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbPromise;
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
    var tx = db.transaction('documents', 'readwrite');
    tx.objectStore('documents').delete(id);
    await txDone(tx);
  }

  /** Полный бэкап IndexedDB → JSON-объект */
  async function exportAll() {
    var cards = await getAllCards();
    var progress = await getAllProgress();
    var reviews = await getAllReviews();
    var documents = await getAllDocuments();
    var db = await openDB();
    var metaRows = await reqToPromise(getStore(db, 'meta', 'readonly').getAll());
    return {
      version: 2,
      exportedAt: new Date().toISOString(),
      cards: cards,
      progress: progress,
      reviews: reviews,
      documents: documents,
      meta: metaRows
    };
  }

  /** Импорт полного бэкапа (заменяет данные) */
  async function importAll(data, replace) {
    if (!data || !Array.isArray(data.cards)) throw new Error('Некорректный файл бэкапа');
    var db = await openDB();
    var storeNames = ['cards', 'progress', 'reviews', 'meta', 'documents'];
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
    (data.documents || []).forEach(function (d) { tx.objectStore('documents').put(d); });
    await txDone(tx);
  }

  async function clearAll() {
    var db = await openDB();
    var tx = db.transaction(['cards', 'progress', 'reviews', 'meta', 'documents'], 'readwrite');
    tx.objectStore('cards').clear();
    tx.objectStore('progress').clear();
    tx.objectStore('reviews').clear();
    tx.objectStore('meta').clear();
    tx.objectStore('documents').clear();
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
    exportAll: exportAll,
    importAll: importAll,
    clearAll: clearAll,
    dayKey: dayKey
  };
})(typeof window !== 'undefined' ? window : self);
