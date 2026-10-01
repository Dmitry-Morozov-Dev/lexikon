/**
 * Гибридная SRS «Лексикон»: learning steps + SM-2 review + known.
 * Качество (quality):
 *   0 — Снова  (Again)
 *   1 — Трудно (Hard)
 *   2 — Хорошо (Good)
 *   3 — Легко  (Easy)
 *
 * Состояния: new | learning | relearning | review | known
 * isKnown — только state === 'known' (legacy review НЕ считается known).
 *
 * Поля прогресса:
 *   ease, interval, repetition, due, last, lapses, state, learnStep, created
 */
(function (global) {
  'use strict';

  var MIN_EASE = 1.3;
  var DEFAULT_EASE = 2.5;
  var HARD_FACTOR = 1.2;
  var KNOWN_MS = Math.round(100 * 365.25 * 24 * 60 * 60 * 1000);

  /** Шаги обучения (мс): 2м, 10м, 30м, 60м, 1д */
  var LEARN_STEPS = [
    2 * 60 * 1000,
    10 * 60 * 1000,
    30 * 60 * 1000,
    60 * 60 * 1000,
    24 * 60 * 60 * 1000
  ];

  function now() {
    return Date.now();
  }

  function daysToMs(days) {
    return Math.round(days * 24 * 60 * 60 * 1000);
  }

  function clampEase(ef) {
    return Math.max(MIN_EASE, Math.round(ef * 100) / 100);
  }

  function createProgress(cardId) {
    return {
      id: cardId,
      ease: DEFAULT_EASE,
      interval: 0,
      repetition: 0,
      due: 0,
      last: 0,
      lapses: 0,
      learnStep: 0,
      state: 'new',
      created: now()
    };
  }

  /** Выучено навсегда — только explicit known. */
  function isKnown(progress) {
    return !!(progress && progress.state === 'known');
  }

  function isUnknown(progress) {
    return !isKnown(progress);
  }

  function isNew(progress) {
    return !progress || progress.state === 'new';
  }

  function isLearning(progress) {
    if (!progress) return false;
    return progress.state === 'learning' || progress.state === 'relearning';
  }

  /**
   * Просрочена / пора показать: не known, не new, due <= at.
   */
  function isDue(progress, at) {
    at = at || now();
    if (!progress) return false;
    if (isKnown(progress)) return false;
    if (progress.state === 'new') return false;
    return (progress.due || 0) <= at;
  }

  function stepMs(idx) {
    var i = Math.max(0, Math.min(LEARN_STEPS.length - 1, idx | 0));
    return LEARN_STEPS[i];
  }

  function markKnown(p, t) {
    p.state = 'known';
    p.due = t + KNOWN_MS;
    p.interval = Math.max(p.interval || 0, 1);
    p.learnStep = 0;
    return p;
  }

  function graduateToReview(p, t) {
    p.state = 'review';
    p.learnStep = 0;
    p.interval = 1;
    p.repetition = Math.max(1, p.repetition || 0);
    p.due = t + daysToMs(1);
    return p;
  }

  /**
   * Применить ответ. Возвращает новый объект прогресса.
   * Доп. поле _firstTimeKnown (не для IDB): true, если переход new/learning → known.
   */
  function review(progress, quality) {
    var p = Object.assign({}, progress);
    if (typeof p.learnStep !== 'number') p.learnStep = 0;
    var t = now();
    var prevState = p.state || 'new';
    p.last = t;
    p._firstTimeKnown = false;

    if (quality === 0) {
      // Again: learning/relearning, шаг 0, due +2 мин
      p.repetition = 0;
      p.interval = 0;
      p.lapses = (p.lapses || 0) + 1;
      p.ease = clampEase((p.ease || DEFAULT_EASE) - 0.2);
      p.learnStep = 0;
      p.due = t + LEARN_STEPS[0];
      p.state = (prevState === 'review' || prevState === 'relearning') ? 'relearning' : 'learning';
      return p;
    }

    if (quality === 1) {
      // Hard
      p.ease = clampEase((p.ease || DEFAULT_EASE) - 0.15);
      if (prevState === 'review') {
        p.interval = Math.max(1, Math.round((p.interval || 1) * HARD_FACTOR));
        p.due = t + daysToMs(p.interval);
        p.state = 'review';
        return p;
      }
      // new / learning / relearning — остаёмся в learning, повторяем текущий шаг
      if (prevState === 'new') {
        p.state = 'learning';
        p.learnStep = 0;
      } else {
        p.state = prevState === 'relearning' ? 'relearning' : 'learning';
      }
      p.due = t + stepMs(p.learnStep);
      return p;
    }

    if (quality === 2) {
      // Good
      if (prevState === 'new') {
        // Первый правильный с новой → known навсегда
        p.ease = clampEase(p.ease || DEFAULT_EASE);
        p.repetition = (p.repetition || 0) + 1;
        markKnown(p, t);
        p._firstTimeKnown = true;
        return p;
      }

      if (prevState === 'learning' || prevState === 'relearning') {
        var nextStep = (p.learnStep || 0) + 1;
        if (nextStep >= LEARN_STEPS.length) {
          p.ease = clampEase(p.ease || DEFAULT_EASE);
          p.repetition = Math.max(1, (p.repetition || 0) + 1);
          graduateToReview(p, t);
          return p;
        }
        p.learnStep = nextStep;
        p.state = prevState;
        p.due = t + stepMs(nextStep);
        return p;
      }

      // review — классический SM-2 Good
      p.ease = clampEase(p.ease || DEFAULT_EASE);
      if (!p.repetition || p.repetition <= 0) {
        p.interval = 1;
        p.repetition = 1;
      } else if (p.repetition === 1) {
        p.interval = 3;
        p.repetition = 2;
      } else {
        p.interval = Math.max(1, Math.round((p.interval || 1) * p.ease));
        p.repetition += 1;
      }
      p.due = t + daysToMs(p.interval);
      p.state = 'review';
      return p;
    }

    // quality === 3 — Easy → known навсегда
    p.ease = clampEase((p.ease || DEFAULT_EASE) + 0.15);
    p.repetition = (p.repetition || 0) + 1;
    if (prevState === 'new' || prevState === 'learning' || prevState === 'relearning') {
      p._firstTimeKnown = true;
    }
    markKnown(p, t);
    return p;
  }

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
    isLearning: isLearning,
    dueBy: dueBy,
    LEARN_STEPS: LEARN_STEPS,
    MIN_EASE: MIN_EASE,
    DEFAULT_EASE: DEFAULT_EASE,
    KNOWN_MS: KNOWN_MS
  };
})(typeof window !== 'undefined' ? window : self);
