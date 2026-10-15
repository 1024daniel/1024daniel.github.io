import {mermaidConfig} from './mermaid-theme.js?v=2';

const diagrams = [...document.querySelectorAll('.mermaid')].map(element => ({
  element,
  source: element.textContent,
  notice: null
}));

if (diagrams.length) {
  const lightbox = document.querySelector('[data-diagram-lightbox]');
  const idPrefix = `site-diagram-${Date.now().toString(36)}`;
  let nextId = 0;
  let revision = 0;
  let pending = false;
  let running = false;
  let mermaid = null;
  let layout = 'dagre';
  let observedDark = document.body.classList.contains('dark');

  const isLightboxOpen = () => lightbox?.open || document.body.classList.contains('diagram-lightbox-open');
  const currentTheme = () => document.body.classList.contains('dark') ? 'dark' : 'light';
  const previewButton = element => element.closest('[data-diagram-preview]')?.querySelector('.diagram-preview__open');

  function showError(diagram, message, theme) {
    const {element, source} = diagram;
    element.textContent = source;
    element.removeAttribute('data-processed');
    delete element.dataset.diagramReady;
    delete element.dataset.diagramLayout;
    element.dataset.diagramTheme = theme;
    element.closest('[data-diagram-preview]')?.classList.add('diagram-preview--error');
    const button = previewButton(element);
    if (button) {
      button.disabled = true;
      button.hidden = true;
    }
    diagram.notice?.remove();
    const notice = document.createElement('p');
    notice.className = 'diagram-error';
    notice.setAttribute('role', 'status');
    notice.textContent = message;
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = '刷新重试';
    retry.addEventListener('click', () => window.location.reload());
    notice.append(' ', retry);
    element.before(notice);
    diagram.notice = notice;
  }

  async function renderSVG(source, fontFamily) {
    // Measure a separate connected SVG. The previous diagram remains usable
    // while Mermaid works, and its lightbox can still move that original SVG.
    const stage = document.createElement('div');
    stage.style.cssText = 'position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none;';
    stage.style.fontFamily = fontFamily;
    stage.setAttribute('aria-hidden', 'true');
    document.body.append(stage);
    try {
      return await mermaid.render(`${idPrefix}-${++nextId}`, source, stage);
    } finally {
      stage.remove();
    }
  }

  function requestRender() {
    revision++;
    pending = true;
    void flush();
  }

  async function flush() {
    if (!mermaid || running || isLightboxOpen()) return;
    running = true;
    try {
      while (pending && !isLightboxOpen()) {
        pending = false;
        const pass = revision;
        const theme = currentTheme();
        const fontFamily = getComputedStyle(document.querySelector('.post-content') || document.body).fontFamily;
        mermaid.initialize(mermaidConfig({dark: theme === 'dark', fontFamily, layout}));

        for (const diagram of diagrams) {
          if (pass !== revision || isLightboxOpen()) {
            pending = true;
            break;
          }
          const {element, source} = diagram;
          if (!element.isConnected || (element.dataset.diagramReady && element.dataset.diagramTheme === theme)) continue;
          try {
            let result;
            try {
              result = await renderSVG(source, fontFamily);
            } catch (error) {
              if (layout !== 'elk' || pass !== revision || isLightboxOpen()) throw error;
              // ELK also loads code lazily during rendering. Retry with the
              // built-in layout if that late import or layout operation fails.
              mermaid.initialize(mermaidConfig({dark: theme === 'dark', fontFamily, layout: 'dagre'}));
              try {
                result = await renderSVG(source, fontFamily);
                layout = 'dagre';
                console.warn('ELK diagram rendering failed; using the built-in layout.', error);
              } catch {
                mermaid.initialize(mermaidConfig({dark: theme === 'dark', fontFamily, layout}));
                throw error;
              }
            }
            if (pass !== revision || isLightboxOpen()) {
              pending = true;
              break;
            }
            const template = document.createElement('template');
            template.innerHTML = result.svg;
            if (!template.content.querySelector('svg')) throw new Error('Mermaid returned no SVG.');
            element.replaceChildren(template.content);
            result.bindFunctions?.(element);
            element.dataset.diagramReady = 'true';
            element.dataset.diagramTheme = theme;
            element.dataset.diagramLayout = layout;
            element.closest('[data-diagram-preview]')?.classList.remove('diagram-preview--error');
            const button = previewButton(element);
            if (button) {
              button.disabled = false;
              button.hidden = false;
            }
            diagram.notice?.remove();
            diagram.notice = null;
          } catch (error) {
            if (pass !== revision || isLightboxOpen()) {
              pending = true;
              break;
            }
            console.error('Mermaid diagram rendering failed', error);
            showError(diagram, '流程图渲染失败，下面保留了源码。', theme);
          }
        }
        if (pass === revision && !pending) document.body.dataset.mermaidTheme = theme;
      }
    } finally {
      running = false;
    }
  }

  new MutationObserver(() => {
    const dark = document.body.classList.contains('dark');
    if (dark !== observedDark) {
      observedDark = dark;
      requestRender();
    }
  }).observe(document.body, {attributes: true, attributeFilter: ['class']});

  // The lightbox's close handler first restores its SVG to the article. Wait
  // until every close handler has run before replacing any restored diagram.
  lightbox?.addEventListener('close', () => queueMicrotask(() => {
    if (pending) requestRender();
  }));

  try {
    const [{default: library}] = await Promise.all([
      import('https://cdn.jsdelivr.net/npm/mermaid@11.12.0/dist/mermaid.esm.min.mjs'),
      document.fonts?.ready
    ]);
    try {
      const {default: layouts} = await import('https://cdn.jsdelivr.net/npm/@mermaid-js/layout-elk@0.2.0/dist/mermaid-layout-elk.esm.min.mjs');
      mermaid = library;
      mermaid.registerLayoutLoaders(layouts);
      layout = 'elk';
    } catch (error) {
      console.warn('ELK could not load; using the built-in Mermaid layout.', error);
    }
    mermaid = library;
    requestRender();
  } catch (error) {
    console.error('Mermaid loading failed', error);
    diagrams.forEach(diagram => showError(diagram, '流程图组件未能加载，请检查网络后重试。', currentTheme()));
  }
}
