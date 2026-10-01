/**
 * Лексикон — чтение PDF (STAGE A).
 * Извлечение текста через pdf.js (CDN), хранение в IndexedDB, оверлей-ридер.
 * Lookup / bubble / translate — STAGE B (пока только spans .rw).
 */
(function (global) {
  'use strict';

  var PDFJS_VERSION = '6.3.289';
  var PDFJS_BASE = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@' + PDFJS_VERSION + '/build/';
  var PDFJS_MAIN = PDFJS_BASE + 'pdf.min.mjs';
  var PDFJS_WORKER = PDFJS_BASE + 'pdf.worker.min.mjs';

  var pdfjsLib = null;
  var pdfjsLoading = null;
  var currentDocId = null;
  var bound = false;

  function $(id) { return document.getElementById(id); }

  function toast(msg, kind) {
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

  /* ---- Text cleanup ---- */

  function cleanupText(raw) {
    var t = String(raw || '');
    t = t.replace(/\f+/g, '\n');
    t = t.replace(/\u00ad+/g, '');
    t = t.replace(/\r\n?/g, '\n');
    // Soft hyphenation across line breaks: "exam-\nple" → "example"
    t = t.replace(/([A-Za-zА-Яа-яЁё])-\n([A-Za-zА-Яа-яЁё])/g, '$1$2');
    // Collapse horizontal whitespace
    t = t.replace(/[ \t\u00a0\u2000-\u200b]+/g, ' ');
    // Trim each line
    t = t.split('\n').map(function (line) { return line.trim(); }).join('\n');
    // Soft wraps (single newline) → space; keep blank lines as paragraph breaks
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
        // Missing space between adjacent items (keep punctuation glued)
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

  function openReader(doc) {
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
  }

  function closeReader() {
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
        if (!confirm('Удалить «' + (doc.title || 'документ') + '»? Текст будет потерян.')) return;
        try {
          await LexDB.deleteDocument(doc.id);
          if (currentDocId === doc.id) closeReader();
          toast('Документ удалён', 'ok');
          refreshList();
        } catch (err) {
          toast('Не удалось удалить: ' + err.message, 'error');
        }
      });

      var lab = document.createElement('label');
      lab.className = 'switch';
      lab.title = 'Участвует в ленте (скоро)';
      var inp = document.createElement('input');
      inp.type = 'checkbox';
      inp.checked = doc.participate !== false;
      inp.addEventListener('change', async function () {
        try {
          doc.participate = !!inp.checked;
          await LexDB.putDocument(doc);
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
      // Also open on title tap
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

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && currentDocId) closeReader();
    });
  }

  function init() {
    bindUi();
    return refreshList();
  }

  global.LexReader = {
    init: init,
    refreshList: refreshList,
    importPdfFile: importPdfFile,
    openReader: openReader,
    closeReader: closeReader,
    pickPdf: pickPdf,
    cleanupText: cleanupText
  };
})(typeof window !== 'undefined' ? window : self);
