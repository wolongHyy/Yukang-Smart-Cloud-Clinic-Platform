(() => {
  'use strict';

  const root = document.documentElement;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
  const hero = document.querySelector('[data-hero]');
  const workflowPanel = document.querySelector('.workflow-panel');

  if (!document.body.classList.contains('showcase-page')) return;

  let scrollFrame = 0;
  const paintScrollProgress = () => {
    scrollFrame = 0;
    const scrollable = Math.max(document.documentElement.scrollHeight - window.innerHeight, 1);
    const progress = Math.min(1, Math.max(0, window.scrollY / scrollable));
    root.style.setProperty('--page-progress', progress.toFixed(4));
  };
  const requestScrollProgress = () => {
    if (!scrollFrame) scrollFrame = requestAnimationFrame(paintScrollProgress);
  };

  window.addEventListener('scroll', requestScrollProgress, { passive: true });
  window.addEventListener('resize', requestScrollProgress, { passive: true });
  window.addEventListener('load', requestScrollProgress, { once: true });
  requestScrollProgress();

  let pointerFrame = 0;
  let pointerX = 0;
  let pointerY = 0;
  const paintHeroParallax = () => {
    pointerFrame = 0;
    if (!hero || reduceMotion.matches || !finePointer.matches) return;
    hero.style.setProperty('--hero-bg-x', `${(pointerX * -13).toFixed(2)}px`);
    hero.style.setProperty('--hero-bg-y', `${(pointerY * -8).toFixed(2)}px`);
    hero.style.setProperty('--hero-copy-x', `${(pointerX * 5).toFixed(2)}px`);
    hero.style.setProperty('--hero-copy-y', `${(pointerY * 3).toFixed(2)}px`);
    hero.style.setProperty('--hero-glow-x', `${(78 + pointerX * 18).toFixed(1)}%`);
    hero.style.setProperty('--hero-glow-y', `${(24 + pointerY * 13).toFixed(1)}%`);
  };

  const resetHeroParallax = () => {
    if (!hero) return;
    if (pointerFrame) cancelAnimationFrame(pointerFrame);
    pointerFrame = 0;
    hero.style.setProperty('--hero-bg-x', '0px');
    hero.style.setProperty('--hero-bg-y', '0px');
    hero.style.setProperty('--hero-copy-x', '0px');
    hero.style.setProperty('--hero-copy-y', '0px');
    hero.style.setProperty('--hero-glow-x', '78%');
    hero.style.setProperty('--hero-glow-y', '24%');
  };

  if (hero) {
    hero.addEventListener('pointermove', (event) => {
      if (reduceMotion.matches || !finePointer.matches) return;
      const rect = hero.getBoundingClientRect();
      pointerX = Math.min(1, Math.max(-1, ((event.clientX - rect.left) / rect.width - .5) * 2));
      pointerY = Math.min(1, Math.max(-1, ((event.clientY - rect.top) / rect.height - .5) * 2));
      if (!pointerFrame) pointerFrame = requestAnimationFrame(paintHeroParallax);
    }, { passive: true });
    hero.addEventListener('pointerleave', resetHeroParallax, { passive: true });
  }

  const tiltTargets = [
    ...document.querySelectorAll('.workspace-card, .capability-card, .security-note, .deployment-card')
  ];
  const tiltCleanups = [];

  const prepareTilt = (element) => {
    let bounds = null;
    let frame = 0;
    let nextX = 0;
    let nextY = 0;

    const applyTilt = () => {
      frame = 0;
      if (!finePointer.matches || reduceMotion.matches) return;
      element.style.setProperty('--tilt-rx', `${(-nextY * 3.2).toFixed(2)}deg`);
      element.style.setProperty('--tilt-ry', `${(nextX * 4).toFixed(2)}deg`);
      element.style.setProperty('--shine-x', `${((nextX + 1) * 50).toFixed(1)}%`);
      element.style.setProperty('--shine-y', `${((nextY + 1) * 50).toFixed(1)}%`);
    };

    const onEnter = () => {
      bounds = element.getBoundingClientRect();
    };

    const onMove = (event) => {
      if (!finePointer.matches || reduceMotion.matches) return;
      if (!bounds) bounds = element.getBoundingClientRect();
      nextX = Math.min(1, Math.max(-1, ((event.clientX - bounds.left) / Math.max(bounds.width, 1) - .5) * 2));
      nextY = Math.min(1, Math.max(-1, ((event.clientY - bounds.top) / Math.max(bounds.height, 1) - .5) * 2));
      if (!frame) frame = requestAnimationFrame(applyTilt);
    };

    const reset = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      bounds = null;
      element.style.removeProperty('--tilt-rx');
      element.style.removeProperty('--tilt-ry');
      element.style.removeProperty('--shine-x');
      element.style.removeProperty('--shine-y');
    };

    element.addEventListener('pointerenter', onEnter, { passive: true });
    element.addEventListener('pointermove', onMove, { passive: true });
    element.addEventListener('pointerleave', reset, { passive: true });
    element.addEventListener('pointercancel', reset, { passive: true });
    tiltCleanups.push(reset);
  };

  if (finePointer.matches && !reduceMotion.matches) {
    tiltTargets.forEach(prepareTilt);
  }

  const resetAllTilt = () => tiltCleanups.forEach((reset) => reset());

  if (workflowPanel && 'MutationObserver' in window) {
    let refreshTimer = 0;
    const workflowObserver = new MutationObserver(() => {
      if (reduceMotion.matches) return;
      workflowPanel.classList.remove('is-refreshing');
      void workflowPanel.offsetWidth;
      workflowPanel.classList.add('is-refreshing');
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => workflowPanel.classList.remove('is-refreshing'), 620);
    });
    workflowObserver.observe(workflowPanel, { attributes: true, attributeFilter: ['data-active-step'] });
  }

  const handleMotionPreference = () => {
    resetHeroParallax();
    resetAllTilt();
  };

  if (typeof reduceMotion.addEventListener === 'function') {
    reduceMotion.addEventListener('change', handleMotionPreference);
  } else if (typeof reduceMotion.addListener === 'function') {
    reduceMotion.addListener(handleMotionPreference);
  }
})();