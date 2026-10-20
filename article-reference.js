(async () => {
  function handleImage(image) {
    const remove = () => image.parentElement?.remove();
    image.addEventListener('error', remove, {once: true});
    // A cloned lazy image has not started loading until its card is connected.
    if (image.isConnected && image.complete && !image.naturalWidth) remove();
  }
  document.querySelectorAll('.preview-card__image').forEach(handleImage);

  // Native {{< relref >}} URLs can remain shortcode placeholders in render hooks.
  // Enhance their final URLs from the same build-time metadata used by the hook.
  const source = document.querySelector('script[data-article-index]');
  const candidates = [...document.querySelectorAll(
    '.post-content a[href]:not(.article-reference):not(.link-preview-card):not(.video-embed__link):not(.code-preview-link)'
  )].filter(link => !link.getAttribute('href').startsWith('#') && !link.querySelector('img'));
  if (source && candidates.length) {
    try {
      const response = await fetch(source.dataset.articleIndex);
      if (!response.ok) throw new Error('Article metadata unavailable');
      const index = await response.json();
      for (const link of candidates) {
        const href = link.getAttribute('href');
        if (!href) continue;
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
      }
    } catch {
      // Navigation and server-rendered references still work if metadata cannot load.
    }
  }

  const links = [...document.querySelectorAll('a.article-reference')];
  const template = document.getElementById('preview-card-content');
  if (!links.length || !template) return;
  const preview = document.createElement('div');
  preview.className = 'preview-card article-preview';
  preview.id = 'article-reference-preview';
  preview.role = 'tooltip';
  preview.hidden = true;
  document.body.append(preview);
  let active = null, timer, previousDescription = null;

  function content(link) {
    const fragment = template.content.cloneNode(true);
    const data = {
      title: link.dataset.articleTitle,
      description: link.dataset.articleDescription,
      meta: link.dataset.articleMeta,
      image: link.dataset.articleImage,
    };
    for (const field of fragment.querySelectorAll('[data-preview-field]')) {
      const name = field.dataset.previewField;
      const value = data[name];
      if (name === 'image') {
        if (value) {
          field.src = value;
          handleImage(field);
        } else {
          field.parentElement.remove();
        }
      } else if (value) {
        field.textContent = value;
      } else {
        field.remove();
      }
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
      link.classList.add('preview-card', 'article-reference--card');
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
