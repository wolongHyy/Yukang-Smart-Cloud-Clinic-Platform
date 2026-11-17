(() => {
  'use strict';
  const header = document.querySelector('[data-header]');
  const nav = document.querySelector('[data-nav]');
  const menuToggle = document.querySelector('[data-menu-toggle]');
  const navLinks = [...document.querySelectorAll('.site-nav a[href^="#"]')];
  const year = document.querySelector('[data-year]');
  const revealItems = [...document.querySelectorAll('.reveal')];
  if (year) year.textContent = String(new Date().getFullYear());
  const menuLabel = menuToggle?.querySelector('.sr-only');
  const setMenuState = (open) => {
    if (!nav || !menuToggle) return;
    nav.classList.toggle('open', open);
    menuToggle.setAttribute('aria-expanded', String(open));
    document.body.classList.toggle('menu-open', open);
    if (menuLabel) menuLabel.textContent = open ? '关闭导航' : '打开导航';
  };
  const closeMenu = () => setMenuState(false);
  menuToggle?.addEventListener('click', () => {
    setMenuState(menuToggle.getAttribute('aria-expanded') !== 'true');
  });
  navLinks.forEach((link) => link.addEventListener('click', closeMenu));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && menuToggle?.getAttribute('aria-expanded') === 'true') {
      closeMenu();
      menuToggle.focus();
    }
  });
  window.addEventListener('resize', () => { if (window.innerWidth > 820) closeMenu(); }, { passive: true });
  const setHeaderState = () => { if (header) header.classList.toggle('scrolled', window.scrollY > 30); };
  window.addEventListener('scroll', setHeaderState, { passive: true });
  setHeaderState();
  if ('IntersectionObserver' in window) {
    const revealObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          revealObserver.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px' });
    revealItems.forEach((item) => revealObserver.observe(item));
    const sections = [...document.querySelectorAll('main section[id]')];
    const sectionObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        navLinks.forEach((link) => link.classList.toggle('active', link.getAttribute('href') === `#${entry.target.id}`));
      });
    }, { rootMargin: '-35% 0px -55%', threshold: 0 });
    sections.forEach((section) => sectionObserver.observe(section));
  } else {
    revealItems.forEach((item) => item.classList.add('visible'));
  }
  const panelData = [
    {
      title: '完整记录一次诊疗',
      description: '患者档案、主诉、现病史、既往史、过敏史、体格检查与诊断在同一条业务链中流转，不重复录入。',
      note: '状态：接诊中',
      image: 'assets/screens/02-emr.jpg',
      alt: '愈康接诊建档真实界面：患者列表、病历、症状点选与处方操作',
      galleryTitle: '接诊建档 · 电子病历',
      galleryCaption: '真实界面截屏 · 患者信息、病史、处方与接诊操作 · 演示诊所数据'
    },
    {
      title: '先检查，再写入处方',
      description: 'AI 结合过敏史、库存、配伍禁忌与药物相互作用给出提示。所有建议都由医生确认，系统不会自动生成正式处方。',
      note: '状态：待医生确认',
      image: 'assets/screens/03-ai-assist.jpg',
      alt: '愈康 AI 辅助诊疗真实界面：检查清单、药典证据、风险审查与人工确认',
      galleryTitle: 'AI 辅助诊疗 · 证据与风险',
      galleryCaption: '界面截屏 + 演示响应 · 当前演示环境未配置真实模型 Key · 演示诊所数据'
    },
    {
      title: '发药、出库、库存同步',
      description: '处方推送药房后形成待发药记录。确认发药时自动扣减库存并生成出库记录，重复发药会被系统拦截。',
      note: '状态：已发药',
      image: 'assets/screens/04-pharmacy.jpg',
      alt: '愈康药房真实界面：待发药处方、药品批次、库存数量与发药操作',
      galleryTitle: '药房与库存 · 发药出库',
      galleryCaption: '真实界面截屏 · 待发药列表、批次库存与出库记录 · 演示诊所数据'
    },
    {
      title: '实收确认后，才计入营收',
      description: '收费员核对应收、实收、优惠与找零，选择支付方式后完成入账。打印与补打都保留业务记录，不会重复计算收入。',
      note: '状态：已收费',
      image: 'assets/screens/06-billing.jpg',
      alt: '愈康门诊收费真实界面：待收费项目、实收金额、支付方式和收费记录',
      galleryTitle: '门诊收费 · 实收入账',
      galleryCaption: '真实界面截屏 · 应收实收、支付方式与收费记录 · 演示诊所数据'
    },
    {
      title: '把一天的经营看清楚',
      description: '门诊量、收费明细、日报、项目统计、库存和毛利分别呈现。数据口径清楚，才能支持下一步经营判断。',
      note: '状态：日报已生成',
      image: 'assets/screens/07-analytics.jpg',
      alt: '愈康经营统计真实界面：门诊量、营收、项目构成、库存和经营趋势',
      galleryTitle: '经营统计 · 门店复盘',
      galleryCaption: '真实界面截屏 · 门诊量、营收、项目结构与经营趋势 · 演示诊所数据'
    }
  ];
  const steps = [...document.querySelectorAll('[data-step]')];
  const panelTitle = document.querySelector('[data-panel-title]');
  const panelDescription = document.querySelector('[data-panel-desc]');
  const panelNote = document.querySelector('[data-panel-note]');
  const panelImage = document.querySelector('[data-panel-image]');
  const panelIndex = document.querySelector('[data-panel-index]');
  const panel = document.querySelector('.workflow-panel');
  const dots = [...document.querySelectorAll('.panel-dots i')];
  const activateStep = (index, focus = false) => {
    const data = panelData[index];
    if (!data || !panelTitle) return;
    steps.forEach((step, stepIndex) => {
      const active = stepIndex === index;
      step.classList.toggle('active', active);
      step.setAttribute('aria-selected', String(active));
      step.tabIndex = active ? 0 : -1;
      if (active && focus) step.focus();
    });
    panelTitle.textContent = data.title;
    if (panelDescription) panelDescription.textContent = data.description;
    if (panelNote) panelNote.textContent = data.note;
    if (panelIndex) panelIndex.textContent = String(index + 1).padStart(2, '0');
    if (panelImage) {
      panelImage.src = data.image;
      panelImage.alt = data.alt;
      panelImage.dataset.gallerySrc = data.image;
      panelImage.dataset.galleryTitle = data.galleryTitle;
      panelImage.dataset.galleryCaption = data.galleryCaption;
      const trigger = panelImage.closest('.gallery-trigger');
      if (trigger) {
        trigger.dataset.gallerySrc = data.image;
        trigger.dataset.galleryTitle = data.galleryTitle;
        trigger.dataset.galleryCaption = data.galleryCaption;
        trigger.dataset.galleryAlt = data.alt;
      }
    }
    if (panel) panel.setAttribute('data-active-step', String(index));
    dots.forEach((dot, dotIndex) => dot.classList.toggle('active', dotIndex === index));
  };
  steps.forEach((step, index) => {
    step.addEventListener('click', () => activateStep(index));
    step.addEventListener('keydown', (event) => {
      if (!['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      let next = index;
      if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % steps.length;
      if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index - 1 + steps.length) % steps.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = steps.length - 1;
      activateStep(next, true);
    });
  });
  document.querySelectorAll('[data-scroll-to]').forEach((button) => {
    button.addEventListener('click', () => {
      const target = document.getElementById(button.dataset.scrollTo);
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
})();
