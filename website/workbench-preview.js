(() => {
  'use strict';

  const previews = [...document.querySelectorAll('[data-workbench-preview]')];
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
  const tiltCleanups = [];

  const setMotionState = (preview, isVisible) => {
    preview.classList.toggle('is-offscreen', !isVisible || reducedMotion.matches);
  };

  const motionAllowed = () => finePointer.matches && !reducedMotion.matches;

  previews.forEach((preview) => {
    const card = preview.querySelector('.workspace-card');
    if (!card) return;

    let bounds = null;
    let frame = 0;
    let nextX = 0;
    let nextY = 0;

    const paintTilt = () => {
      frame = 0;
      if (!motionAllowed()) return;
      card.style.setProperty('--tilt-rx', `${(-nextY * 3.2).toFixed(2)}deg`);
      card.style.setProperty('--tilt-ry', `${(nextX * 4).toFixed(2)}deg`);
      card.style.setProperty('--shine-x', `${((nextX + 1) * 50).toFixed(1)}%`);
      card.style.setProperty('--shine-y', `${((nextY + 1) * 50).toFixed(1)}%`);
    };

    const resetTilt = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      bounds = null;
      card.style.removeProperty('--tilt-rx');
      card.style.removeProperty('--tilt-ry');
      card.style.removeProperty('--shine-x');
      card.style.removeProperty('--shine-y');
    };

    const onEnter = () => {
      bounds = card.getBoundingClientRect();
    };

    const onMove = (event) => {
      if (!motionAllowed()) return;
      if (!bounds) bounds = card.getBoundingClientRect();
      nextX = Math.min(1, Math.max(-1, ((event.clientX - bounds.left) / Math.max(bounds.width, 1) - .5) * 2));
      nextY = Math.min(1, Math.max(-1, ((event.clientY - bounds.top) / Math.max(bounds.height, 1) - .5) * 2));
      if (!frame) frame = requestAnimationFrame(paintTilt);
    };

    card.addEventListener('pointerenter', onEnter, { passive: true });
    card.addEventListener('pointermove', onMove, { passive: true });
    card.addEventListener('pointerleave', resetTilt, { passive: true });
    card.addEventListener('pointercancel', resetTilt, { passive: true });
    tiltCleanups.push(resetTilt);
  });

  if (!('IntersectionObserver' in window)) {
    previews.forEach((preview) => setMotionState(preview, true));
  } else {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => setMotionState(entry.target, entry.isIntersecting));
    }, { rootMargin: '120px 0px', threshold: 0 });
    previews.forEach((preview) => {
      setMotionState(preview, !reducedMotion.matches);
      observer.observe(preview);
    });
  }

  const resetAll = () => {
    tiltCleanups.forEach((reset) => reset());
    previews.forEach((preview) => {
      const rect = preview.getBoundingClientRect();
      setMotionState(preview, rect.bottom > -120 && rect.top < window.innerHeight + 120);
    });
  };

  reducedMotion.addEventListener?.('change', resetAll);
  finePointer.addEventListener?.('change', resetAll);
  window.addEventListener('resize', () => tiltCleanups.forEach((reset) => reset()), { passive: true });
})();
