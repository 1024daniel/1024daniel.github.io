(async () => {
  // Native {{< relref >}} URLs can remain shortcode placeholders in render hooks.
  // Enhance their final URLs from the same build-time metadata used by the hook.
  const source = document.querySelector('script[data-article-index]');
  if (source && document.querySelector('.post-content a[href]')) {
    try {
      const response = await fetch(source.dataset.articleIndex);
      if (!response.ok) throw new Error('Article metadata unavailable');
      const index = await response.json();
      for (const link of document.querySelectorAll('.post-content a[href]:not(.article-reference)')) {
        const href = link.getAttribute('href');
        if (!href || href.startsWith('#') || link.querySelector('img')
          || link.classList.contains('link-preview-card') || link.classList.contains('video-embed__link')) continue;
        const url = new URL(href, location.href);
        if (!['http:', 'https:'].includes(url.protocol)
          || (url.host !== location.host && url.host !== index.host)) continue;
        let path;
        try { path = decodeURIComponent(url.pathname).replace(/\/$/, ''); } catch { continue; }
        const data = index.pages[path];
        if (!data) continue;
        link.classList.add('article-reference');
        link.dataset.articleTitle = data.title;
        link.dataset.articleDescription = data.description;
        link.dataset.articleMeta = data.meta;
        if (data.image) link.dataset.articleImage = data.image;
        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        icon.setAttribute('class', 'article-reference__icon');
        icon.setAttribute('viewBox', '0 0 20 20');
        icon.setAttribute('width', '16');
        icon.setAttribute('height', '16');
        icon.setAttribute('aria-hidden', 'true');
        icon.innerHTML = '<path d="M4 2.5h8l4 4v11H4z M12 2.5v4h4 M7 10h6 M7 13h5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>';
        link.prepend(icon);
      }
    } catch {
      // Navigation and server-rendered references still work if metadata cannot load.
    }
  }

  const links = [...document.querySelectorAll('a.article-reference')];
  if (!links.length) return;
  const preview = document.createElement('div');
  preview.className = 'article-preview';
  preview.id = 'article-reference-preview';
  preview.role = 'tooltip';
  preview.hidden = true;
  document.body.append(preview);
  let active = null, timer, previousDescription = null;

  function content(link) {
    const fragment = document.createDocumentFragment();
    const body = document.createElement('span');
    body.className = 'article-preview__content';
    for (const [key, name] of [['articleTitle', 'title'], ['articleDescription', 'description'], ['articleMeta', 'meta']]) {
      if (!link.dataset[key]) continue;
      const item = document.createElement('span');
      item.className = 'article-preview__' + name;
      item.textContent = link.dataset[key];
      body.append(item);
    }
    fragment.append(body);
    if (link.dataset.articleImage) {
      const img = document.createElement('img');
      img.className = 'article-preview__image';
      img.src = link.dataset.articleImage;
      img.alt = '';
      img.loading = 'lazy';
      img.addEventListener('error', () => img.remove(), {once: true});
      fragment.append(img);
    }
    return fragment;
  }

  function position() {
    if (!active || preview.hidden) return;
    const rect = active.getBoundingClientRect();
    const bounds = preview.getBoundingClientRect();
    const left = Math.max(12, Math.min(rect.left, innerWidth - bounds.width - 12));
    const below = rect.bottom + 8;
    const top = below + bounds.height <= innerHeight - 12
      ? below : Math.max(12, rect.top - bounds.height - 8);
    preview.style.left = left + 'px';
    preview.style.top = top + 'px';
  }
  function hide() {
    clearTimeout(timer);
    if (active) {
      if (previousDescription === null) active.removeAttribute('aria-describedby');
      else active.setAttribute('aria-describedby', previousDescription);
    }
    preview.hidden = true;
    active = null;
  }
  function show(link) {
    clearTimeout(timer);
    if (active === link) return;
    hide();
    active = link;
    previousDescription = link.getAttribute('aria-describedby');
    preview.replaceChildren(content(link));
    link.setAttribute('aria-describedby', [previousDescription, preview.id].filter(Boolean).join(' '));
    preview.hidden = false;
    position();
  }
  function scheduleHide() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (active === document.activeElement || preview.matches(':hover')) return;
      hide();
    }, 160);
  }
  for (const link of links) {
    const parent = link.parentElement;
    // A standalone reference becomes a full card; prose references stay inline.
    if (parent.tagName === 'P' && parent.children.length === 1
      && parent.textContent.trim() === link.textContent.trim()) {
      link.classList.add('article-reference--card');
      link.replaceChildren(content(link));
      continue;
    }
    link.addEventListener('pointerenter', event => {
      if (event.pointerType === 'mouse') show(link);
    });
    link.addEventListener('pointerleave', scheduleHide);
    link.addEventListener('focus', () => show(link));
    link.addEventListener('blur', scheduleHide);
    link.addEventListener('click', hide);
  }
  preview.addEventListener('pointerenter', () => clearTimeout(timer));
  preview.addEventListener('pointerleave', scheduleHide);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') hide();
  });
  addEventListener('scroll', () => {
    if (active === document.activeElement) position(); else hide();
  }, {passive: true});
  addEventListener('resize', hide);
  new ResizeObserver(position).observe(preview);
})();
