(() => {
  const links = document.querySelectorAll('a[data-code-preview]');
  if (!links.length) return;

  const panel = document.createElement('section');
  panel.id = 'code-preview-panel';
  panel.className = 'code-preview';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-labelledby', 'code-preview-filename');
  panel.innerHTML = `
    <div class="code-preview__titlebar">
      <span class="code-preview__heading">代码预览</span>
      <div class="code-preview__actions">
        <a class="code-preview__source" target="_blank" rel="noopener noreferrer">打开源文件 ↗</a>
        <button class="code-preview__close" type="button" aria-label="关闭代码预览" title="关闭（Esc）">×</button>
      </div>
    </div>
    <div class="code-preview__tabs">
      <div class="code-preview__tab"><span class="code-preview__file-icon" aria-hidden="true">&lt;/&gt;</span><span id="code-preview-filename"></span></div>
    </div>
    <div class="code-preview__viewport" tabindex="0" aria-label="代码内容，可上下和左右滚动" aria-busy="false"></div>
    <div class="code-preview__statusbar"><span class="code-preview__status" role="status" aria-live="polite"></span><span class="code-preview__language"></span></div>`;
  document.body.append(panel);

  const filename = panel.querySelector('#code-preview-filename');
  const viewport = panel.querySelector('.code-preview__viewport');
  const status = panel.querySelector('.code-preview__status');
  const language = panel.querySelector('.code-preview__language');
  const sourceLink = panel.querySelector('.code-preview__source');
  const closeButton = panel.querySelector('.code-preview__close');
  const mobile = matchMedia('(max-width: 899px)');
  const site = document.querySelector('body > .container');
  const cache = new Map();
  let activeLink = null;
  let controller = null;
  let requestId = 0;
  let previousInert = null;

  links.forEach(link => {
    link.setAttribute('aria-haspopup', 'dialog');
    link.setAttribute('aria-controls', panel.id);
    link.setAttribute('aria-expanded', 'false');
  });

  function syncLayout() {
    const modal = !panel.hidden && mobile.matches;
    panel.setAttribute('aria-modal', String(modal));
    document.body.classList.toggle('code-preview-modal', modal);
    if (site && modal && previousInert === null) {
      previousInert = site.hasAttribute('inert');
      site.setAttribute('inert', '');
    } else if (site && !modal && previousInert !== null) {
      if (!previousInert) site.removeAttribute('inert');
      previousInert = null;
    }
    if (modal && !panel.contains(document.activeElement)) closeButton.focus({preventScroll: true});
  }

  function close() {
    if (panel.hidden) return;
    const anchorTop = activeLink?.getBoundingClientRect().top;
    requestId++;
    controller?.abort();
    controller = null;
    panel.hidden = true;
    viewport.setAttribute('aria-busy', 'false');
    document.body.classList.remove('code-preview-open');
    syncLayout();
    if (activeLink) {
      activeLink.setAttribute('aria-expanded', 'false');
      activeLink.classList.remove('is-code-preview-active');
      if (activeLink.isConnected) {
        if (anchorTop >= 0 && anchorTop <= innerHeight) window.scrollBy(0, activeLink.getBoundingClientRect().top - anchorTop);
        activeLink.focus({preventScroll: true});
      }
      activeLink = null;
    }
  }

  // Rebuild only the markup emitted by Chroma. Source text stays text, and
  // executable tags, event attributes, links and resource URLs are never added.
  function highlightedContent(html) {
    const template = document.createElement('template');
    template.innerHTML = html;
    const allowedTags = new Set(['DIV', 'PRE', 'CODE', 'SPAN', 'TABLE', 'TBODY', 'TR', 'TD']);
    const allowedStyles = new Set(['color', 'background-color', 'font-weight', 'font-style', 'text-decoration', 'display', 'white-space']);
    function copy(node) {
      if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.textContent);
      if (node.nodeType !== Node.ELEMENT_NODE || !allowedTags.has(node.tagName)) return null;
      const result = document.createElement(node.tagName.toLowerCase());
      if (node.className) result.className = node.className;
      for (const property of allowedStyles) {
        const value = node.style.getPropertyValue(property);
        if (value && !/url\s*\(|expression\s*\(|[<>]/i.test(value)) result.style.setProperty(property, value);
      }
      for (const child of node.childNodes) {
        const safeChild = copy(child);
        if (safeChild) result.append(safeChild);
      }
      return result;
    }
    const fragment = document.createDocumentFragment();
    for (const child of template.content.childNodes) {
      const safeChild = copy(child);
      if (safeChild) fragment.append(safeChild);
    }
    if (!fragment.querySelector('pre')) throw new Error('预览内容格式不正确。');
    return fragment;
  }

  function notice(message, retry = false) {
    const body = document.createElement('div');
    body.className = 'code-preview__notice';
    const text = document.createElement('p');
    text.textContent = message;
    body.append(text);
    if (retry) {
      const button = document.createElement('button');
      button.className = 'code-preview__retry';
      button.type = 'button';
      button.textContent = '重新加载';
      button.addEventListener('click', () => {
        if (activeLink) open(activeLink, true);
      });
      body.append(button);
    }
    viewport.replaceChildren(body);
  }

  async function open(link, retry = false) {
    const anchorTop = link.getBoundingClientRect().top;
    controller?.abort();
    const currentRequest = ++requestId;
    const requestController = new AbortController();
    controller = requestController;
    if (activeLink) {
      activeLink.setAttribute('aria-expanded', 'false');
      activeLink.classList.remove('is-code-preview-active');
    }
    activeLink = link;
    link.setAttribute('aria-expanded', 'true');
    link.classList.add('is-code-preview-active');
    filename.textContent = link.dataset.codeFilename || link.textContent.trim();
    filename.title = filename.textContent;
    sourceLink.href = link.href;
    panel.hidden = false;
    document.body.classList.add('code-preview-open');
    syncLayout();
    // Keep the clicked paragraph in view when the article makes room for the pane.
    if (!mobile.matches) window.scrollBy(0, link.getBoundingClientRect().top - anchorTop);
    viewport.setAttribute('aria-busy', 'true');
    status.textContent = '正在加载…';
    language.textContent = '';
    notice('正在加载代码…');
    viewport.scrollTo(0, 0);
    closeButton.focus({preventScroll: true});

    try {
      const url = new URL(link.dataset.codePreview, location.href);
      if (url.origin !== location.origin) throw new Error('预览地址不可用。');
      const key = url.href;
      let data = retry ? null : cache.get(key);
      if (!data) {
        const response = await fetch(key, {
          signal: requestController.signal,
          credentials: 'same-origin',
          cache: retry ? 'reload' : 'default'
        });
        if (!response.ok) throw new Error('暂时无法加载代码预览。');
        data = await response.json();
      }
      if (currentRequest !== requestId || panel.hidden) return;
      if (!data || typeof data !== 'object') throw new Error('预览内容格式不正确。');
      if (data.error) {
        const message = typeof data.error === 'string' ? data.error : '此文件暂时无法预览。';
        notice(`${message} 可点击右上角“打开源文件”查看。`);
        status.textContent = '预览不可用';
        return;
      }
      if (typeof data.html !== 'string') throw new Error('预览内容格式不正确。');
      if (!data.html && data.lineCount === 0) notice('这是一个空文件。');
      else viewport.replaceChildren(highlightedContent(data.html));
      cache.set(key, data);
      filename.textContent = typeof data.filename === 'string' ? data.filename : filename.textContent;
      filename.title = filename.textContent;
      language.textContent = typeof data.language === 'string' ? data.language : '';
      status.textContent = Number.isSafeInteger(data.lineCount) && data.lineCount >= 0 ? `${data.lineCount} 行 · 只读` : '只读';
      viewport.scrollTo(0, 0);
      const lineAnchor = new URL(link.href).hash.match(/^#L(\d+)(?:[-:]L?\d+)?$/i);
      const line = lineAnchor ? Number(lineAnchor[1]) : 0;
      const code = viewport.querySelector('td:last-child code');
      if (code && line > 0 && line <= data.lineCount) {
        const lineHeight = parseFloat(getComputedStyle(code).lineHeight);
        viewport.scrollTop = Math.max(0, (line - 1) * lineHeight - viewport.clientHeight / 4);
      }
    } catch (error) {
      if (currentRequest !== requestId || panel.hidden || error.name === 'AbortError') return;
      const message = error instanceof TypeError ? '网络连接失败，暂时无法加载代码预览。' : error.message;
      notice(`${message} 可重新加载，或点击右上角“打开源文件”查看。`, true);
      status.textContent = '预览不可用';
    } finally {
      if (currentRequest === requestId) {
        viewport.setAttribute('aria-busy', 'false');
        controller = null;
      }
    }
  }

  document.addEventListener('click', event => {
    if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const link = event.target instanceof Element ? event.target.closest('a[data-code-preview]') : null;
    if (!link || link.hasAttribute('download')) return;
    event.preventDefault();
    open(link);
  });
  closeButton.addEventListener('click', close);
  document.addEventListener('keydown', event => {
    if (panel.hidden || event.defaultPrevented) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'Tab' && mobile.matches) {
      const controls = [...panel.querySelectorAll('a[href], button, [tabindex="0"]')].filter(element => element.getClientRects().length);
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    }
  });
  mobile.addEventListener('change', syncLayout);
})();
