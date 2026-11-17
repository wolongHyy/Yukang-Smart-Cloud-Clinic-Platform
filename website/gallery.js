(() => {
  'use strict';

  const imageSelector = [
    'img[data-gallery-src]',
    '.product-frame > img',
    '.process-shot > img',
    '.screen-crop > img',
    '.deployment-shot > img'
  ].join(',');

  const images = [...document.querySelectorAll(imageSelector)];

  const captionFrom = (img) => {
    const figure = img.closest('figure');
    const caption = figure?.querySelector('figcaption')?.textContent?.replace(/\s+/g, ' ').trim();
    const articleTitle = img.closest('article')?.querySelector('h3')?.textContent?.trim();
    return caption || articleTitle || img.alt || '愈康软件真实界面';
  };

  images.forEach((img, index) => {
    if (img.closest('.gallery-trigger')) return;

    const figure = img.closest('figure');
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'gallery-trigger';
    trigger.dataset.gallerySrc = img.dataset.gallerySrc || img.getAttribute('src');
    trigger.dataset.galleryTitle = img.dataset.galleryTitle || captionFrom(img);
    trigger.dataset.galleryCaption = img.dataset.galleryCaption || '软件真实界面截屏 · YuKangClinic v5.1.0 · 演示数据';
    trigger.dataset.galleryAlt = img.dataset.galleryAlt || img.alt || trigger.dataset.galleryTitle;
    trigger.setAttribute('aria-label', `放大查看：${trigger.dataset.galleryTitle}`);
    trigger.setAttribute('aria-haspopup', 'dialog');

    img.replaceWith(trigger);
    trigger.appendChild(img);

    if (figure) {
      figure.classList.add('gallery-ready');
      trigger.dataset.galleryIndex = String(index + 1);
    }
  });

  const triggers = [...document.querySelectorAll('.gallery-trigger')];
  if (!triggers.length) return;

  const dialog = document.createElement('dialog');
  dialog.className = 'screen-lightbox';
  dialog.setAttribute('aria-labelledby', 'gallery-title');
  dialog.innerHTML = `
    <div class="gallery-shell">
      <header class="gallery-head">
        <div class="gallery-heading">
          <span class="gallery-kicker">REAL PRODUCT SCREEN</span>
          <h2 class="gallery-title" id="gallery-title"></h2>
          <p class="gallery-caption"></p>
        </div>
        <button class="gallery-close" type="button" aria-label="关闭大图">
          <span>关闭</span><b aria-hidden="true">×</b>
        </button>
      </header>
      <div class="gallery-tools">
        <span class="gallery-data-note">界面截屏 · 演示数据</span>
        <button class="gallery-fit" type="button" aria-pressed="false">放大细节</button>
      </div>
      <div class="gallery-stage"></div>
      <footer class="gallery-foot">
        <span>点击遮罩、关闭按钮或按 Esc 退出</span>
        <span class="gallery-position"></span>
      </footer>
    </div>`;
  document.body.append(dialog);

  const closeButton = dialog.querySelector('.gallery-close');
  const fitButton = dialog.querySelector('.gallery-fit');
  const stage = dialog.querySelector('.gallery-stage');
  const image = document.createElement('img');
  image.className = 'gallery-image';
  image.alt = '';
  stage.append(image);
  const title = dialog.querySelector('.gallery-title');
  const caption = dialog.querySelector('.gallery-caption');
  const position = dialog.querySelector('.gallery-position');
  let lastTrigger = null;

  const setMode = (actualSize) => {
    stage.classList.toggle('is-actual', actualSize);
    fitButton.setAttribute('aria-pressed', String(actualSize));
    fitButton.textContent = actualSize ? '适应屏幕' : '放大细节';
    stage.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  };

  const openGallery = (trigger) => {
    lastTrigger = trigger;
    image.src = trigger.dataset.gallerySrc;
    image.alt = trigger.dataset.galleryAlt;
    title.textContent = trigger.dataset.galleryTitle;
    caption.textContent = trigger.dataset.galleryCaption;
    position.textContent = `第 ${trigger.dataset.galleryIndex || '1'} 张 / 共 ${triggers.length} 张`;
    setMode(false);
    document.body.classList.add('gallery-open');
    dialog.showModal();
    requestAnimationFrame(() => closeButton.focus());
  };

  triggers.forEach((trigger) => {
    trigger.addEventListener('click', () => openGallery(trigger));
  });

  closeButton.addEventListener('click', () => dialog.close());

  fitButton.addEventListener('click', () => {
    setMode(!stage.classList.contains('is-actual'));
  });

  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });

  dialog.addEventListener('close', () => {
    document.body.classList.remove('gallery-open');
    image.removeAttribute('src');
    lastTrigger?.focus({ preventScroll: true });
  });
})();
