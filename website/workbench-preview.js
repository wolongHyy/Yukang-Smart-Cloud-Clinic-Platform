(() => {
  'use strict';

  const previews = [...document.querySelectorAll('[data-workbench-preview]')];
  if (!previews.length) return;

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const setMotionState = (preview, isVisible) => {
    preview.classList.toggle('is-offscreen', !isVisible || reducedMotion.matches);
  };

  if (!('IntersectionObserver' in window)) {
    previews.forEach((preview) => setMotionState(preview, true));
    return;
  }

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => setMotionState(entry.target, entry.isIntersecting));
  }, { rootMargin: '120px 0px', threshold: 0 });

  previews.forEach((preview) => {
    setMotionState(preview, !reducedMotion.matches);
    observer.observe(preview);
  });

  reducedMotion.addEventListener?.('change', () => {
    previews.forEach((preview) => {
      const rect = preview.getBoundingClientRect();
      const isVisible = rect.bottom > -120 && rect.top < window.innerHeight + 120;
      setMotionState(preview, isVisible);
    });
  });
})();
