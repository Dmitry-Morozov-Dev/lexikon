/**
 * SM-2 / поток изучения для «Лексикон».
 * Качество ответа (quality):
 *   0 — Снова  (Again)  — не выучено, learning/relearning
 *   1 — Трудно (Hard)   — не выучено навсегда, короткий интервал, learning
 *   2 — Хорошо (Good)   — выучено навсегда (state 'known')
 *   3 — Легко  (Easy)   — выучено навсегда (state 'known')
 *
 * Поля карточки прогресса:
 *   ease       — коэффициент лёгкости (EF), минимум 1.3
 *   interval   — интервал в днях до следующего показа
 *   repetition — число успешных повторений подряд
 *   due        — timestamp (ms), когда карточка снова должна появиться
 *   last       — timestamp последнего ответа
 *   lapses     — сколько раз нажали «Снова»
 *   state      — 'new' | 'learning' | 'relearning' | 'review' | 'known'
 *                ('review' — устаревший выпуск SM-2; для потока = выучено)
 */

(function (global) {
  'use strict';

  var MIN_EASE = 1.3;
  var DEFAULT_EASE = 2.5;
  /** Короткий интервал для «Снова» — 10 минут */
  var AGAIN_MS = 10 * 60 * 1000;
  /** Трудно: ~1 день или 1.2× предыдущего */
  var HARD_FACTOR = 1.2;
  /** Легко: множитель к вычисленному интервалу (legacy поля) */
  var EASY_BONUS = 1.3;
  /** Due далеко в будущем для выученных */
  var KNOWN_MS = Math.round(100 * 365.25 * 24 * 60 * 60 * 1000);

  function now() {
    return Date.now();
  }

  function daysToMs(days) {
    return Math.round(days * 24 * 60 * 60 * 1000);
  }

  function clampEase(ef) {
    return Math.max(MIN_EASE, Math.round(ef * 100) / 100);
  }

  /**
   * Создать начальный прогресс для новой карточки.
   */
  function createProgress(cardId) {
    return {
      id: cardId,
      ease: DEFAULT_EASE,
      interval: 0,
      repetition: 0,
      due: 0,
      last: 0,
      lapses: 0,
      state: 'new',
      created: now()
    };
  }

  /**
   * Выучено навсегда: state 'known' или legacy 'review' (выпуск старого SM-2).
   */
  function isKnown(progress) {
    if (!progress) return false;
    return progress.state === 'known' || progress.state === 'review';
  }

  /**
   * Ещё в потоке изучения (не выучено).
   */
  function isUnknown(progress) {
    return !isKnown(progress);
  }

  /**
   * Применить ответ пользователя к прогрессу.
   * @param {object} progress — текущий прогресс (мутируется копия)
   * @param {number} quality — 0..3
   * @returns {object} новый объект прогресса
   */
  function review(progress, quality) {
    var p = Object.assign({}, progress);
    var t = now();
    p.last = t;

    if (quality === 0) {
      // Снова: сброс повторений, интервал 0, due через 10 минут; остаётся в потоке
      p.repetition = 0;
      p.interval = 0;
      p.lapses = (p.lapses || 0) + 1;
      p.ease = clampEase(p.ease - 0.2);
      p.due = t + AGAIN_MS;
      p.state = p.state === 'new' ? 'learning' : 'relearning';
      return p;
    }

    if (quality === 1) {
      // Трудно: не выучено навсегда; короткий интервал, learning
      p.ease = clampEase(p.ease - 0.15);
      if (p.repetition === 0) {
        p.interval = 1;
        p.repetition = 1;
      } else {
        p.interval = Math.max(1, Math.round(p.interval * HARD_FACTOR));
        p.repetition += 1;
      }
      p.due = t + daysToMs(p.interval);
      p.state = 'learning';
      return p;
    }

    if (quality === 2) {
      // Хорошо: выучено навсегда
      p.ease = clampEase(p.ease);
      if (p.repetition === 0) {
        p.interval = 1;
      } else if (p.repetition === 1) {
        p.interval = 3;
      } else {
        p.interval = Math.max(1, Math.round(p.interval * p.ease));
      }
      p.repetition += 1;
      p.due = t + KNOWN_MS;
      p.state = 'known';
      return p;
    }

    // quality === 3 — Легко: выучено навсегда, выше EF
    p.ease = clampEase(p.ease + 0.15);
    if (p.repetition === 0) {
      p.interval = 3;
    } else if (p.repetition === 1) {
      p.interval = 7;
    } else {
      p.interval = Math.max(1, Math.round(p.interval * p.ease * EASY_BONUS));
    }
    p.repetition += 1;
    p.due = t + KNOWN_MS;
    p.state = 'known';
    return p;
  }

  /**
   * Карточка просрочена (не new, не known/review).
   */
  function isDue(progress, at) {
    at = at || now();
    if (!progress) return false;
    if (isKnown(progress)) return false;
    if (progress.state === 'new') return false;
    return (progress.due || 0) <= at;
  }

  function isNew(progress) {
    return !progress || progress.state === 'new' || ((progress.due === 0) && (progress.repetition === 0) && progress.state !== 'learning' && progress.state !== 'relearning' && progress.state !== 'review' && progress.state !== 'known');
  }

  /**
   * Сколько карточек due к завтрашнему утру (через ~24ч от сейчас, срез «завтра»).
   */
  function dueBy(progressList, untilTs) {
    return progressList.filter(function (p) {
      return !isKnown(p) && p.state !== 'new' && p.due > 0 && p.due <= untilTs;
    });
  }

  global.LexSRS = {
    createProgress: createProgress,
    review: review,
    isDue: isDue,
    isNew: isNew,
    isKnown: isKnown,
    isUnknown: isUnknown,
    dueBy: dueBy,
    MIN_EASE: MIN_EASE,
    DEFAULT_EASE: DEFAULT_EASE,
    AGAIN_MS: AGAIN_MS,
    KNOWN_MS: KNOWN_MS
  };
})(typeof window !== 'undefined' ? window : self);
