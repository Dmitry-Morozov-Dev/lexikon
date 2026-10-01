/**
 * SM-2 алгоритм интервального повторения для «Лексикон».
 * Качество ответа (quality):
 *   0 — Снова  (Again)
 *   1 — Трудно (Hard)
 *   2 — Хорошо (Good)
 *   3 — Легко  (Easy)
 *
 * Поля карточки прогресса:
 *   ease       — коэффициент лёгкости (EF), минимум 1.3
 *   interval   — интервал в днях до следующего показа
 *   repetition — число успешных повторений подряд
 *   due        — timestamp (ms), когда карточка снова должна появиться
 *   last       — timestamp последнего ответа
 *   lapses     — сколько раз нажали «Снова»
 *   state      — 'new' | 'learning' | 'review' | 'relearning'
 */

(function (global) {
  'use strict';

  var MIN_EASE = 1.3;
  var DEFAULT_EASE = 2.5;
  /** Короткий интервал для «Снова» — 10 минут */
  var AGAIN_MS = 10 * 60 * 1000;
  /** Трудно: ~1 день или 1.2× предыдущего */
  var HARD_FACTOR = 1.2;
  /** Легко: множитель к вычисленному интервалу */
  var EASY_BONUS = 1.3;

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
      // Снова: сброс повторений, интервал 0, due через 10 минут
      p.repetition = 0;
      p.interval = 0;
      p.lapses = (p.lapses || 0) + 1;
      p.ease = clampEase(p.ease - 0.2);
      p.due = t + AGAIN_MS;
      p.state = p.state === 'new' ? 'learning' : 'relearning';
      return p;
    }

    if (quality === 1) {
      // Трудно: короткий интервал, небольшое снижение EF
      p.ease = clampEase(p.ease - 0.15);
      if (p.repetition === 0) {
        p.interval = 1;
        p.repetition = 1;
      } else {
        p.interval = Math.max(1, Math.round(p.interval * HARD_FACTOR));
        p.repetition += 1;
      }
      p.due = t + daysToMs(p.interval);
      p.state = 'review';
      return p;
    }

    if (quality === 2) {
      // Хорошо: стандартный рост SM-2
      // EF' = EF + (0.1 - (5-q)*(0.08+(5-q)*0.02)), q≈4 в классике;
      // у нас Good ≈ q=4 → +0.0 к EF (оставляем), Easy ≈ q=5 → +0.1
      p.ease = clampEase(p.ease);
      if (p.repetition === 0) {
        p.interval = 1;
      } else if (p.repetition === 1) {
        p.interval = 3;
      } else {
        p.interval = Math.max(1, Math.round(p.interval * p.ease));
      }
      p.repetition += 1;
      p.due = t + daysToMs(p.interval);
      p.state = 'review';
      return p;
    }

    // quality === 3 — Легко: агрессивный рост + бонус
    p.ease = clampEase(p.ease + 0.15);
    if (p.repetition === 0) {
      p.interval = 3;
    } else if (p.repetition === 1) {
      p.interval = 7;
    } else {
      p.interval = Math.max(1, Math.round(p.interval * p.ease * EASY_BONUS));
    }
    p.repetition += 1;
    p.due = t + daysToMs(p.interval);
    p.state = 'review';
    return p;
  }

  /**
   * Карточка просрочена или ещё не изучалась (due=0 и state new → не «due review»).
   */
  function isDue(progress, at) {
    at = at || now();
    if (!progress) return false;
    if (progress.state === 'new') return false;
    return (progress.due || 0) <= at;
  }

  function isNew(progress) {
    return !progress || progress.state === 'new' || ((progress.due === 0) && (progress.repetition === 0) && progress.state !== 'learning' && progress.state !== 'relearning' && progress.state !== 'review');
  }

  /**
   * Сколько карточек due к завтрашнему утру (через ~24ч от сейчас, срез «завтра»).
   */
  function dueBy(progressList, untilTs) {
    return progressList.filter(function (p) {
      return p.state !== 'new' && p.due > 0 && p.due <= untilTs;
    });
  }

  global.LexSRS = {
    createProgress: createProgress,
    review: review,
    isDue: isDue,
    isNew: isNew,
    dueBy: dueBy,
    MIN_EASE: MIN_EASE,
    DEFAULT_EASE: DEFAULT_EASE,
    AGAIN_MS: AGAIN_MS
  };
})(typeof window !== 'undefined' ? window : self);
