/**
 * Лексикон — Книги: парсеры форматов (грузится только при импорте).
 * Всё на устройстве: PDF (pdf.js), EPUB / DOCX / FB2.ZIP (JSZip), FB2, TXT, HTML, MD, RTF.
 * Результат — единая модель: { meta, content: { chapters: [{ title, level, paras: [string | {h}] }] }, cover }.
 */
(function (global) {
  'use strict';

  var U = global.LexBooksUtil;
  var PART_WORDS = (global.LexDB && LexDB.PART_WORDS) || 5000;
  var MAX_FILE_BYTES = 200 * 1024 * 1024;

  function libUrl(path) {
    return new URL(path, document.baseURI).href;
  }

  /** Ошибка импорта с понятным пользователю текстом. */
  function ImportError(msg) {
    var e = new Error(msg);
    e.userFacing = true;
    return e;
  }

  /* ================= Общие помощники ================= */

  function loadJsZip() {
    if (global.JSZip) return Promise.resolve(global.JSZip);
    return U.loadScript('lib/jszip.min.js').then(function () {
      if (!global.JSZip) throw new Error('JSZip не загрузился');
      return global.JSZip;
    });
  }

  var pdfjsPromise = null;
  function loadPdfJs() {
    if (pdfjsPromise) return pdfjsPromise;
    pdfjsPromise = import(libUrl('lib/pdfjs/pdf.min.mjs')).then(function (mod) {
      if (mod.GlobalWorkerOptions) mod.GlobalWorkerOptions.workerSrc = libUrl('lib/pdfjs/pdf.worker.min.mjs');
      return mod;
    }).catch(function (err) {
      pdfjsPromise = null;
      throw err;
    });
    return pdfjsPromise;
  }

  // C1-управляющие U+0080–U+009F почти всегда — «потерянные» байты cp1252 (’ “ ” … —):
  // приходят из RTF/TXT/XHTML с &#146; и т. п. Рендерятся квадратиками → возвращаем символы.
  var CP1252_C1 = {
    0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰',
    0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•',
    0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ'
  };
  // Символы шрифта Symbol/Wingdings в Private Use Area (U+F020–U+F0FF) — из Word/RTF.
  var SYMBOL_GREEK = 'ΑΒΧΔΕΦΓΗΙϑΚΛΜΝΟΠΘΡΣΤΥςΩΞΨΖ';   // Symbol: A..Z
  var SYMBOL_greek = 'αβχδεφγηιϕκλμνοπθρστυϖωξψζ';   // Symbol: a..z
  var SYMBOL_HIGH = { 0xa7: '•', 0xb7: '•', 0xa8: '♦', 0xa9: '♥', 0xaa: '♠', 0xab: '↔', 0xac: '←', 0xae: '→',
    0xb0: '°', 0xb1: '±', 0xb4: '×', 0xb8: '÷', 0xb9: '≠', 0xba: '≡', 0xbb: '≈', 0xbc: '…', 0xbe: '—',
    0xa3: '≤', 0xb3: '≥', 0xa5: '∞', 0xd7: '·', 0xe0: '→', 0xd8: '¬', 0xd6: '√', 0xe5: '∑', 0xf2: '∫',
    0xd2: '®', 0xd3: '©', 0xd4: '™', 0xfc: '✓', 0xfb: '✗', 0x9f: '•' };
  function fixChars(s) {
    return s
      .replace(/[\u0080-\u009f]/g, function (c) { return CP1252_C1[c.charCodeAt(0)] || ''; })
      .replace(/[\uf020-\uf0ff]/g, function (c) {
        var k = c.charCodeAt(0) - 0xf000;
        if (k >= 0x41 && k <= 0x5a) return SYMBOL_GREEK.charAt(k - 0x41);
        if (k >= 0x61 && k <= 0x7a) return SYMBOL_greek.charAt(k - 0x61);
        if (k === 0x2d) return '−';
        if (k < 0x7f) return String.fromCharCode(k);
        return SYMBOL_HIGH[k] || '';
      })
      // прочие управляющие (кроме \t \n), заменитель U+FFFD, неразрывные/нулевой ширины уже ниже
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffd]/g, '');
  }

  function cleanPara(s) {
    return fixChars(String(s || ''))
      .replace(/\r\n?/g, '\n')
      .replace(/[\u00ad\u200b\u200c\u200d\ufeff]/g, '')
      .replace(/[ \t\f\v\u00a0\u2000-\u200a\u202f\u205f\u3000]+/g, ' ')
      .split('\n').map(function (l) { return l.trim(); }).join('\n')
      .replace(/\n{2,}/g, '\n')
      .trim();
  }

  function normKey(s) {
    return String(s || '').toLowerCase().replace(/[^a-zа-яё0-9]+/gi, ' ').trim();
  }

  function baseName(name) {
    return String(name || '').replace(/\.(fb2\.zip|[a-z0-9]{2,5})$/i, '').replace(/[_]+/g, ' ').trim();
  }

  function hasWords(p) {
    return /[A-Za-zÀ-ÖØ-öø-ÿĀ-žА-Яа-яЁё0-9]/.test(U.paraText(p));
  }

  /** XML/HTML: парсер с запасным вариантом для «грязных» файлов. */
  function parseXml(text, preferHtml) {
    var parser = new DOMParser();
    if (!preferHtml) {
      var doc = parser.parseFromString(text, 'application/xml');
      if (!doc.getElementsByTagName('parsererror').length) return doc;
      // частая беда: неэкранированные & в FB2/XHTML
      var fixed = String(text).replace(/&(?!#?[A-Za-z0-9]+;)/g, '&amp;');
      doc = parser.parseFromString(fixed, 'application/xml');
      if (!doc.getElementsByTagName('parsererror').length) return doc;
    }
    return parser.parseFromString(text, 'text/html');
  }

  function byLocal(root, name) {
    var out = [];
    if (!root) return out;
    var all = root.getElementsByTagName('*');
    for (var i = 0; i < all.length; i++) {
      if ((all[i].localName || '').toLowerCase() === name) out.push(all[i]);
    }
    return out;
  }

  function firstLocal(root, name) {
    if (!root) return null;
    var all = root.getElementsByTagName('*');
    for (var i = 0; i < all.length; i++) {
      if ((all[i].localName || '').toLowerCase() === name) return all[i];
    }
    return null;
  }

  function childrenLocal(el, name) {
    var out = [];
    if (!el) return out;
    for (var c = el.firstElementChild; c; c = c.nextElementSibling) {
      if (!name || (c.localName || '').toLowerCase() === name) out.push(c);
    }
    return out;
  }

  function attrLocal(el, name) {
    if (!el || !el.attributes) return null;
    for (var i = 0; i < el.attributes.length; i++) {
      var a = el.attributes[i];
      if ((a.localName || a.name).toLowerCase() === name) return a.value;
    }
    return null;
  }

  function textOf(el) {
    return el ? cleanPara(el.textContent || '').replace(/\n/g, ' ') : '';
  }

  /* ---------- Кодировки ---------- */

  function sniffXmlEncoding(bytes) {
    var head = '';
    for (var i = 0; i < Math.min(bytes.length, 1024); i++) head += String.fromCharCode(bytes[i]);
    var m = head.match(/<\?xml[^>]*encoding\s*=\s*["']([A-Za-z0-9_\-]+)["']/i) ||
      head.match(/<meta[^>]+charset\s*=\s*["']?([A-Za-z0-9_\-]+)/i);
    return m ? m[1].toLowerCase() : null;
  }

  function tryDecode(bytes, enc, fatal) {
    try {
      return new TextDecoder(enc, { fatal: !!fatal }).decode(bytes);
    } catch (e) {
      return null;
    }
  }

  /** UTF-8 / UTF-16 (BOM) / windows-1251 / windows-1252 — эвристика для TXT/HTML/FB2. */
  function decodeText(buf, declared) {
    var bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) return { text: tryDecode(bytes.subarray(3), 'utf-8'), enc: 'utf-8' };
    if (bytes[0] === 0xFF && bytes[1] === 0xFE) return { text: tryDecode(bytes.subarray(2), 'utf-16le'), enc: 'utf-16le' };
    if (bytes[0] === 0xFE && bytes[1] === 0xFF) return { text: tryDecode(bytes.subarray(2), 'utf-16be'), enc: 'utf-16be' };
    if (declared && !/^utf-?8$/.test(declared)) {
      var d = tryDecode(bytes, declared);
      if (d != null) return { text: d, enc: declared };
    }
    var u = tryDecode(bytes, 'utf-8', true);
    if (u != null) return { text: u, enc: 'utf-8' };
    // 8-битная кодировка: в cp1251 кириллица идёт «словами» (подряд ≥3 байта 0xC0–0xFF),
    // а в cp1252 акцентированные буквы одиночные среди латиницы (café, naïve)
    var high = 0, inRuns = 0, run = 0;
    var n = Math.min(bytes.length, 400000);
    for (var i = 0; i <= n; i++) {
      var b = i < n ? bytes[i] : 0;
      var cyr = b >= 0xC0 || b === 0xA8 || b === 0xB8;
      if (b >= 0x80) high++;
      if (cyr) run++;
      else {
        if (run >= 3) inRuns += run;
        run = 0;
      }
    }
    var enc = (high > 0 && inRuns / high >= 0.5) ? 'windows-1251' : 'windows-1252';
    return { text: tryDecode(bytes, enc) || '', enc: enc };
  }

  /* ---------- Миниатюры обложек ---------- */

  function imageToThumb(blob) {
    return new Promise(function (resolve) {
      if (!blob) return resolve(null);
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () {
        try {
          var w = 240;
          var scale = w / (img.naturalWidth || w);
          var h = Math.round((img.naturalHeight || w * 1.5) * scale);
          if (h > 480) { h = 480; w = Math.round((img.naturalWidth || 1) * (480 / (img.naturalHeight || 1))); }
          var c = document.createElement('canvas');
          c.width = Math.max(1, w);
          c.height = Math.max(1, h);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          resolve(c.toDataURL('image/jpeg', 0.78));
        } catch (e) {
          resolve(null);
        } finally {
          URL.revokeObjectURL(url);
        }
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  }

  /* ---------- DOM → блоки (HTML / XHTML EPUB) ---------- */

  var BLOCK_RE = /^(p|div|h[1-6]|li|blockquote|pre|section|article|aside|header|footer|main|nav|figure|figcaption|table|thead|tbody|tfoot|tr|td|th|ul|ol|dl|dt|dd|hr|address|center|body|caption|details|summary)$/;
  var SKIP_RE = /^(script|style|head|noscript|svg|math|template|title|iframe|object|embed|button|form|select|textarea|audio|video|canvas|map)$/;
  var BR = '\u2028';

  /**
   * Обход DOM: блоки { type: 'p'|'h', level, text, ids: [] }.
   * ids — якоря (id / name) внутри или прямо перед блоком: для оглавления EPUB.
   */
  function domToBlocks(root) {
    var blocks = [];
    var buf = '';
    var bufIds = [];
    var pending = [];
    var preDepth = 0;

    function flush() {
      var raw = buf;
      buf = '';
      var t = preDepth ? raw : raw.replace(/[\s]+/g, ' ');
      t = cleanPara(t.split(BR).join('\n'));
      if (t) {
        blocks.push({ type: 'p', text: t, ids: pending.concat(bufIds) });
        pending = [];
      } else if (bufIds.length) {
        pending = pending.concat(bufIds);
      }
      bufIds = [];
    }

    function isPageBreak(el) {
      var et = (attrLocal(el, 'type') || '') + ' ' + (el.getAttribute('role') || '');
      return /pagebreak/i.test(et);
    }

    function collectIds(el, into) {
      var all = el.getElementsByTagName('*');
      for (var i = 0; i < all.length; i++) {
        var xi = all[i].getAttribute('id') || all[i].getAttribute('name');
        if (xi) into.push(xi);
      }
    }

    function walk(node) {
      for (var c = node.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3 || c.nodeType === 4) {
          buf += c.nodeValue;
          continue;
        }
        if (c.nodeType !== 1) continue;
        var name = (c.localName || '').toLowerCase();
        if (SKIP_RE.test(name) || isPageBreak(c)) continue;
        var id = c.getAttribute('id') || (name === 'a' ? c.getAttribute('name') : null);
        if (name === 'br') { buf += BR; continue; }
        if (name === 'img' || name === 'image') continue;
        if (/^h[1-6]$/.test(name)) {
          flush();
          var ht = textOf(c);
          var ids = pending.concat(id ? [id] : []);
          collectIds(c, ids);
          if (ht) {
            blocks.push({ type: 'h', level: parseInt(name.charAt(1), 10), text: ht, ids: ids });
            pending = [];
          } else {
            pending = ids;
          }
          continue;
        }
        if (BLOCK_RE.test(name)) {
          flush();
          if (id) pending.push(id);
          if (name === 'hr') continue;
          if (name === 'pre') preDepth++;
          walk(c);
          if (name === 'pre') preDepth--;
          flush();
          continue;
        }
        if (id) {
          if (buf.trim()) bufIds.push(id);
          else pending.push(id);
        }
        walk(c);
      }
    }

    if (root) walk(root);
    flush();
    return blocks;
  }

  /** Блоки → главы, разбивая по заголовкам верхнего уровня (если их ≥ 2). */
  function blocksToChapters(blocks, defaultTitle) {
    var counts = {};
    blocks.forEach(function (b) { if (b.type === 'h') counts[b.level] = (counts[b.level] || 0) + 1; });
    var splitLevel = 0;
    for (var L = 1; L <= 3; L++) {
      if ((counts[L] || 0) >= 2) { splitLevel = L; break; }
    }
    var chapters = [];
    var cur = { title: '', level: 1, paras: [] };
    blocks.forEach(function (b) {
      if (b.type === 'h' && splitLevel && b.level <= splitLevel) {
        if (cur.paras.some(hasWords) || cur.title) chapters.push(cur);
        cur = { title: b.text, level: 1, paras: [] };
        return;
      }
      cur.paras.push(b.type === 'h' ? { h: b.text } : b.text);
    });
    if (cur.paras.some(hasWords) || cur.title) chapters.push(cur);
    chapters.forEach(function (ch, i) {
      if (!ch.title) ch.title = i === 0 && chapters.length > 1 ? 'Начало' : (defaultTitle || 'Текст');
    });
    return chapters;
  }

  /* ---------- Нормализация книги ---------- */

  function finalizeBook(raw) {
    var chapters = [];
    (raw.chapters || []).forEach(function (ch) {
      var paras = [];
      (ch.paras || []).forEach(function (p) {
        if (typeof p === 'string') {
          var t = cleanPara(p);
          if (t) paras.push(t);
        } else if (p && p.h) {
          var h = cleanPara(p.h).replace(/\n/g, ' ');
          if (h) paras.push({ h: h });
        }
      });
      var title = cleanPara(ch.title || '').replace(/\n/g, ' ').slice(0, 200);
      // убрать дублирующий заголовок в начале главы
      while (paras.length && typeof paras[0] === 'object' && normKey(paras[0].h) === normKey(title)) paras.shift();
      if (!paras.some(hasWords)) return;
      chapters.push({ title: title, level: ch.level || 1, paras: paras });
    });
    if (!chapters.length) {
      throw ImportError('В файле не найден текст для чтения.');
    }
    // титульная страница (только название/автор) — не отдельная глава
    if (chapters.length > 1) {
      var fw = 0;
      chapters[0].paras.forEach(function (p) { fw += U.countWords(U.paraText(p)); });
      if (fw <= 12) chapters.shift();
    }
    // длинные главы → части (рендер одной главы остаётся быстрым на iPhone)
    var out = [];
    chapters.forEach(function (ch, idx) {
      var words = 0;
      ch.paras.forEach(function (p) { words += U.countWords(U.paraText(p)); });
      var baseTitle = ch.title || (chapters.length > 1 ? 'Глава ' + (idx + 1) : '');
      if (words <= PART_WORDS * 1.3) {
        out.push({ title: baseTitle, level: ch.level, paras: ch.paras });
        return;
      }
      var parts = [];
      var cur = [];
      var w = 0;
      ch.paras.forEach(function (p) {
        var pw = U.countWords(U.paraText(p));
        if (cur.length && w + pw > PART_WORDS && typeof cur[cur.length - 1] !== 'object') {
          parts.push(cur);
          cur = [];
          w = 0;
        }
        cur.push(p);
        w += pw;
      });
      if (cur.length) {
        // хвост меньше трети части — приклеиваем к предыдущей
        if (parts.length && w < PART_WORDS / 3) parts[parts.length - 1] = parts[parts.length - 1].concat(cur);
        else parts.push(cur);
      }
      parts.forEach(function (paras, i) {
        var t = baseTitle
          ? baseTitle + (parts.length > 1 ? ' · ' + (i + 1) + '/' + parts.length : '')
          : 'Часть ' + (i + 1);
        out.push({ title: t, level: i === 0 ? ch.level : Math.max(ch.level, 2), paras: paras });
      });
    });
    out.forEach(function (ch, i) {
      if (!ch.title) ch.title = out.length > 1 ? 'Часть ' + (i + 1) : (raw.title || 'Текст');
    });

    var sum = LexDB.summarizeChapters(out);
    var id = U.uid('book');
    var now = Date.now();
    var title = cleanPara(raw.title || '').replace(/\n/g, ' ') || baseName(raw.sourceName) || 'Без названия';
    var meta = {
      id: id,
      schema: 3,
      title: title.slice(0, 300),
      author: cleanPara(raw.author || '').replace(/\n/g, ' ').slice(0, 200),
      format: raw.format,
      lang: raw.lang || '',
      annotation: cleanPara(raw.annotation || '').slice(0, 2000),
      sourceName: raw.sourceName || '',
      size: raw.size || 0,
      hasCover: !!raw.cover,
      createdAt: now,
      addedAt: now,
      lastOpenedAt: 0,
      wordCount: sum.wordCount,
      toc: sum.toc,
      pos: null,
      progress: 0,
      bookmarks: [],
      participate: true
    };
    return { meta: meta, content: { id: id, chapters: out }, cover: raw.cover || null };
  }

  /* ================= TXT ================= */

  var TXT_HEAD_RE = /^(?:chapter|ch\.|book|part|section|volume|prologue|epilogue|introduction|preface|foreword|afterword|appendix|глава|часть|книга|том|раздел|пролог|эпилог|предисловие|послесловие|вступление|приложение)\b/i;
  var ROMAN_RE = /^(?:[IVXLCDM]+|\d{1,3})[.)]?$/;

  function isTxtHeading(p) {
    if (p.length > 80 || /\n/.test(p)) return false;
    if (/[,;]$/.test(p)) return false;
    if (TXT_HEAD_RE.test(p)) return U.countWords(p) <= 12;
    return ROMAN_RE.test(p.trim());
  }

  function txtToBook(text, sourceName, size) {
    text = String(text || '').replace(/^\ufeff/, '').replace(/\r\n?/g, '\n');
    var title = '', author = '';
    // Project Gutenberg: шапка/лицензия вне книги
    var start = text.search(/\*{3}\s*START OF (?:THE|THIS) PROJECT GUTENBERG E-?BOOK[^\n]*/i);
    if (start >= 0) {
      var header = text.slice(0, start);
      var tm = header.match(/^Title:\s*(.+)$/mi);
      var am = header.match(/^Author:\s*(.+)$/mi);
      if (tm) title = tm[1].trim();
      if (am) author = am[1].trim();
      text = text.slice(start).replace(/^[^\n]*\n/, '');
      var end = text.search(/\*{3}\s*END OF (?:THE|THIS) PROJECT GUTENBERG E-?BOOK/i);
      if (end >= 0) text = text.slice(0, end);
    }
    var lines = text.split('\n');
    var blank = 0;
    var longLines = 0;
    var nonEmpty = 0;
    lines.forEach(function (l) {
      if (!l.trim()) blank++;
      else {
        nonEmpty++;
        if (l.length > 45) longLines++;
      }
    });
    var paras = [];
    if (blank > lines.length * 0.04 && nonEmpty > 0) {
      var hardWrapped = longLines / Math.max(1, nonEmpty) > 0.5;
      text.split(/\n[ \t]*\n+/).forEach(function (block) {
        var ls = block.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
        if (!ls.length) return;
        var poem = ls.length > 1 && ls.every(function (l) { return l.length < 45; });
        var joined = (hardWrapped && !poem) ? ls.join(' ').replace(/([a-zа-яё])- ([a-zа-яё])/g, '$1$2') : ls.join('\n');
        if (!hardWrapped && !poem) joined = ls.join(' ');
        paras.push(joined);
      });
    } else {
      lines.forEach(function (l) { if (l.trim()) paras.push(l.trim()); });
    }
    var headingCount = 0;
    paras.forEach(function (p) { if (isTxtHeading(p)) headingCount++; });
    var chapters = [];
    if (headingCount >= 2) {
      var cur = { title: '', paras: [] };
      for (var i = 0; i < paras.length; i++) {
        var p = paras[i];
        if (isTxtHeading(p)) {
          if (cur.paras.some(hasWords)) chapters.push(cur);
          var t = p;
          var next = paras[i + 1];
          // «CHAPTER I.» + «The Title» → один заголовок
          if (next && !isTxtHeading(next) && next.length < 70 && !/\n/.test(next) &&
            U.countWords(next) <= 10 && !/[,;:]$/.test(next) &&
            (next === next.toUpperCase() || !/[.!?…"”»]$/.test(next))) {
            t = p.replace(/[.:]\s*$/, '') + '. ' + next;
            i++;
          }
          cur = { title: t, paras: [] };
          continue;
        }
        cur.paras.push(p);
      }
      if (cur.paras.some(hasWords)) chapters.push(cur);
      if (chapters.length && !chapters[0].title) chapters[0].title = 'Начало';
    } else {
      chapters.push({ title: '', paras: paras });
    }
    return finalizeBook({
      format: 'txt', title: title || baseName(sourceName), author: author,
      chapters: chapters, sourceName: sourceName, size: size
    });
  }

  /* ================= Markdown ================= */

  function mdInline(s) {
    return s
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/__(.+?)__/g, '$1')
      .replace(/(^|[\s(])\*(\S(?:.*?\S)?)\*(?=[\s).,;:!?]|$)/g, '$1$2')
      .replace(/(^|[\s(])_(\S(?:.*?\S)?)_(?=[\s).,;:!?]|$)/g, '$1$2')
      .replace(/<[^>]+>/g, '');
  }

  function mdToBook(text, sourceName, size) {
    var lines = String(text || '').replace(/^\ufeff/, '').replace(/\r\n?/g, '\n').split('\n');
    var blocks = [];
    var para = [];
    var inCode = false;
    var code = [];
    var title = '';
    function flushPara() {
      if (para.length) blocks.push({ type: 'p', text: mdInline(para.join(' ')) });
      para = [];
    }
    if (lines[0] === '---') {
      var endFm = lines.indexOf('---', 1);
      if (endFm > 0) {
        lines.slice(1, endFm).forEach(function (l) {
          var m = l.match(/^title:\s*["']?(.+?)["']?\s*$/i);
          if (m) title = m[1];
        });
        lines = lines.slice(endFm + 1);
      }
    }
    lines.forEach(function (line) {
      if (/^\s*(```|~~~)/.test(line)) {
        if (inCode) {
          blocks.push({ type: 'p', text: code.join('\n') });
          code = [];
        } else flushPara();
        inCode = !inCode;
        return;
      }
      if (inCode) { code.push(line); return; }
      var h = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (h) {
        flushPara();
        blocks.push({ type: 'h', level: h[1].length, text: mdInline(h[2]) });
        return;
      }
      if (!line.trim() || /^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flushPara(); return; }
      var li = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
      if (li) { flushPara(); para.push('• ' + li[1]); flushPara(); return; }
      para.push(line.replace(/^\s*>\s?/, '').trim());
    });
    if (inCode && code.length) blocks.push({ type: 'p', text: code.join('\n') });
    flushPara();
    var h1 = blocks.filter(function (b) { return b.type === 'h' && b.level === 1; });
    if (!title && h1.length === 1) {
      title = h1[0].text;
      blocks = blocks.filter(function (b) { return b !== h1[0]; });
    }
    title = title || baseName(sourceName);
    return finalizeBook({
      format: 'md', title: title, chapters: blocksToChapters(blocks, title),
      sourceName: sourceName, size: size
    });
  }

  /* ================= Word 97–2003 (.doc, OLE CFB) — только текст ================= */

  function cfbOpen(bytes) {
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (dv.getUint32(0, true) !== 0xe011cfd0) throw ImportError('Файл .doc повреждён.');
    var secShift = dv.getUint16(0x1e, true), miniShift = dv.getUint16(0x20, true);
    var secSize = 1 << secShift, miniSize = 1 << miniShift;
    var nFat = dv.getUint32(0x2c, true), dirStart = dv.getUint32(0x30, true);
    var miniCutoff = dv.getUint32(0x38, true), miniFatStart = dv.getUint32(0x3c, true);
    var difatStart = dv.getUint32(0x44, true), nDifat = dv.getUint32(0x48, true);
    function secOff(n) { return (n + 1) * secSize; }
    var fatSecs = [];
    for (var i = 0; i < 109 && fatSecs.length < nFat; i++) fatSecs.push(dv.getUint32(0x4c + i * 4, true));
    var ds = difatStart, guard = 0;
    while (fatSecs.length < nFat && ds < 0xfffffffa && guard++ < nDifat + 1) {
      var o = secOff(ds), per = secSize / 4 - 1;
      for (var j = 0; j < per && fatSecs.length < nFat; j++) fatSecs.push(dv.getUint32(o + j * 4, true));
      ds = dv.getUint32(o + per * 4, true);
    }
    var fat = new Uint32Array(fatSecs.length * secSize / 4);
    fatSecs.forEach(function (sec, k) {
      var o = secOff(sec);
      for (var q = 0; q < secSize / 4; q++) fat[k * secSize / 4 + q] = o + q * 4 + 4 <= bytes.length ? dv.getUint32(o + q * 4, true) : 0xfffffffe;
    });
    function chain(start, table) {
      var out = [], n = start, g = 0;
      while (n < 0xfffffffa && n < table.length && g++ < 1e6) { out.push(n); n = table[n]; }
      return out;
    }
    function readBig(start, size) {
      var secs = chain(start, fat), buf = new Uint8Array(secs.length * secSize);
      secs.forEach(function (sec, k) { var o = secOff(sec); buf.set(bytes.subarray(o, Math.min(o + secSize, bytes.length)), k * secSize); });
      return size != null ? buf.subarray(0, size) : buf;
    }
    var dirBuf = readBig(dirStart);
    var ddv = new DataView(dirBuf.buffer, dirBuf.byteOffset, dirBuf.byteLength);
    var entries = [];
    for (var e = 0; e + 128 <= dirBuf.length; e += 128) {
      var nl = ddv.getUint16(e + 64, true), name = '';
      for (var c = 0; c + 2 < nl; c += 2) name += String.fromCharCode(ddv.getUint16(e + c, true));
      entries.push({ name: name, type: dirBuf[e + 66], start: ddv.getUint32(e + 116, true), size: ddv.getUint32(e + 120, true) });
    }
    var root = entries[0];
    var miniFat = null, miniStream = null;
    function stream(name) {
      var en = entries.filter(function (x) { return x.type === 2 && x.name === name; })[0];
      if (!en) return null;
      if (en.size >= miniCutoff) return readBig(en.start, en.size);
      if (!miniFat) {
        var mf = readBig(miniFatStart), mdv = new DataView(mf.buffer, mf.byteOffset, mf.byteLength);
        miniFat = new Uint32Array(mf.length / 4);
        for (var k = 0; k < miniFat.length; k++) miniFat[k] = mdv.getUint32(k * 4, true);
        miniStream = readBig(root.start, root.size);
      }
      var secs = chain(en.start, miniFat), buf = new Uint8Array(secs.length * miniSize);
      secs.forEach(function (sec, k) { buf.set(miniStream.subarray(sec * miniSize, sec * miniSize + miniSize), k * miniSize); });
      return buf.subarray(0, en.size);
    }
    return { stream: stream, names: entries.map(function (x) { return x.name; }) };
  }

  function docToBook(bytes, sourceName, size) {
    var cfb = cfbOpen(bytes);
    var wd = cfb.stream('WordDocument');
    if (!wd) {
      throw ImportError('Это не документ Word (в файле нет текста Word). Сохраните его как .docx, EPUB или PDF.');
    }
    var dv = new DataView(wd.buffer, wd.byteOffset, wd.byteLength);
    if (dv.getUint16(0, true) !== 0xa5ec) throw ImportError('Слишком старая версия Word (до Word 97). Сохраните документ как .docx.');
    var flags = dv.getUint16(0x0a, true);
    if (flags & 0x0100) throw ImportError('Документ Word защищён паролем. Снимите пароль и импортируйте снова.');
    var tbl = cfb.stream(flags & 0x0200 ? '1Table' : '0Table');
    if (!tbl) throw ImportError('Файл .doc повреждён (нет таблицы текста).');
    var tdv = new DataView(tbl.buffer, tbl.byteOffset, tbl.byteLength);
    // FibRgLw97.ccpText (длина основного текста), FibRgFcLcb97.fcClx/lcbClx
    var csw = dv.getUint16(0x20, true);
    var lwOff = 0x22 + csw * 2;
    var cslw = dv.getUint16(lwOff, true);
    var ccpText = dv.getUint32(lwOff + 2 + 3 * 4, true);
    var fcOff = lwOff + 2 + cslw * 4 + 2;
    var fcClx = dv.getUint32(fcOff + 66 * 4, true), lcbClx = dv.getUint32(fcOff + 66 * 4 + 4, true);
    var p = fcClx, end = fcClx + lcbClx, pieces = null;
    while (p < end) {
      var t = tbl[p];
      if (t === 1) { p += 3 + tdv.getUint16(p + 1, true); continue; }
      if (t === 2) {
        var lcb = tdv.getUint32(p + 1, true), base = p + 5, n = (lcb - 4) / 12;
        pieces = [];
        for (var i = 0; i < n; i++) {
          var cp0 = tdv.getUint32(base + i * 4, true), cp1 = tdv.getUint32(base + (i + 1) * 4, true);
          var fcRaw = tdv.getUint32(base + (n + 1) * 4 + i * 8 + 2, true);
          pieces.push({ cp0: cp0, cp1: cp1, compressed: !!(fcRaw & 0x40000000), fc: fcRaw & 0x3fffffff });
        }
        break;
      }
      break;
    }
    if (!pieces) throw ImportError('Не удалось прочитать текст .doc. Сохраните документ как .docx.');
    var d1252 = new TextDecoder('windows-1252'), d16 = new TextDecoder('utf-16le');
    var text = '';
    for (var k = 0; k < pieces.length && text.length < ccpText; k++) {
      var pc = pieces[k], len = pc.cp1 - pc.cp0;
      if (pc.compressed) {
        var off = pc.fc / 2;
        text += d1252.decode(wd.subarray(off, off + len));
      } else {
        text += d16.decode(wd.subarray(pc.fc, pc.fc + len * 2));
      }
    }
    if (ccpText > 0) text = text.slice(0, ccpText);
    // поля: 0x13 инструкция 0x14 результат 0x15 → оставляем результат
    var out = '', depth = [];
    for (var q = 0; q < text.length; q++) {
      var ch = text.charAt(q), code = text.charCodeAt(q);
      if (code === 0x13) { depth.push(false); continue; }
      if (code === 0x14) { if (depth.length) depth[depth.length - 1] = true; continue; }
      if (code === 0x15) { depth.pop(); continue; }
      if (depth.length && !depth[depth.length - 1]) continue;
      if (code === 0x0d || code === 0x0c || code === 0x07) { out += '\n\n'; continue; }
      if (code === 0x0b) { out += '\n'; continue; }
      if (code === 0x09) { out += ' '; continue; }
      if (code === 0x1e) { out += '-'; continue; }
      if (code === 0xa0) { out += ' '; continue; }
      if (code < 0x20) continue;   // 0x01 картинки, 0x02 сноски, 0x08 объекты, 0x1f мягкий перенос
      out += ch;
    }
    var blocks = out.split(/\n\s*\n+/).map(function (x) { return x.trim(); }).filter(Boolean).map(function (x) {
      return isTxtHeading(x) ? { type: 'h', level: 1, text: x } : { type: 'p', text: x };
    });
    if (!blocks.some(function (b) { return b.type === 'p' && /[A-Za-zА-Яа-яЁё]{2}/.test(b.text); })) {
      throw ImportError('В документе .doc не найден текст.');
    }
    var title = baseName(sourceName);
    return finalizeBook({
      format: 'doc', title: title, chapters: blocksToChapters(blocks, title),
      sourceName: sourceName, size: size
    });
  }

  /* ================= RTF (базовый) ================= */

  var RTF_SKIP_DEST = /^(fonttbl|colortbl|stylesheet|info|pict|object|header|headerl|headerr|headerf|footer|footerl|footerr|footerf|themedata|colorschememapping|datastore|latentstyles|listtable|listoverridetable|rsidtbl|xmlnstbl|generator|filetbl|revtbl|pgdsctbl|fldinst|bkmkstart|bkmkend|shppict|nonshppict|mmathPr|wgrffmtfilter|operator|private)$/;

  var RTF_CHARSET_CP = { 0: 'windows-1252', 2: 'symbol', 77: 'macintosh', 128: 'shift_jis', 129: 'euc-kr', 134: 'gbk', 136: 'big5',
    161: 'windows-1253', 162: 'windows-1254', 163: 'windows-1258', 177: 'windows-1255', 178: 'windows-1256',
    186: 'windows-1257', 204: 'windows-1251', 222: 'windows-874', 238: 'windows-1250' };

  function rtfToBook(bytes, sourceName, size) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    if (!/^\s*\{\\rtf/.test(s)) throw ImportError('Файл RTF повреждён или не является RTF.');
    // Кодировка: \ansicpgN, иначе по \fcharset шрифтов (204 → cp1251 и т. д.); у каждого шрифта своя.
    var decCache = {};
    function decoderFor(cp) {
      if (!decCache[cp]) {
        try { decCache[cp] = new TextDecoder(cp); } catch (e) { decCache[cp] = new TextDecoder('windows-1252'); }
      }
      return decCache[cp];
    }
    var cpm = s.match(/\\ansicpg(\d+)/);
    var fontCp = {};
    var ftStart = s.indexOf('\\fonttbl');
    if (ftStart >= 0) {
      var ftEnd = s.length;
      ['{\\colortbl', '{\\stylesheet', '{\\info', '\\pard', '\\par '].forEach(function (k) {
        var i = s.indexOf(k, ftStart); if (i > ftStart && i < ftEnd) ftEnd = i;
      });
      var ftText = s.slice(ftStart, Math.min(ftEnd, ftStart + 100000));
      var fre = /\\f(\d+)[^{};]*?\\fcharset(\d+)/g, fm;
      while ((fm = fre.exec(ftText))) {
        var cpName = RTF_CHARSET_CP[+fm[2]];
        if (cpName) fontCp[fm[1]] = cpName;
      }
    }
    var deffM = s.match(/\\deff(\d+)/);
    var docCp = (cpm && cpm[1] !== '0' && cpm[1] !== '1252') ? 'windows-' + cpm[1]
      : (deffM && fontCp[deffM[1]]) || (cpm ? 'windows-' + cpm[1] : null) || 'windows-1252';
    if (docCp === 'windows-1252' || docCp === 'windows-0') {
      // \ansicpg1252/без него, но все текстовые шрифты кириллические → cp1251
      var cps = Object.keys(fontCp).map(function (k) { return fontCp[k]; }).filter(function (c) { return c !== 'symbol'; });
      if (cps.length && cps.every(function (c) { return c === cps[0]; })) docCp = cps[0];
      if (docCp === 'windows-0') docCp = 'windows-1252';
    }
    var curCp = docCp;
    var dec = decoderFor(docCp);
    function setFont(n) {
      var cp = fontCp[n];
      curCp = cp || docCp;
      dec = decoderFor(curCp === 'symbol' ? 'windows-1252' : curCp);
    }
    var titleM = s.match(/\{\\title\s+([^{}]*)\}/);
    var out = '';
    var stack = [];
    var skip = false;
    var uc = 1;
    var pendingSkip = 0;
    var hexBuf = [];
    function flushHex() {
      if (hexBuf.length) {
        if (!skip) {
          if (curCp === 'symbol') out += hexBuf.map(function (b) { return String.fromCharCode(0xf000 + b); }).join('');
          else out += dec.decode(new Uint8Array(hexBuf));
        }
        hexBuf = [];
      }
    }
    var n = s.length;
    var pos = 0;
    while (pos < n) {
      var ch = s.charAt(pos);
      if (ch === '{') {
        flushHex();
        stack.push({ skip: skip, uc: uc, cp: curCp });
        pos++;
        if (s.substr(pos, 2) === '\\*') skip = true;
        continue;
      }
      if (ch === '}') {
        flushHex();
        var st = stack.pop();
        if (st) { skip = st.skip; uc = st.uc; if (st.cp !== curCp) { curCp = st.cp; dec = decoderFor(curCp === 'symbol' ? 'windows-1252' : curCp); } }
        pos++;
        continue;
      }
      if (ch === '\\') {
        var nx = s.charAt(pos + 1);
        if (nx === "'") {
          var hex = parseInt(s.substr(pos + 2, 2), 16);
          pos += 4;
          if (pendingSkip > 0) { pendingSkip--; continue; }
          if (!isNaN(hex)) hexBuf.push(hex);
          continue;
        }
        flushHex();
        if (nx === '\\' || nx === '{' || nx === '}') {
          if (pendingSkip > 0) pendingSkip--;
          else if (!skip) out += nx;
          pos += 2;
          continue;
        }
        if (nx === '~') { if (!skip) out += '\u00a0'; pos += 2; continue; }
        if (nx === '-') { pos += 2; continue; }
        if (nx === '_') { if (!skip) out += '-'; pos += 2; continue; }
        if (nx === '\n' || nx === '\r') { if (!skip) out += '\n\n'; pos += 2; continue; }
        var m = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(s.substr(pos, 40));
        if (!m) { pos++; continue; }
        pos += m[0].length;
        var word = m[1];
        var param = m[2] != null ? parseInt(m[2], 10) : null;
        if (RTF_SKIP_DEST.test(word)) { skip = true; continue; }
        if (skip) continue;
        switch (word) {
          case 'par': case 'sect': case 'page': case 'row': out += '\n\n'; break;
          case 'line': out += '\n'; break;
          case 'tab': case 'cell': out += ' '; break;
          case 'emdash': out += '—'; break;
          case 'endash': out += '–'; break;
          case 'lquote': out += '‘'; break;
          case 'rquote': out += '’'; break;
          case 'ldblquote': out += '“'; break;
          case 'rdblquote': out += '”'; break;
          case 'bullet': out += '•'; break;
          case 'uc': uc = param == null ? 1 : param; break;
          case 'f': if (param != null) setFont(String(param)); break;
          case 'plain': break;
          case 'u':
            flushHex();
            if (param != null) out += String.fromCharCode(param < 0 ? param + 65536 : param);
            pendingSkip = uc;
            break;
          default: break;
        }
        continue;
      }
      if (ch === '\r' || ch === '\n') { pos++; continue; }
      if (pendingSkip > 0) { pendingSkip--; pos++; continue; }
      var code = ch.charCodeAt(0);
      if (code >= 0x80) { hexBuf.push(code); pos++; continue; }   // «сырые» 8-битные байты (нестандартно, но часто)
      flushHex();
      if (!skip) out += ch;
      pos++;
    }
    flushHex();
    var blocks = out.split(/\n\s*\n+/).map(function (p) { return p.trim(); }).filter(Boolean).map(function (p) {
      return isTxtHeading(p) ? { type: 'h', level: 1, text: p } : { type: 'p', text: p };
    });
    function decodeInfo(raw) {
      if (!raw) return '';
      var d = decoderFor(docCp === 'symbol' ? 'windows-1252' : docCp);
      var tb = [];
      for (var ti = 0; ti < raw.length; ti++) tb.push(raw.charCodeAt(ti) & 0xff);
      return d.decode(new Uint8Array(tb))
        .replace(/\\'([0-9a-f]{2})/gi, function (m, h) { return d.decode(new Uint8Array([parseInt(h, 16)])); })
        .replace(/\\u(-?\d+) ?\??/g, function (m, n) { n = +n; return String.fromCharCode(n < 0 ? n + 65536 : n); })
        .replace(/\\[a-z]+-?\d* ?/gi, '');
    }
    var authorM = s.match(/\{\\author\s+([^{}]*)\}/);
    var title = cleanPara(decodeInfo(titleM && titleM[1])) || baseName(sourceName);
    var author = cleanPara(decodeInfo(authorM && authorM[1])).replace(/\n/g, ' ');
    return finalizeBook({
      format: 'rtf', title: title, author: author, chapters: blocksToChapters(blocks, title),
      sourceName: sourceName, size: size
    });
  }

  /* ================= HTML ================= */

  function htmlToBook(bytes, sourceName, size) {
    var decoded = decodeText(bytes, sniffXmlEncoding(bytes)).text;
    var doc = new DOMParser().parseFromString(decoded, 'text/html');
    var ogt = doc.querySelector('meta[property="og:title"]');
    var title = textOf(doc.querySelector('title')) || (ogt ? ogt.content : '');
    var authorEl = doc.querySelector('meta[name="author"]');
    var lang = (doc.documentElement.getAttribute('lang') || '').slice(0, 8);
    var root = doc.querySelector('article') || doc.querySelector('main') || doc.body;
    var blocks = domToBlocks(root);
    var h1 = blocks.filter(function (b) { return b.type === 'h' && b.level === 1; });
    if (h1.length === 1) {
      if (!title) title = h1[0].text;
      if (normKey(h1[0].text) === normKey(title)) blocks = blocks.filter(function (b) { return b !== h1[0]; });
    }
    title = title || baseName(sourceName);
    return finalizeBook({
      format: 'html', title: title, author: authorEl ? authorEl.content : '', lang: lang,
      chapters: blocksToChapters(blocks, title), sourceName: sourceName, size: size
    });
  }

  /* ================= FB2 ================= */

  function fb2Title(titleEl) {
    if (!titleEl) return '';
    var ps = childrenLocal(titleEl, 'p').map(textOf).filter(Boolean);
    if (!ps.length) return textOf(titleEl);
    return ps.join('. ').replace(/\.\.+/g, '.');
  }

  /** Содержимое FB2-элемента (без вложенных section/title) → абзацы. */
  function fb2Paras(el, out, skipNames) {
    for (var c = el.firstElementChild; c; c = c.nextElementSibling) {
      var n = (c.localName || '').toLowerCase();
      if (skipNames && skipNames[n]) continue;
      if (n === 'p' || n === 'text-author') {
        var t = textOf(c);
        if (t) out.push(n === 'text-author' ? '— ' + t : t);
      } else if (n === 'subtitle') {
        var st = textOf(c);
        if (st) out.push({ h: st });
      } else if (n === 'poem') {
        for (var pc = c.firstElementChild; pc; pc = pc.nextElementSibling) {
          var pn = (pc.localName || '').toLowerCase();
          if (pn === 'title') {
            var pt = fb2Title(pc);
            if (pt) out.push({ h: pt });
          } else if (pn === 'stanza') {
            var vs = childrenLocal(pc, 'v').map(textOf).filter(Boolean);
            if (vs.length) out.push(vs.join('\n'));
          } else if (pn === 'text-author') {
            var ta = textOf(pc);
            if (ta) out.push('— ' + ta);
          } else if (pn === 'epigraph') {
            fb2Paras(pc, out);
          }
        }
      } else if (n === 'cite' || n === 'epigraph' || n === 'annotation') {
        fb2Paras(c, out);
      } else if (n === 'table') {
        childrenLocal(c, 'tr').forEach(function (tr) {
          var row = childrenLocal(tr).map(textOf).filter(Boolean).join(' · ');
          if (row) out.push(row);
        });
      }
    }
    return out;
  }

  var FB2_SKIP_SECTION = { section: true, title: true };

  function fb2Sections(container, chapters, state, depth) {
    childrenLocal(container, 'section').forEach(function (sec) {
      var title = fb2Title(childrenLocal(sec, 'title')[0]);
      var own = fb2Paras(sec, [], FB2_SKIP_SECTION);
      var hasSub = childrenLocal(sec, 'section').length > 0;
      if (own.some(hasWords)) {
        var paras = state.pending.map(function (h) { return { h: h }; }).concat(own);
        chapters.push({ title: title || '', level: Math.min(depth, 3), paras: paras });
        state.pending = [];
      } else if (title) {
        state.pending.push(title);
      }
      if (hasSub) fb2Sections(sec, chapters, state, depth + 1);
    });
  }

  async function fb2ToBook(xmlText, sourceName, size) {
    var doc = parseXml(xmlText);
    var root = firstLocal(doc, 'fictionbook') || doc.documentElement;
    if (!root || !firstLocal(root, 'body')) throw ImportError('Это не похоже на книгу FB2 (нет <body>).');
    var desc = firstLocal(root, 'description');
    var ti = firstLocal(desc, 'title-info');
    var title = textOf(firstLocal(ti, 'book-title'));
    var authors = childrenLocal(ti, 'author').map(function (a) {
      var parts = ['first-name', 'middle-name', 'last-name'].map(function (n) { return textOf(childrenLocal(a, n)[0]); }).filter(Boolean);
      return parts.join(' ') || textOf(childrenLocal(a, 'nickname')[0]);
    }).filter(Boolean);
    var lang = textOf(firstLocal(ti, 'lang'));
    var annEl = firstLocal(ti, 'annotation');
    var annotation = annEl ? fb2Paras(annEl, []).map(U.paraText).join('\n') : '';

    var chapters = [];
    var bodies = byLocal(root, 'body');
    bodies.forEach(function (body) {
      var bname = (body.getAttribute('name') || '').toLowerCase();
      if (bname === 'notes' || bname === 'comments' || bname === 'footnotes') {
        var notes = [];
        childrenLocal(body, 'section').forEach(function (sec) {
          var t = fb2Title(childrenLocal(sec, 'title')[0]);
          var ps = fb2Paras(sec, [], FB2_SKIP_SECTION);
          if (ps.length) ps[0] = (t ? t + ' ' : '') + U.paraText(ps[0]);
          notes = notes.concat(ps);
        });
        if (notes.length) chapters.push({ title: 'Примечания', level: 1, paras: notes });
        return;
      }
      var direct = fb2Paras(body, [], FB2_SKIP_SECTION);
      if (direct.some(hasWords)) {
        chapters.push({ title: fb2Title(childrenLocal(body, 'title')[0]) || 'Начало', level: 1, paras: direct });
      }
      fb2Sections(body, chapters, { pending: [] }, 1);
    });

    var cover = null;
    var coverImg = firstLocal(firstLocal(ti, 'coverpage'), 'image');
    if (coverImg) {
      var href = (attrLocal(coverImg, 'href') || '').replace(/^#/, '');
      var bin = byLocal(root, 'binary').filter(function (b) { return b.getAttribute('id') === href; })[0];
      if (bin) {
        try {
          var raw = atob((bin.textContent || '').replace(/\s+/g, ''));
          var arr = new Uint8Array(raw.length);
          for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
          cover = await imageToThumb(new Blob([arr], { type: bin.getAttribute('content-type') || 'image/jpeg' }));
        } catch (e) { cover = null; }
      }
    }
    return finalizeBook({
      format: 'fb2', title: title || baseName(sourceName), author: authors.join(', '), lang: lang,
      annotation: annotation, chapters: chapters, cover: cover, sourceName: sourceName, size: size
    });
  }

  /* ================= EPUB ================= */

  function dirOf(path) {
    var i = path.lastIndexOf('/');
    return i >= 0 ? path.slice(0, i + 1) : '';
  }

  function resolvePath(base, href) {
    href = String(href || '').split('#')[0];
    try { href = decodeURIComponent(href); } catch (e) { /* keep */ }
    if (/^[a-z]+:/i.test(href)) return null;
    if (!href) return base ? String(base) : null;
    var parts = (href.charAt(0) === '/' ? href.slice(1) : dirOf(base || '') + href).split('/');
    var out = [];
    parts.forEach(function (p) {
      if (p === '..') out.pop();
      else if (p !== '.' && p !== '') out.push(p);
    });
    return out.join('/');
  }

  function fragOf(href) {
    var i = String(href || '').indexOf('#');
    if (i < 0) return '';
    try { return decodeURIComponent(href.slice(i + 1)); } catch (e) { return href.slice(i + 1); }
  }

  function zipFile(zip, path) {
    if (!path) return null;
    var f = zip.file(path);
    if (f) return f;
    var lower = path.toLowerCase();
    var found = null;
    zip.forEach(function (rel, file) {
      if (!found && rel.toLowerCase() === lower) found = file;
    });
    return found;
  }

  var FONT_OBFUSCATION = /idpf\.org\/2008\/embedding|ns\.adobe\.com\/pdf\/enc#RC/i;

  async function epubToc(zip, manifest, spineTocId) {
    var entries = [];
    var navItem = null;
    Object.keys(manifest).forEach(function (id) {
      if (/(^|\s)nav(\s|$)/.test(manifest[id].props || '')) navItem = manifest[id];
    });
    var nf = navItem && zipFile(zip, navItem.path);
    if (nf) {
      var ndoc = parseXml(await nf.async('string'));
      var navs = byLocal(ndoc, 'nav');
      var nav = navs.filter(function (n) { return /toc/.test(attrLocal(n, 'type') || ''); })[0] || navs[0];
      var walkList = function (ol, depth) {
        childrenLocal(ol, 'li').forEach(function (li) {
          var a = childrenLocal(li, 'a')[0] || childrenLocal(li, 'span')[0];
          var href = a && a.getAttribute('href');
          if (href) entries.push({ title: textOf(a), file: resolvePath(navItem.path, href), frag: fragOf(href), depth: depth });
          var sub = childrenLocal(li, 'ol')[0];
          if (sub) walkList(sub, depth + 1);
        });
      };
      var ol = nav && (childrenLocal(nav, 'ol')[0] || firstLocal(nav, 'ol'));
      if (ol) walkList(ol, 0);
    }
    if (entries.length) return entries;
    var ncx = spineTocId && manifest[spineTocId];
    if (!ncx) {
      Object.keys(manifest).forEach(function (id) {
        if (/ncx/.test(manifest[id].type)) ncx = manifest[id];
      });
    }
    var f = ncx && zipFile(zip, ncx.path);
    if (!f) return entries;
    var xdoc = parseXml(await f.async('string'));
    var walkPoints = function (el, depth) {
      childrenLocal(el, 'navpoint').forEach(function (np) {
        var label = textOf(firstLocal(childrenLocal(np, 'navlabel')[0], 'text'));
        var content = childrenLocal(np, 'content')[0];
        var src = content ? content.getAttribute('src') : '';
        if (src) entries.push({ title: label, file: resolvePath(ncx.path, src), frag: fragOf(src), depth: depth });
        walkPoints(np, depth + 1);
      });
    };
    var navMap = firstLocal(xdoc, 'navmap');
    if (navMap) walkPoints(navMap, 0);
    return entries;
  }

  async function epubToBook(buf, sourceName, size, onProgress) {
    var JSZip = await loadJsZip();
    var zip;
    try {
      zip = await JSZip.loadAsync(buf);
    } catch (e) {
      throw ImportError('Не удалось открыть EPUB: файл повреждён или это не ZIP-архив.');
    }
    var containerF = zipFile(zip, 'META-INF/container.xml');
    if (!containerF) throw ImportError('Это не похоже на EPUB (нет META-INF/container.xml).');
    if (zipFile(zip, 'META-INF/rights.xml')) {
      throw ImportError('Книга защищена DRM (Adobe). Такие файлы прочитать нельзя — нужна версия без DRM.');
    }
    var encF = zipFile(zip, 'META-INF/encryption.xml');
    if (encF) {
      var encDoc = parseXml(await encF.async('string'));
      var drm = byLocal(encDoc, 'encrypteddata').some(function (ed) {
        var m = firstLocal(ed, 'encryptionmethod');
        var alg = m ? m.getAttribute('Algorithm') || '' : '';
        var ref = firstLocal(ed, 'cipherreference');
        var uri = ref ? ref.getAttribute('URI') || '' : '';
        if (FONT_OBFUSCATION.test(alg)) return false;
        return !/\.(otf|ttf|woff2?)$/i.test(uri);
      });
      if (drm) throw ImportError('Книга защищена DRM — текст зашифрован. Нужна версия без DRM (например, с Project Gutenberg или Standard Ebooks).');
    }
    var cdoc = parseXml(await containerF.async('string'));
    var rootfile = firstLocal(cdoc, 'rootfile');
    var opfPath = rootfile ? resolvePath('', rootfile.getAttribute('full-path')) : null;
    var opfF = zipFile(zip, opfPath);
    if (!opfF) throw ImportError('EPUB повреждён: не найден файл OPF.');
    var opf = parseXml(await opfF.async('string'));
    var md = firstLocal(opf, 'metadata');
    var title = textOf(firstLocal(md, 'title'));
    var author = byLocal(md, 'creator').map(textOf).filter(Boolean).slice(0, 3).join(', ');
    var lang = textOf(firstLocal(md, 'language'));
    var desc = textOf(firstLocal(md, 'description')).replace(/<[^>]+>/g, ' ');

    var manifest = {};
    byLocal(firstLocal(opf, 'manifest'), 'item').forEach(function (it) {
      manifest[it.getAttribute('id')] = {
        id: it.getAttribute('id'),
        path: resolvePath(opfPath, it.getAttribute('href')),
        type: (it.getAttribute('media-type') || '').toLowerCase(),
        props: it.getAttribute('properties') || ''
      };
    });
    var spineEl = firstLocal(opf, 'spine');
    var spine = childrenLocal(spineEl, 'itemref').map(function (r) {
      return manifest[r.getAttribute('idref')];
    }).filter(function (it) {
      return it && /html|xml/.test(it.type) && !/ncx/.test(it.type);
    });
    if (!spine.length) throw ImportError('В EPUB нет глав (пустой spine).');

    var toc = await epubToc(zip, manifest, spineEl && spineEl.getAttribute('toc'));
    toc = toc.filter(function (e) { return e.file && e.depth <= 1 && e.title; });
    var tocByFile = {};
    toc.forEach(function (e) { (tocByFile[e.file] = tocByFile[e.file] || []).push(e); });
    var useToc = toc.length >= 2 && spine.some(function (s) { return tocByFile[s.path]; });

    var chapters = [];
    var cur = null;
    function startChapter(t, depth) {
      cur = { title: t || '', level: (depth || 0) + 1, paras: [] };
      chapters.push(cur);
    }
    for (var si = 0; si < spine.length; si++) {
      var item = spine[si];
      if (onProgress) onProgress(0.1 + 0.85 * (si / spine.length), 'Главы ' + (si + 1) + '/' + spine.length);
      var f = zipFile(zip, item.path);
      if (!f) continue;
      var html = await f.async('string');
      var doc = parseXml(html, item.type === 'text/html');
      var body = firstLocal(doc, 'body') || doc.documentElement;
      var blocks = domToBlocks(body);
      var entries = useToc ? (tocByFile[item.path] || []).slice() : [];
      if (useToc) {
        var fileStart = entries.filter(function (e) { return !e.frag; })[0];
        if (fileStart) {
          startChapter(fileStart.title, fileStart.depth);
          entries = entries.filter(function (e) { return e.frag; });
        }
      } else {
        var firstH = blocks.filter(function (b) { return b.type === 'h'; })[0];
        startChapter(firstH ? firstH.text : '', 0);
      }
      for (var bi = 0; bi < blocks.length; bi++) {
        var b = blocks[bi];
        if (entries.length && b.ids && b.ids.length) {
          for (var ei = 0; ei < entries.length; ei++) {
            if (b.ids.indexOf(entries[ei].frag) >= 0) {
              startChapter(entries[ei].title, entries[ei].depth);
              entries.splice(ei, 1);
              break;
            }
          }
        }
        if (!cur) startChapter('', 0);
        cur.paras.push(b.type === 'h' ? { h: b.text } : b.text);
      }
    }
    chapters.forEach(function (ch, i) {
      if (!ch.title) {
        var h = ch.paras.filter(function (p) { return typeof p === 'object'; })[0];
        ch.title = h ? h.h : (i === 0 ? 'Начало' : '');
      }
    });

    var cover = null;
    var coverItem = null;
    var metaCover = byLocal(md, 'meta').filter(function (m) { return (m.getAttribute('name') || '') === 'cover'; })[0];
    if (metaCover) coverItem = manifest[metaCover.getAttribute('content')];
    Object.keys(manifest).forEach(function (id) {
      if (!coverItem && /cover-image/.test(manifest[id].props)) coverItem = manifest[id];
    });
    Object.keys(manifest).forEach(function (id) {
      if (!coverItem && /^image\//.test(manifest[id].type) && /cover/i.test(id + ' ' + manifest[id].path)) coverItem = manifest[id];
    });
    if (coverItem && /^image\//.test(coverItem.type)) {
      var cf = zipFile(zip, coverItem.path);
      if (cf) {
        try {
          var cbytes = await cf.async('uint8array');
          cover = await imageToThumb(new Blob([cbytes], { type: coverItem.type }));
        } catch (e) { cover = null; }
      }
    }
    return finalizeBook({
      format: 'epub', title: title || baseName(sourceName), author: author, lang: lang,
      annotation: desc, chapters: chapters, cover: cover, sourceName: sourceName, size: size
    });
  }

  /* ================= DOCX ================= */

  var W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

  function wVal(el) {
    return el ? (el.getAttributeNS(W_NS, 'val') || attrLocal(el, 'val') || '') : '';
  }

  async function docxToBook(buf, sourceName, size, onProgress) {
    var JSZip = await loadJsZip();
    var zip;
    try { zip = await JSZip.loadAsync(buf); } catch (e) {
      throw ImportError('Не удалось открыть DOCX: файл повреждён.');
    }
    var docF = zipFile(zip, 'word/document.xml');
    if (!docF) throw ImportError('Это не документ Word (.docx). Старый .doc не поддерживается: сохраните как .docx.');
    var styleNames = {};
    var styleOutline = {};
    var stF = zipFile(zip, 'word/styles.xml');
    if (stF) {
      var sdoc = parseXml(await stF.async('string'));
      byLocal(sdoc, 'style').forEach(function (st) {
        var id = st.getAttributeNS(W_NS, 'styleId') || attrLocal(st, 'styleid');
        if (!id) return;
        styleNames[id] = wVal(firstLocal(st, 'name'));
        var ol = firstLocal(firstLocal(st, 'ppr'), 'outlinelvl');
        if (ol) styleOutline[id] = parseInt(wVal(ol), 10);
      });
    }
    if (onProgress) onProgress(0.3, 'Чтение документа');
    var doc = parseXml(await docF.async('string'));
    var title = '';
    var author = '';
    var coreF = zipFile(zip, 'docProps/core.xml');
    if (coreF) {
      var core = parseXml(await coreF.async('string'));
      title = textOf(firstLocal(core, 'title'));
      author = textOf(firstLocal(core, 'creator'));
    }
    var SKIP_W = { deltext: 1, del: 1, instrtext: 1, ppr: 1, rpr: 1, footnotereference: 1, endnotereference: 1, p: 1, fallback: 1 };
    function runText(el) {
      var text = '';
      for (var c = el.firstChild; c; c = c.nextSibling) {
        if (c.nodeType !== 1) continue;
        var n = (c.localName || '').toLowerCase();
        if (n === 't') text += c.textContent;
        else if (n === 'tab') text += ' ';
        else if (n === 'br' || n === 'cr') text += '\n';
        else if (n === 'nobreakhyphen') text += '-';
        else if (SKIP_W[n]) continue;
        else text += runText(c);
      }
      return text;
    }
    var blocks = [];
    var styleTitle = '';
    byLocal(doc, 'p').forEach(function (p) {
      for (var a = p.parentNode; a && a.nodeType === 1; a = a.parentNode) {
        if ((a.localName || '').toLowerCase() === 'fallback') return;
      }
      var text = cleanPara(runText(p));
      if (!text) return;
      var ppr = childrenLocal(p, 'ppr')[0];
      var sid = wVal(ppr && childrenLocal(ppr, 'pstyle')[0]);
      var sname = (styleNames[sid] || sid || '').toLowerCase();
      var level = 0;
      var hm = sname.match(/^(?:heading|заголовок)\s*(\d)/) || sid.toLowerCase().match(/^heading(\d)$/);
      if (hm) level = parseInt(hm[1], 10);
      var olEl = ppr && childrenLocal(ppr, 'outlinelvl')[0];
      if (!level && olEl) {
        var ov = parseInt(wVal(olEl), 10);
        if (ov >= 0 && ov < 6) level = ov + 1;
      }
      if (!level && styleOutline[sid] != null && styleOutline[sid] < 6) level = styleOutline[sid] + 1;
      if (sname === 'title' || sname === 'название') {
        if (!styleTitle) styleTitle = text.replace(/\n/g, ' ');
        return;
      }
      if (level && text.length < 200) blocks.push({ type: 'h', level: level, text: text.replace(/\n/g, ' ') });
      else blocks.push({ type: 'p', text: text });
    });
    title = styleTitle || title || baseName(sourceName);
    return finalizeBook({
      format: 'docx', title: title, author: author,
      chapters: blocksToChapters(blocks, title), sourceName: sourceName, size: size
    });
  }

  /* ================= PDF ================= */

  function median(arr) {
    if (!arr.length) return 0;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    return a[Math.floor(a.length / 2)];
  }

  function percentile(arr, p) {
    if (!arr.length) return 0;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    return a[Math.min(a.length - 1, Math.floor(a.length * p))];
  }

  /** Элементы pdf.js → строки { x, xEnd, y, h, text }. Порядок потока сохраняем (колонки не перемешиваются). */
  function itemsToLines(items) {
    var lines = [];
    var cur = null;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it || typeof it.str !== 'string') continue;
      var tr = it.transform || [1, 0, 0, 1, 0, 0];
      var x = tr[4];
      var y = tr[5];
      var h = Math.abs(it.height) || Math.hypot(tr[2], tr[3]) || 10;
      var w = it.width || 0;
      if (it.str === '' && !it.hasEOL) continue;
      if (it.str.trim()) {
        var newLine = !cur || Math.abs(y - cur.y) > Math.max(2, Math.min(h, cur.h) * 0.5) || x < cur.xEnd - h * 4;
        if (newLine) {
          if (cur && cur.text.trim()) lines.push(cur);
          cur = { x: x, xEnd: x + w, y: y, h: h, text: it.str };
        } else {
          var gap = x - cur.xEnd;
          if (gap > h * 0.15 && !/\s$/.test(cur.text) && !/^\s/.test(it.str)) cur.text += ' ';
          cur.text += it.str;
          cur.xEnd = Math.max(cur.xEnd, x + w);
          cur.h = Math.max(cur.h, h);
        }
      } else if (cur && it.str) {
        cur.text += ' ';
      }
      if (it.hasEOL && cur && cur.text.trim()) {
        lines.push(cur);
        cur = null;
      }
    }
    if (cur && cur.text.trim()) lines.push(cur);
    lines.forEach(function (l) { l.text = l.text.replace(/\s+/g, ' ').trim(); });
    return lines.filter(function (l) { return l.text; });
  }

  var PAGE_NUM_RE = /^[\s\-–—|•·]*(?:(?:page|стр\.?|страница|p\.)\s*)?(?:\d{1,4}|[ivxlcdm]{1,7})(?:\s*(?:of|из|\/)\s*\d{1,4})?[\s\-–—|•·]*$/i;

  /** Колонтитулы и номера страниц: повторяющиеся первые/последние строки страниц. */
  function removeRunningHeads(pages) {
    var n = pages.length;
    var keyCount = {};
    function key(t) { return t.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim(); }
    function edgeIdx(L) { return [0, 1, L.length - 2, L.length - 1].filter(function (i, k, arr) { return i >= 0 && i < L.length && arr.indexOf(i) === k; }); }
    pages.forEach(function (pg) {
      var seen = {};
      edgeIdx(pg.lines).forEach(function (i) {
        var k = key(pg.lines[i].text);
        if (k.length < 2 || seen[k]) return;
        seen[k] = true;
        keyCount[k] = (keyCount[k] || 0) + 1;
      });
    });
    var minRepeat = Math.max(3, Math.ceil(n * 0.25));
    pages.forEach(function (pg) {
      var L = pg.lines;
      var drop = {};
      edgeIdx(L).forEach(function (i) {
        var t = L[i].text;
        if (PAGE_NUM_RE.test(t)) drop[i] = true;
        else if (n >= 3 && (keyCount[key(t)] || 0) >= minRepeat && t.length < 120) drop[i] = true;
      });
      pg.lines = L.filter(function (_, i) { return !drop[i]; });
    });
  }

  var END_PUNCT_RE = /[.!?…:"”»)\]]$/;

  /** Строки → абзацы: склейка переносов, отступы, интервалы, крупный шрифт = заголовок. */
  function linesToParas(pages) {
    var heights = [];
    var gaps = [];
    var widths = [];
    pages.forEach(function (pg) {
      pg.lines.forEach(function (l, i) {
        for (var k = 0; k < Math.min(l.text.length, 200); k += 20) heights.push(l.h);
        widths.push(l.xEnd - l.x);
        var prev = pg.lines[i - 1];
        if (prev && Math.abs(prev.h - l.h) < l.h * 0.2) {
          var g = prev.y - l.y;
          if (g > 0 && g < l.h * 3) gaps.push(g);
        }
      });
    });
    var bodyH = median(heights) || 10;
    var lineGap = median(gaps) || bodyH * 1.2;
    var fullW = percentile(widths, 0.9) || 400;
    var paras = [];
    var cur = null;

    function push() {
      if (cur && cur.text.trim()) paras.push(cur);
      cur = null;
    }

    function join(a, b) {
      if (/[A-Za-zА-Яа-яЁё]-$/.test(a) && /^[a-zа-яё]/.test(b)) return a.slice(0, -1) + b;
      return a + ' ' + b;
    }

    pages.forEach(function (pg, pi) {
      var leftMode = median(pg.lines.map(function (l) { return Math.round(l.x); })) || 0;
      pg.lines.forEach(function (l, li) {
        var isHeading = l.h >= bodyH * 1.25 && l.text.length < 120;
        var prev = li > 0 ? pg.lines[li - 1] : null;
        var startNew = false;
        if (!cur) startNew = true;
        else if (isHeading !== !!cur.heading) startNew = true;
        else if (isHeading) startNew = prev ? (prev.y - l.y) > l.h * 2.2 : true;
        else if (!prev) {
          // первая строка страницы: продолжаем абзац прошлой страницы, если он не закончен
          startNew = END_PUNCT_RE.test(cur.text) && !/^[a-zа-яё]/.test(l.text);
        } else {
          var gap = prev.y - l.y;
          if (gap > lineGap * 1.45 || gap < -bodyH) startNew = true;
          else if (l.x > leftMode + bodyH * 0.8 && l.x < leftMode + fullW * 0.5 && prev.x <= leftMode + bodyH * 0.5) startNew = true;
          else if (END_PUNCT_RE.test(prev.text) && (prev.xEnd - prev.x) < fullW * 0.72) startNew = true;
          else if (Math.abs(l.h - prev.h) > bodyH * 0.25) startNew = true;
        }
        if (startNew) {
          push();
          cur = { text: l.text, page: pi, y: l.y, h: l.h, heading: isHeading };
        } else {
          cur.text = join(cur.text, l.text);
        }
      });
    });
    push();
    return { paras: paras, bodyH: bodyH };
  }

  async function resolveOutline(pdf) {
    var outline = null;
    try { outline = await pdf.getOutline(); } catch (e) { return []; }
    if (!outline || !outline.length) return [];
    var items = [];
    outline.forEach(function (o) {
      items.push({ o: o, depth: 0 });
      (o.items || []).forEach(function (s) { items.push({ o: s, depth: 1 }); });
    });
    if (items.length > 400) items = outline.map(function (o) { return { o: o, depth: 0 }; });
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var o = items[i].o;
      try {
        var dest = o.dest;
        if (typeof dest === 'string') dest = await pdf.getDestination(dest);
        if (!Array.isArray(dest) || !dest.length) continue;
        var ref = dest[0];
        var pageIndex = typeof ref === 'number' ? ref : await pdf.getPageIndex(ref);
        var y = null;
        if (dest[1] && dest[1].name === 'XYZ' && typeof dest[3] === 'number') y = dest[3];
        else if (dest[1] && dest[1].name === 'FitH' && typeof dest[2] === 'number') y = dest[2];
        out.push({ title: String(o.title || '').trim(), page: pageIndex, y: y, depth: items[i].depth, order: i });
      } catch (e) { /* битые ссылки пропускаем */ }
    }
    out.sort(function (a, b) {
      return a.page - b.page || ((b.y == null ? 1e9 : b.y) - (a.y == null ? 1e9 : a.y)) || a.order - b.order;
    });
    return out.filter(function (s) { return s.title; });
  }

  function cleanPdfTitle(t) {
    t = String(t || '').trim();
    t = t.replace(/^Microsoft (?:Word|PowerPoint) - /i, '').replace(/\.(docx?|pptx?|indd|tex)$/i, '');
    if (/^(untitled|без названия|document\d*)$/i.test(t)) return '';
    return t;
  }

  async function pdfToBook(buf, sourceName, size, onProgress) {
    var lib = await loadPdfJs();
    var pdf;
    try {
      pdf = await lib.getDocument({
        data: new Uint8Array(buf),
        standardFontDataUrl: libUrl('lib/pdfjs/standard_fonts/'),
        isEvalSupported: false
      }).promise;
    } catch (err) {
      if (err && err.name === 'PasswordException') throw ImportError('PDF защищён паролем — снимите защиту и импортируйте снова.');
      throw ImportError('Не удалось открыть PDF: ' + (err && err.message ? err.message : 'файл повреждён'));
    }
    var info = {};
    try { info = ((await pdf.getMetadata()) || {}).info || {}; } catch (e) { info = {}; }
    var pages = [];
    var chars = 0;
    for (var p = 1; p <= pdf.numPages; p++) {
      var page = await pdf.getPage(p);
      var tc = await page.getTextContent();
      var lines = itemsToLines(tc.items || []);
      lines.forEach(function (l) { chars += l.text.length; });
      pages.push({ lines: lines });
      if (typeof page.cleanup === 'function') page.cleanup();
      if (onProgress) onProgress(0.05 + 0.8 * (p / pdf.numPages), 'Страница ' + p + ' из ' + pdf.numPages);
    }
    if (chars < 40 * pdf.numPages && chars < 800) {
      try { await pdf.destroy(); } catch (e) { /* ignore */ }
      throw ImportError('В этом PDF нет текстового слоя (похоже на скан). Нужно распознать текст (OCR) — например, в Adobe Scan, ABBYY FineReader или Google Диске — и импортировать снова.');
    }
    removeRunningHeads(pages);
    var built = linesToParas(pages);
    var paras = built.paras;
    var starts = await resolveOutline(pdf);

    var chapters = [];
    function asPara(pa) { return pa.heading ? { h: pa.text } : pa.text; }
    if (starts.length >= 2) {
      var si = 0;
      var cur = { title: 'Начало', level: 1, paras: [] };
      paras.forEach(function (pa) {
        while (si < starts.length) {
          var s = starts[si];
          var reached = pa.page > s.page || (pa.page === s.page && (s.y == null || pa.y <= s.y + pa.h * 1.5));
          if (!reached) break;
          if (cur.paras.some(hasWords)) chapters.push(cur);
          cur = { title: s.title, level: s.depth + 1, paras: [] };
          si++;
        }
        cur.paras.push(asPara(pa));
      });
      chapters.push(cur);
    } else {
      var heads = paras.filter(function (pa) { return pa.heading && pa.h >= built.bodyH * 1.4 && pa.text.length < 90; });
      if (heads.length >= 3 && heads.length <= 300 && paras.length / heads.length >= 8) {
        var c2 = { title: 'Начало', level: 1, paras: [] };
        paras.forEach(function (pa) {
          if (heads.indexOf(pa) >= 0) {
            if (c2.paras.some(hasWords)) chapters.push(c2);
            c2 = { title: pa.text, level: 1, paras: [] };
            return;
          }
          c2.paras.push(asPara(pa));
        });
        chapters.push(c2);
      } else {
        chapters.push({ title: '', level: 1, paras: paras.map(asPara) });
      }
    }

    var cover = null;
    try {
      if (onProgress) onProgress(0.9, 'Обложка');
      var first = await pdf.getPage(1);
      var vp1 = first.getViewport({ scale: 1 });
      var vp = first.getViewport({ scale: 240 / vp1.width });
      var canvas = document.createElement('canvas');
      canvas.width = Math.round(vp.width);
      canvas.height = Math.round(vp.height);
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await first.render({ canvasContext: ctx, canvas: canvas, viewport: vp }).promise;
      cover = canvas.toDataURL('image/jpeg', 0.75);
    } catch (e) { cover = null; }
    try { await pdf.destroy(); } catch (e) { /* ignore */ }

    return finalizeBook({
      format: 'pdf', title: cleanPdfTitle(info.Title) || baseName(sourceName),
      author: String(info.Author || '').trim(), chapters: chapters, cover: cover,
      sourceName: sourceName, size: size
    });
  }

  /* ================= Определение формата и вход ================= */

  var ACCEPT = '.epub,.pdf,.fb2,.zip,.txt,.text,.html,.htm,.xhtml,.docx,.doc,.md,.markdown,.rtf,' +
    'application/epub+zip,application/pdf,text/plain,text/html,text/markdown,application/rtf,text/rtf,application/msword,' +
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/x-fictionbook+xml,application/zip';

  function startsWith(bytes, str) {
    for (var i = 0; i < str.length; i++) if (bytes[i] !== str.charCodeAt(i)) return false;
    return true;
  }

  async function detectFormat(file, bytes) {
    var name = String(file.name || '').toLowerCase();
    if (/\.fb2\.zip$/.test(name)) return 'fb2zip';
    var ext = (name.match(/\.([a-z0-9]+)$/) || [])[1] || '';
    var map = {
      pdf: 'pdf', epub: 'epub', fb2: 'fb2', txt: 'txt', text: 'txt', html: 'html', htm: 'html',
      xhtml: 'html', docx: 'docx', md: 'md', markdown: 'md', rtf: 'rtf'
    };
    if (startsWith(bytes, '%PDF')) return 'pdf';
    if (startsWith(bytes, '{\\rtf')) return 'rtf';
    if (bytes[0] === 0x50 && bytes[1] === 0x4B) {
      var JSZip = await loadJsZip();
      var zip;
      try { zip = await JSZip.loadAsync(bytes); } catch (e) { return ext === 'epub' || ext === 'docx' ? ext : 'zip'; }
      if (zip.file('META-INF/container.xml')) return 'epub';
      if (zip.file('word/document.xml')) return 'docx';
      var hasFb2 = false;
      zip.forEach(function (rel) { if (/\.fb2$/i.test(rel)) hasFb2 = true; });
      if (hasFb2) return 'fb2zip';
      if (ext === 'epub' || ext === 'docx') return ext;
      return 'zip';
    }
    if (ext === 'mobi' || ext === 'azw' || ext === 'azw3' || ext === 'kfx' || ext === 'prc') return 'mobi';
    if (bytes.length > 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) return 'doc';
    if (ext === 'djvu' || ext === 'djv') return 'djvu';
    var head = '';
    for (var i = 0; i < Math.min(bytes.length, 600); i++) head += String.fromCharCode(bytes[i]);
    if (/<FictionBook/i.test(head)) return 'fb2';
    if (map[ext]) return map[ext];
    if (/<html|<!doctype html/i.test(head)) return 'html';
    if (!/[\x00-\x08\x0e-\x1a]/.test(head.slice(0, 400))) return 'txt';
    return 'unknown';
  }

  /** File → { meta, content, cover }. onProgress(доля 0..1, подпись). */
  async function parseFile(file, onProgress) {
    if (!file) throw ImportError('Файл не выбран.');
    if (!file.size) throw ImportError('Файл пустой.');
    if (file.size > MAX_FILE_BYTES) throw ImportError('Файл слишком большой (больше 200 МБ).');
    if (onProgress) onProgress(0.02, 'Чтение файла');
    var buf = await file.arrayBuffer();
    var bytes = new Uint8Array(buf);
    var fmt = await detectFormat(file, bytes);
    var name = file.name || 'Книга';
    switch (fmt) {
      case 'pdf': return pdfToBook(buf, name, file.size, onProgress);
      case 'epub': return epubToBook(buf, name, file.size, onProgress);
      case 'docx': return docxToBook(buf, name, file.size, onProgress);
      case 'fb2': {
        if (onProgress) onProgress(0.4, 'Разбор FB2');
        return fb2ToBook(decodeText(bytes, sniffXmlEncoding(bytes)).text, name, file.size);
      }
      case 'fb2zip': {
        var JSZip = await loadJsZip();
        var zip = await JSZip.loadAsync(buf);
        var fbFile = null;
        zip.forEach(function (rel, f) { if (!fbFile && /\.fb2$/i.test(rel)) fbFile = f; });
        if (!fbFile) throw ImportError('В архиве нет файла .fb2.');
        var fbBytes = await fbFile.async('uint8array');
        if (onProgress) onProgress(0.4, 'Разбор FB2');
        return fb2ToBook(decodeText(fbBytes, sniffXmlEncoding(fbBytes)).text, name.replace(/\.zip$/i, ''), file.size);
      }
      case 'txt': {
        if (onProgress) onProgress(0.4, 'Разбор текста');
        return txtToBook(decodeText(bytes).text, name, file.size);
      }
      case 'md': return mdToBook(decodeText(bytes).text, name, file.size);
      case 'html': return htmlToBook(bytes, name, file.size);
      case 'rtf': return rtfToBook(bytes, name, file.size);
      case 'mobi': throw ImportError('MOBI/AZW (Kindle) не поддерживается. Конвертируйте книгу в EPUB, например бесплатной программой Calibre.');
      case 'doc': {
        if (onProgress) onProgress(0.4, 'Разбор Word .doc');
        return docToBook(bytes, name, file.size);
      }
      case 'djvu': throw ImportError('DjVu — это сканы страниц без текста. Нужен PDF/EPUB с текстом.');
      case 'zip': throw ImportError('В ZIP-архиве не найдена книга (EPUB, DOCX или FB2).');
      default: throw ImportError('Неизвестный формат файла. Поддерживаются: EPUB, PDF, FB2, TXT, DOCX, DOC, HTML, MD, RTF.');
    }
  }

  global.LexBookParsers = {
    parseFile: parseFile,
    ACCEPT: ACCEPT,
    _txtToBook: txtToBook,
    _decodeText: decodeText,
    _domToBlocks: domToBlocks
  };
})(typeof window !== 'undefined' ? window : self);
