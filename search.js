document.addEventListener('DOMContentLoaded', () => {
  const searchButton = document.querySelector('#searchBoxButton');
  const searchInput = document.querySelector('#searchBoxInput');
  const searchResult = document.querySelector('#searchResult');
  const searchCount = document.querySelector('#searchCount');

  let indexData = null;

  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function normalize(text) {
    return String(text || '').toLowerCase().trim();
  }

  function parseLocationSearch() {
    const params = new URLSearchParams(window.location.search);
    const tag = params.get('tag');

    if (tag) return { query: `#${tag}`, mode: 'tag' };
    return { query: params.get('q') || '', mode: 'text' };
  }

  function getSearchMode(query) {
    return String(query || '').trim().startsWith('#') ? 'tag' : 'text';
  }

  function getTerms(query) {
    return normalize(query)
      .replace(/^#/, '')
      .split(/\s+/)
      .filter(Boolean);
  }

  async function getIndex() {
    if (indexData) return indexData;

    const resp = await fetch('/index.json');
    indexData = uniqueItems(await resp.json());
    return indexData;
  }

  function scoreItem(item, terms) {
    const title = normalize(item.title);
    const summary = normalize(item.summary);
    const content = normalize(item.content);
    const tags = (item.tags || []).map(normalize);
    const categories = (item.categories || []).map(normalize);
    const type = normalize(item.type);

    let score = 0;
    let matchedTerms = 0;

    terms.forEach(term => {
      let termScore = 0;

      if (title === term) termScore += 80;
      if (title.includes(term)) termScore += 50;

      if (tags.includes(term)) termScore += 70;
      if (tags.some(tag => tag.includes(term))) termScore += 35;

      if (categories.includes(term)) termScore += 45;
      if (categories.some(category => category.includes(term))) termScore += 24;

      if (summary.includes(term)) termScore += 18;
      if (content.includes(term)) termScore += 8;
      if (type.includes(term)) termScore += 4;

      if (termScore > 0) matchedTerms += 1;
      score += termScore;
    });

    return matchedTerms === terms.length ? score : 0;
  }

  function matchesTag(item, query) {
    const tag = normalize(query).replace(/^#/, '');
    return tag && (item.tags || []).map(normalize).includes(tag);
  }

  function getItemKey(item) {
    return item.permalink || `${item.section || item.type || ''}:${item.title || ''}`;
  }

  function uniqueItems(items) {
    const itemMap = new Map();

    items.forEach(item => {
      itemMap.set(getItemKey(item), item);
    });

    return [...itemMap.values()];
  }

  function uniqueResults(results) {
    const resultMap = new Map();

    results.forEach(result => {
      const key = getItemKey(result.item);
      const current = resultMap.get(key);

      if (!current || result.score > current.score) {
        resultMap.set(key, result);
      }
    });

    return [...resultMap.values()];
  }

  function makeSnippet(item, terms) {
    const text = String(item.summary || item.content || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';

    const lower = text.toLowerCase();
    const hit = terms
      .map(term => lower.indexOf(term))
      .filter(index => index >= 0)
      .sort((a, b) => a - b)[0];
    const start = Math.max(0, (hit || 0) - 42);
    const snippet = text.slice(start, start + 130);

    return `${start > 0 ? '…' : ''}${escapeHtml(snippet)}${start + 130 < text.length ? '…' : ''}`;
  }

  function renderResults(results, terms) {
    if (!results.length) {
      return '<div class="search-empty">没有找到匹配内容</div>';
    }

    return results.map(({ item }) => {
      const tags = (item.tags || [])
        .map(tag => String(tag || '').trim())
        .filter(Boolean)
        .map(tag => {
          return `<button class="search-result-tag" type="button" data-tag="${escapeHtml(tag)}">#${escapeHtml(tag)}</button>`;
        }).join('');

      return `
        <article class="search-result-item">
          <h2 class="post-title search-result-title"><a href="${item.permalink}">${escapeHtml(item.title)}</a></h2>
          <div class="post-meta search-result-meta">
            <span class="post-date">${escapeHtml(item.date)}</span>
            ${tags ? `<span class="search-result-tags">${tags}</span>` : ''}
          </div>
          <div class="post-content search-result-summary">${makeSnippet(item, terms)}</div>
        </article>
      `;
    }).join('');
  }

  function updateURL(query, mode) {
    const param = mode === 'tag' ? 'tag' : 'q';
    const value = mode === 'tag' ? String(query).trim().replace(/^#/, '') : query;
    const url = value ? `${location.pathname}?${param}=${encodeURIComponent(value)}` : location.pathname;
    history.pushState('', '', url);
  }

  async function search(query, mode, syncURL) {
    const items = await getIndex();
    const terms = getTerms(query);

    if (!terms.length) {
      searchResult.innerHTML = '';
      searchCount.innerHTML = `共收录 ${items.length} 篇内容`;
      if (syncURL) updateURL('', mode);
      return;
    }

    const results = uniqueResults(items
      .map(item => ({
        item,
        score: mode === 'tag' ? (matchesTag(item, query) ? 1 : 0) : scoreItem(item, terms)
      }))
      .filter(result => result.score > 0))
      .sort((a, b) => b.score - a.score || b.item.date.localeCompare(a.item.date));
    const visibleResults = results.slice(0, 50);

    searchResult.innerHTML = renderResults(visibleResults, terms);
    searchCount.innerHTML = mode === 'tag'
      ? `标签 #${escapeHtml(String(query).trim().replace(/^#/, ''))} 下共 ${results.length} 篇内容`
      : `共查询到 ${results.length} 篇内容`;

    if (syncURL) updateURL(query, mode);
  }

  function runSearch(syncURL, mode = getSearchMode(searchInput.value)) {
    search(searchInput.value, mode, syncURL).catch(() => {
      searchCount.innerHTML = '搜索索引加载失败';
      searchResult.innerHTML = '';
    });
  }

  searchButton.addEventListener('click', () => runSearch(true));
  searchInput.addEventListener('input', () => runSearch(true));
  searchInput.addEventListener('keyup', event => {
    if (event.key === 'Enter') runSearch(true);
  });

  document.addEventListener('click', event => {
    const tagButton = event.target.closest('[data-tag]');
    if (!tagButton) return;

    searchInput.value = `#${tagButton.dataset.tag}`;
    runSearch(true);
  });

  window.addEventListener('popstate', () => {
    const state = parseLocationSearch();
    searchInput.value = state.query;
    runSearch(false, state.mode);
  });

  const initialState = parseLocationSearch();
  searchInput.value = initialState.query;
  runSearch(false, initialState.mode);
});
