/**
 * Лексикон — Книги: общие утилиты (грузится лениво вместе с библиотекой).
 */
(function (global) {
  'use strict';

  var loaded = {};

  function loadScript(src) {
    if (loaded[src]) return loaded[src];
    loaded[src] = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () {
        delete loaded[src];
        reject(new Error('Не удалось загрузить ' + src + ' (нет сети?)'));
      };
      document.head.appendChild(s);
    });
    return loaded[src];
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  var WORD_COUNT_RE = /[A-Za-zÀ-ÖØ-öø-ÿĀ-žА-Яа-яЁё0-9]+(?:['’-][A-Za-zÀ-ÖØ-öø-ÿĀ-žА-Яа-яЁё0-9]+)*/g;

  function countWords(text) {
    var m = String(text || '').match(WORD_COUNT_RE);
    return m ? m.length : 0;
  }

  function paraText(p) {
    return typeof p === 'string' ? p : (p && p.h) || '';
  }

  function plural(n, one, few, many) {
    var mod10 = n % 10;
    var mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
  }

  function formatWordCount(n) {
    n = n || 0;
    return n.toLocaleString('ru-RU') + ' ' + plural(n, 'слово', 'слова', 'слов');
  }

  /** «~2 ч 15 мин» / «~12 мин» / «< 1 мин» */
  function formatMinutes(min) {
    min = Math.max(0, Math.round(min));
    if (min < 1) return '< 1 мин';
    if (min < 60) return '~' + min + ' мин';
    var h = Math.floor(min / 60);
    var m = min % 60;
    return '~' + h + ' ч' + (m ? ' ' + m + ' мин' : '');
  }

  function formatBytes(b) {
    if (!b && b !== 0) return '';
    if (b < 1024) return b + ' Б';
    if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' КБ';
    if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1).replace('.', ',') + ' МБ';
    return (b / 1024 / 1024 / 1024).toFixed(2).replace('.', ',') + ' ГБ';
  }

  function formatDate(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    var now = new Date();
    var day = 24 * 3600 * 1000;
    var startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (ts >= startToday) return 'сегодня';
    if (ts >= startToday - day) return 'вчера';
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
  }

  function hashStr(s) {
    var h = 2166136261;
    s = String(s || '');
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  /** Палитра для сгенерированных обложек — приглушённая, в стиле приложения. */
  var COVER_PALETTE = [
    ['#2B3A4A', '#D4A05A'], ['#3A2B2B', '#E0B07A'], ['#26372F', '#9FC7A2'],
    ['#33294A', '#C9B2E8'], ['#3B3524', '#E3C46F'], ['#22333B', '#8FC1D4'],
    ['#402A33', '#E39BAE'], ['#2D2D2D', '#D4A05A']
  ];

  function coverColors(seed) {
    return COVER_PALETTE[hashStr(seed) % COVER_PALETTE.length];
  }

  var FORMAT_LABEL = {
    pdf: 'PDF', epub: 'EPUB', fb2: 'FB2', txt: 'TXT', html: 'HTML',
    docx: 'DOCX', md: 'MD', rtf: 'RTF'
  };

  function formatLabel(f) {
    return FORMAT_LABEL[f] || String(f || '').toUpperCase() || 'TXT';
  }

  function uid(prefix) {
    return (prefix || 'book') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  }

  /** Прогресс книги 0..1 по позиции {ch, para, frac}. */
  function progressOf(meta, pos, paraWordsOfChapter) {
    var toc = (meta && meta.toc) || [];
    var total = meta && meta.wordCount ? meta.wordCount : 0;
    if (!pos || !toc.length || !total) return 0;
    var before = 0;
    for (var i = 0; i < pos.ch && i < toc.length; i++) before += toc[i].words || 0;
    var inCh = 0;
    if (paraWordsOfChapter && paraWordsOfChapter.length) {
      for (var j = 0; j < pos.para && j < paraWordsOfChapter.length; j++) inCh += paraWordsOfChapter[j];
      inCh += (paraWordsOfChapter[pos.para] || 0) * (pos.frac || 0);
    }
    return Math.max(0, Math.min(1, (before + inCh) / total));
  }

  global.LexBooksUtil = {
    loadScript: loadScript,
    escapeHtml: escapeHtml,
    countWords: countWords,
    paraText: paraText,
    plural: plural,
    formatWordCount: formatWordCount,
    formatMinutes: formatMinutes,
    formatBytes: formatBytes,
    formatDate: formatDate,
    hashStr: hashStr,
    coverColors: coverColors,
    formatLabel: formatLabel,
    uid: uid,
    progressOf: progressOf,
    READ_WPM: 170
  };
})(typeof window !== 'undefined' ? window : self);
