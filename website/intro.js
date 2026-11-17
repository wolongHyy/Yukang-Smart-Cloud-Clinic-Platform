(() => {
  'use strict';

  const overlay = document.querySelector('[data-cinematic-intro]');
  if (!overlay) return;

  const video = overlay.querySelector('[data-intro-video]');
  const skipButton = overlay.querySelector('[data-intro-skip]');
  const storageKey = 'yukang-intro-seen-v1';
  const forceIntro = new URLSearchParams(window.location.search).get('intro') === '1';
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let alreadySeen = false;
  try {
    alreadySeen = window.sessionStorage.getItem(storageKey) === '1';
  } catch {
    alreadySeen = false;
  }

  if (reducedMotion || (alreadySeen && !forceIntro)) {
    try { window.sessionStorage.setItem(storageKey, '1'); } catch {}
    overlay.hidden = true;
    return;
  }

  const inertTargets = [
    document.querySelector('.site-header'),
    document.querySelector('main'),
    document.querySelector('.site-footer')
  ].filter(Boolean);
  let finished = false;
  let safetyTimer = 0;
  let startTimer = 0;
  let playbackStarted = false;

  const setPageInert = (isInert) => {
    inertTargets.forEach((element) => {
      if (isInert) {
        element.setAttribute('inert', '');
        element.setAttribute('aria-hidden', 'true');
      } else {
        element.removeAttribute('inert');
        element.removeAttribute('aria-hidden');
      }
    });
  };

  const onKeyDown = (event) => {
    if (event.key === 'Escape') finishIntro();
  };

  const finishIntro = (immediate = false) => {
    if (finished) return;
    finished = true;
    window.clearTimeout(safetyTimer);
    window.clearTimeout(startTimer);
    document.removeEventListener('keydown', onKeyDown);
    overlay.classList.add('is-leaving');
    document.body.classList.remove('intro-playing');
    setPageInert(false);

    const delay = immediate || reducedMotion ? 0 : 640;
    window.setTimeout(() => {
      overlay.hidden = true;
      const main = document.querySelector('main');
      if (main) {
        main.setAttribute('tabindex', '-1');
        main.focus({ preventScroll: true });
      }
    }, delay);
  };

  try { window.sessionStorage.setItem(storageKey, '1'); } catch {}

  overlay.hidden = false;
  overlay.setAttribute('aria-hidden', 'false');
  document.body.classList.add('intro-playing');
  setPageInert(true);

  if (video) {
    const usePortrait = window.innerHeight > window.innerWidth * 1.05;
    video.src = usePortrait ? video.dataset.introPortrait : video.dataset.introWide;
    video.muted = true;
    video.playsInline = true;
    const markPlaybackStarted = () => {
      playbackStarted = true;
      window.clearTimeout(startTimer);
    };
    ['loadeddata', 'canplay', 'playing'].forEach((eventName) => {
      video.addEventListener(eventName, markPlaybackStarted, { once: true });
    });
    video.addEventListener('ended', () => finishIntro(), { once: true });
    video.addEventListener('error', () => finishIntro(), { once: true });

    const playAttempt = video.play();
    if (playAttempt && typeof playAttempt.catch === 'function') {
      playAttempt.catch(() => {
        startTimer = window.setTimeout(() => {
          if (!playbackStarted && video.readyState < 2) finishIntro();
        }, 3000);
      });
    }
  }

  skipButton?.addEventListener('click', () => finishIntro(), { once: true });
  document.addEventListener('keydown', onKeyDown);
  window.setTimeout(() => skipButton?.focus({ preventScroll: true }), 80);
  safetyTimer = window.setTimeout(() => finishIntro(), 6500);
})();
