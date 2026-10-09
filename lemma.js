/**
 * Лексикон — простая английская лемматизация (правила + неправильные формы).
 * Общая для ленты (пропуск в предложении), читалки (фразы) и Web Worker (покрытие книги).
 * Не словарь: выдаёт КАНДИДАТЫ лемм, выбор — по наличию в колодах/тексте.
 */
(function (global) {
  'use strict';

  // форма → лемма (глаголы: past / past participle; существительные; прилагательные)
  var IRR_SRC =
    'arose,arisen:arise awoke,awoken:awake was,were,been,am,is,are:be bore,borne,born:bear beat,beaten:beat ' +
    'became:become began,begun:begin bent:bend bet:bet bound:bind bit,bitten:bite bled:bleed blew,blown:blow ' +
    'broke,broken:break bred:breed brought:bring built:build burnt:burn burst:burst bought:buy caught:catch ' +
    'chose,chosen:choose clung:cling came:come cost:cost crept:creep dealt:deal dug:dig did,done,does:do ' +
    'drew,drawn:draw dreamt:dream drank,drunk:drink drove,driven:drive ate,eaten:eat fell,fallen:fall fed:feed ' +
    'felt:feel fought:fight found:find fled:flee flung:fling flew,flown:fly forbade,forbidden:forbid ' +
    'forgot,forgotten:forget forgave,forgiven:forgive froze,frozen:freeze got,gotten:get gave,given:give ' +
    'went,gone:go ground:grind grew,grown:grow hung:hang had,has:have heard:hear hid,hidden:hide hit:hit ' +
    'held:hold hurt:hurt kept:keep knelt:kneel knew,known:know laid:lay led:lead leapt:leap learnt:learn ' +
    'left:leave lent:lend let:let lay,lain:lie lit:light lost:lose made:make meant:mean met:meet ' +
    'mistook,mistaken:mistake overcame:overcome paid:pay put:put quit:quit read:read rode,ridden:ride ' +
    'rang,rung:ring rose,risen:rise ran:run said:say saw,seen:see sought:seek sold:sell sent:send set:set ' +
    'shook,shaken:shake shone:shine shot:shoot showed,shown:show shrank,shrunk:shrink shut:shut sang,sung:sing ' +
    'sank,sunk:sink sat:sit slept:sleep slid:slide slung:sling spoke,spoken:speak spent:spend spun:spin ' +
    'split:split spread:spread sprang,sprung:spring stood:stand stole,stolen:steal stuck:stick stung:sting ' +
    'stank:stink strode:stride struck,stricken:strike strove,striven:strive swore,sworn:swear swept:sweep ' +
    'swam,swum:swim swung:swing took,taken:take taught:teach tore,torn:tear told:tell thought:think ' +
    'threw,thrown:throw thrust:thrust trod,trodden:tread understood:understand undertook,undertaken:undertake ' +
    'upset:upset woke,woken:wake wore,worn:wear wove,woven:weave wept:weep won:win wound:wind ' +
    'withdrew,withdrawn:withdraw wrung:wring wrote,written:write ' +
    'men:man women:woman children:child feet:foot teeth:tooth mice:mouse geese:goose people:person ' +
    'lives:life wives:wife knives:knife leaves:leaf halves:half shelves:shelf wolves:wolf thieves:thief ' +
    'crises:crisis analyses:analysis phenomena:phenomenon criteria:criterion data:datum ' +
    'better,best:good worse,worst:bad further,furthest,farther,farthest:far elder,eldest:old less,least:little ' +
    "i'm:i you're:you we're:we they're:they he's:he she's:she it's:it";
  var IRR = {};
  IRR_SRC.split(' ').forEach(function (grp) {
    var p = grp.split(':');
    if (p.length !== 2) return;
    p[0].split(',').forEach(function (f) { if (f) IRR[f] = IRR[f] ? IRR[f] + '|' + p[1] : p[1]; });
  });

  var VOWEL = /[aeiou]/;

  function norm(w) {
    return String(w || '').toLowerCase().replace(/[’‘`´]/g, "'").replace(/^'+|'+$/g, '');
  }

  /** Кандидаты лемм для словоформы (первым — сама форма). */
  function candidates(surface) {
    var w = norm(surface);
    if (!w) return [];
    var out = [w];
    function add(x) { if (x && x.length >= 2 && out.indexOf(x) < 0) out.push(x); }
    if (IRR[w]) IRR[w].split('|').forEach(add);
    if (/'s$/.test(w)) add(w.slice(0, -2));
    if (/s'$/.test(w)) add(w.slice(0, -1));
    var n = w.length;
    // -ies / -ied → y
    if (n > 4 && /ies$/.test(w)) add(w.slice(0, -3) + 'y');
    if (n > 4 && /ied$/.test(w)) add(w.slice(0, -3) + 'y');
    // -es
    if (n > 3 && /(ches|shes|sses|xes|zes|oes)$/.test(w)) add(w.slice(0, -2));
    if (n > 3 && /es$/.test(w)) add(w.slice(0, -1));
    // -s
    if (n > 2 && /s$/.test(w) && !/(ss|us|is)$/.test(w)) add(w.slice(0, -1));
    // -ing
    if (n > 5 && /ing$/.test(w)) {
      var b = w.slice(0, -3);
      add(b);
      add(b + 'e');
      if (/([b-df-hj-np-tv-z])\1$/.test(b)) add(b.slice(0, -1));
      if (/y$/.test(b)) add(b.slice(0, -1) + 'ie');
    }
    // -ed
    if (n > 3 && /ed$/.test(w)) {
      var s = w.slice(0, -2);
      add(s);
      add(w.slice(0, -1));
      if (/([b-df-hj-np-tv-z])\1$/.test(s)) add(s.slice(0, -1));
    }
    // -er / -est (сравнительная степень)
    if (n > 4 && /est$/.test(w)) {
      var e1 = w.slice(0, -3);
      add(e1); add(e1 + 'e');
      if (/i$/.test(e1)) add(e1.slice(0, -1) + 'y');
      if (/([b-df-hj-np-tv-z])\1$/.test(e1)) add(e1.slice(0, -1));
    }
    if (n > 4 && /er$/.test(w)) {
      var e2 = w.slice(0, -2);
      add(e2); add(e2 + 'e');
      if (/i$/.test(e2)) add(e2.slice(0, -1) + 'y');
      if (/([b-df-hj-np-tv-z])\1$/.test(e2)) add(e2.slice(0, -1));
    }
    // -ly (наречие → прилагательное) — последним, слабый кандидат
    if (n > 5 && /ly$/.test(w)) {
      var l = w.slice(0, -2);
      if (/i$/.test(l)) add(l.slice(0, -1) + 'y');
      else add(l);
      if (/ab$|ib$/.test(l)) add(l + 'le');
    }
    return out.filter(function (x) { return VOWEL.test(x) || x.length <= 3 || /y/.test(x); });
  }

  /** Совпадает ли словоформа с леммой (или формой) lemma. */
  function matches(surface, lemma) {
    var L = norm(lemma);
    if (!L) return false;
    var c = candidates(surface);
    if (c.indexOf(L) >= 0) return true;
    // лемма сама может быть формой (карточка «went»)
    var cl = candidates(L);
    for (var i = 0; i < c.length; i++) if (cl.indexOf(c[i]) >= 0 && c[i].length >= 3) return true;
    return false;
  }

  var WORD_RE = /[A-Za-zÀ-ÖØ-öø-ÿĀ-ž]+(?:['’][A-Za-zÀ-ÖØ-öø-ÿĀ-ž]+)*/g;

  /** Токены предложения: [{text, start, end}] */
  function tokenize(text) {
    var out = [], m;
    WORD_RE.lastIndex = 0;
    while ((m = WORD_RE.exec(text))) out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
    return out;
  }

  /**
   * Найти слово/фразу (с учётом форм) в предложении → {start, end} или null.
   * Для фраз: каждое слово фразы сопоставляется по формам, артикли/местоимения в середине фразы
   * («make a difference» ← «made a real difference») допускают 1 вставку.
   */
  function findInText(text, target) {
    text = String(text || '');
    var parts = tokenize(String(target || '')).map(function (t) { return t.text; });
    if (!parts.length) return null;
    var toks = tokenize(text);
    // 'smb/sth' и т. п. в шаблонах фраз — пропускаем
    parts = parts.filter(function (p) { return !/^(sb|smb|sth|smth|someone|something|one's|oneself)$/i.test(p); });
    if (!parts.length) return null;
    for (var i = 0; i < toks.length; i++) {
      if (!matches(toks[i].text, parts[0]) && norm(toks[i].text) !== norm(parts[0])) continue;
      var j = i, k = 1, gaps = 0;
      while (k < parts.length && j + 1 < toks.length) {
        var nt = toks[j + 1];
        if (matches(nt.text, parts[k]) || norm(nt.text) === norm(parts[k])) { j++; k++; continue; }
        if (gaps < (parts.length > 1 ? 2 : 0)) { gaps++; j++; continue; }
        break;
      }
      if (k === parts.length) return { start: toks[i].start, end: toks[j].end, text: text.slice(toks[i].start, toks[j].end) };
    }
    // запасной вариант: общий корень ≥ 5 букв для одиночного слова (decide → decision не ловим, но
    // considered ~ consider ловится и правилами)
    if (parts.length === 1 && parts[0].length >= 6) {
      var stem = norm(parts[0]).slice(0, Math.max(5, parts[0].length - 2));
      for (var q = 0; q < toks.length; q++) {
        if (norm(toks[q].text).indexOf(stem) === 0) return { start: toks[q].start, end: toks[q].end, text: toks[q].text };
      }
    }
    return null;
  }

  // ~200 служебных/базовых слов, которые считаются знакомыми в покрытии книги
  var FUNCTION_WORDS = (
    'a an the and or but nor so yet if then than because as while when where whether which who whom whose what ' +
    'that this these those there here i me my mine myself you your yours yourself yourselves he him his himself ' +
    'she her hers herself it its itself we us our ours ourselves they them their theirs themselves one ones ' +
    'be am is are was were been being have has had having do does did done doing will would shall should can could ' +
    'may might must ought not no yes of to in on at by for with from into onto upon about above below under over ' +
    'after before between among through during without within along across against around behind beyond near off ' +
    'out up down since until till toward towards via per like unlike all any some each every both either neither ' +
    'few many much more most less least other another such own same very too also just only even still already ' +
    'again ever never always often sometimes now then soon how why oh ah well okay ok mr mrs ms dr st ' +
    "i'm i've i'd i'll you're you've you'd you'll he's he'd he'll she's she'd she'll it's it'll we're we've we'd " +
    "we'll they're they've they'd they'll that's there's here's what's who's let's don't doesn't didn't isn't " +
    "aren't wasn't weren't haven't hasn't hadn't won't wouldn't can't couldn't shouldn't mustn't mightn't needn't " +
    "ain't 's 'd 'll 're 've 'm"
  ).split(/\s+/);
  var FUNCTION_SET = {};
  FUNCTION_WORDS.forEach(function (w) { FUNCTION_SET[w] = true; });

  global.LexLemma = {
    candidates: candidates,
    matches: matches,
    tokenize: tokenize,
    findInText: findInText,
    norm: norm,
    isFunctionWord: function (w) { return !!FUNCTION_SET[norm(w)]; },
    FUNCTION_WORDS: FUNCTION_WORDS
  };
})(typeof window !== 'undefined' ? window : self);
