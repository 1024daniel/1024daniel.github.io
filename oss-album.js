(function () {
  const bucket = "1024daniel";
  const endpoint = "oss-cn-hangzhou.aliyuncs.com";
  const defaultCacheMaxAge = 1000 * 60 * 30;
  const imagePattern = /\.(jpg|jpeg|png|gif|webp|avif)$/i;
  const thumbnailPattern = /\.(jpe?g|png|webp)$/i;

  function normalizePrefix(prefix) {
    const value = prefix || "album/";
    return value.endsWith("*") ? value.slice(0, -1) : value;
  }

  function escapeHtml(text) {
    return String(text || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function filenameWithoutExtension(key) {
    const filename = key.split("/").pop() || "";
    return filename.replace(/\.[^.]+$/, "");
  }

  function imageUrl(key, thumbnail) {
    const baseUrl = encodeURI(`https://${bucket}.${endpoint}/${key}`);
    if (!thumbnail) return baseUrl;
    if (!thumbnailPattern.test(key)) return baseUrl;

    return `${baseUrl}?x-oss-process=image/resize,w_720/quality,q_82/format,webp`;
  }

  function imageInfoUrl(key) {
    return `${imageUrl(key, false)}?x-oss-process=image/info`;
  }

  function formatTime(value) {
    if (!value) return "";

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";

    return date.toLocaleString("zh-CN");
  }

  function parseExifDate(value, offset) {
    if (!value) return { text: "", timestamp: null };

    const normalized = String(value)
      .trim()
      .replace(/^(\d{4}):(\d{2}):(\d{2}) /, "$1-$2-$3T");
    const withOffset = offset && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(normalized)
      ? `${normalized}${offset}`
      : normalized;
    const preferredDate = new Date(withOffset);
    const fallbackDate = new Date(normalized);
    const date = Number.isFinite(preferredDate.getTime()) ? preferredDate : fallbackDate;
    const timestamp = date.getTime();

    return {
      text: Number.isFinite(timestamp) ? date.toLocaleString("zh-CN") : "",
      timestamp: Number.isFinite(timestamp) ? timestamp : null
    };
  }

  function parseAlbumPage(xmlText) {
    const parser = new DOMParser();
    const xml = parser.parseFromString(xmlText, "text/xml");

    const items = [...xml.querySelectorAll("Contents")]
      .map(obj => ({
        key: obj.querySelector("Key")?.textContent || "",
        lastModified: obj.querySelector("LastModified")?.textContent || ""
      }))
      .filter(item => item.key && !item.key.endsWith("/"))
      .filter(item => imagePattern.test(item.key));

    return {
      items,
      isTruncated: xml.querySelector("IsTruncated")?.textContent === "true",
      nextContinuationToken: xml.querySelector("NextContinuationToken")?.textContent || ""
    };
  }

  async function fetchAlbumPages(prefix) {
    const items = [];
    let continuationToken = "";

    do {
      const params = new URLSearchParams({
        "list-type": "2",
        prefix,
        "max-keys": "1000"
      });
      if (continuationToken) params.set("continuation-token", continuationToken);

      const res = await fetch(`https://${bucket}.${endpoint}/?${params}`, { cache: "force-cache" });
      if (!res.ok) throw new Error("album list failed");

      const page = parseAlbumPage(await res.text());
      items.push(...page.items);
      continuationToken = page.isTruncated ? page.nextContinuationToken : "";

      if (page.isTruncated && !continuationToken) {
        throw new Error("album list pagination token missing");
      }
    } while (continuationToken);

    return items.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
  }

  function storageArea(name) {
    return name === "local" ? localStorage : sessionStorage;
  }

  function readJson(area, key, fallback) {
    try {
      return JSON.parse(area.getItem(key) || "null") || fallback;
    } catch (e) {
      return fallback;
    }
  }

  function writeJson(area, key, value) {
    try {
      area.setItem(key, JSON.stringify(value));
    } catch (e) {}
  }

  function readListCache(options) {
    const area = storageArea(options.listCacheStorage);
    const cached = readJson(area, options.listCacheKey, null);
    if (!cached) return null;

    if (typeof options.listCacheMaxAge === "number") {
      if (!cached.time || Date.now() - cached.time > options.listCacheMaxAge) {
        return null;
      }
    }

    return Array.isArray(cached.items) ? cached : null;
  }

  function writeListCache(options, items) {
    const area = storageArea(options.listCacheStorage);
    writeJson(area, options.listCacheKey, {
      time: Date.now(),
      latestUpdated: items[0]?.lastModified || "",
      items
    });
  }

  function readTakenTimeCache(key) {
    return readJson(localStorage, key, {});
  }

  function writeTakenTimeCache(key, cache) {
    writeJson(localStorage, key, cache);
  }

  function displayTime(item, takenTimeCache) {
    const cached = takenTimeCache[item.key];
    const fallbackTime = formatTime(item.lastModified);

    if (cached && cached.lastModified === item.lastModified) {
      return cached.takenTime || fallbackTime;
    }

    return fallbackTime;
  }

  function itemTimestamp(item, takenTimeCache) {
    const cached = takenTimeCache[item.key];
    if (cached && cached.lastModified === item.lastModified) {
      if (Number.isFinite(cached.takenTimestamp)) return cached.takenTimestamp;

      const legacyTimestamp = new Date(cached.takenTime).getTime();
      if (Number.isFinite(legacyTimestamp)) return legacyTimestamp;
    }

    return new Date(item.lastModified).getTime() || 0;
  }

  function sortItemsByTime(items, takenTimeCache) {
    return items
      .map((item, index) => ({ item, index }))
      .sort((a, b) =>
        itemTimestamp(b.item, takenTimeCache) - itemTimestamp(a.item, takenTimeCache) ||
        a.index - b.index
      )
      .map(entry => entry.item);
  }

  function refreshLately(target) {
    window.Lately && Lately.init({ target });
  }

  function refreshLatelySoon(state) {
    clearTimeout(state.latelyTimer);
    state.latelyTimer = setTimeout(() => refreshLately(state.timeSelector), 120);
  }

  function layoutAlbum(state) {
    if (!state.masonry) return;

    const wrapper = state.albumDom.firstElementChild;
    if (!wrapper) return;

    const cards = [...wrapper.querySelectorAll(state.itemQuery)];
    const columnCount = window.matchMedia("(max-width: 980px)").matches ? 3 : 6;
    const columnWidth = wrapper.clientWidth / columnCount;
    const columnHeights = Array(columnCount).fill(0);

    cards.forEach((card, index) => {
      const column = index < columnCount
        ? index
        : columnHeights.indexOf(Math.min(...columnHeights));
      card.style.width = `${columnWidth}px`;
      card.style.left = `${column * columnWidth}px`;
      card.style.top = `${columnHeights[column]}px`;
      columnHeights[column] += card.offsetHeight;
    });

    wrapper.style.height = `${Math.max(0, ...columnHeights)}px`;
  }

  function scheduleAlbumLayout(state) {
    if (!state.masonry) return;

    clearTimeout(state.layoutTimer);
    state.layoutTimer = setTimeout(() => layoutAlbum(state), 40);
  }

  function updatePhotoTime(state, key, time) {
    if (!key || !time) return;

    const card = [...state.albumDom.querySelectorAll(state.itemQuery)]
      .find(item => item.dataset.key === key);
    const timeNode = card && card.querySelector(".photo-time");
    if (!timeNode) return;

    timeNode.textContent = time;
    timeNode.title = time;
    refreshLatelySoon(state);
  }

  async function fetchTakenTime(item, state) {
    const cached = state.takenTimeCache[item.key];
    if (cached && cached.lastModified === item.lastModified) {
      return cached.takenTime || "";
    }

    try {
      const res = await fetch(imageInfoUrl(item.key), { cache: "force-cache" });
      if (!res.ok) throw new Error("image info failed");

      const info = await res.json();
      const rawTime =
        info.DateTimeOriginal?.value ||
        info.DateTimeDigitized?.value ||
        info.DateTime?.value ||
        "";
      const offset = info.OffsetTimeOriginal?.value || "";
      const takenDate = parseExifDate(rawTime, offset);

      state.takenTimeCache[item.key] = {
        lastModified: item.lastModified,
        takenTime: takenDate.text,
        takenTimestamp: takenDate.timestamp
      };
      writeTakenTimeCache(state.takenTimeCacheKey, state.takenTimeCache);

      return takenDate.text;
    } catch (e) {
      state.takenTimeCache[item.key] = {
        lastModified: item.lastModified,
        takenTime: ""
      };
      writeTakenTimeCache(state.takenTimeCacheKey, state.takenTimeCache);
      return "";
    }
  }

  function hydrateTakenTimes(items, state, renderId) {
    const queue = items.filter(item => {
      const cached = state.takenTimeCache[item.key];
      if (cached && cached.lastModified === item.lastModified) {
        updatePhotoTime(state, item.key, cached.takenTime || formatTime(item.lastModified));
        return false;
      }

      return /\.(jpe?g)$/i.test(item.key);
    });
    let cursor = 0;

    async function worker() {
      while (cursor < queue.length) {
        if (renderId !== state.renderId) return;
        const item = queue[cursor++];
        const takenTime = await fetchTakenTime(item, state);
        if (renderId !== state.renderId) return;
        if (takenTime) updatePhotoTime(state, item.key, takenTime);
      }
    }

    const start = async () => {
      const workers = [];
      for (let i = 0; i < state.takenTimeConcurrency; i++) workers.push(worker());
      await Promise.all(workers);

      if (renderId !== state.renderId || !queue.length) return;
      const wrapper = state.albumDom.firstElementChild;
      if (!wrapper) return;

      const cards = new Map(
        [...wrapper.querySelectorAll(state.itemQuery)].map(card => [card.dataset.key, card])
      );
      sortItemsByTime(state.items.slice(0, state.renderedCount), state.takenTimeCache).forEach(item => {
        const card = cards.get(item.key);
        if (card) wrapper.appendChild(card);
      });
      scheduleAlbumLayout(state);
    };

    if ("requestIdleCallback" in window) {
      requestIdleCallback(start, { timeout: 1200 });
    } else {
      setTimeout(start, 300);
    }
  }

  function photoMarkup(item, index, state) {
    const filename = filenameWithoutExtension(item.key);
    const photoTime = displayTime(item, state.takenTimeCache);
    const fullUrl = imageUrl(item.key, false);
    const thumbUrl = imageUrl(item.key, true);
    const eager = index < state.eagerCount;

    return `
      <div class="${state.itemClass}" data-key="${escapeHtml(item.key)}">
        <a class="photo-link" href="${fullUrl}" aria-label="${escapeHtml(filename)}">
          <img
            class="photo-img"
            loading="${eager ? "eager" : "lazy"}"
            fetchpriority="${eager ? "high" : "auto"}"
            decoding="async"
            src="${thumbUrl}"
            onerror="this.onerror=null;this.src='${fullUrl}'"
            alt="${escapeHtml(filename)}"
          />
        </a>

        <span class="photo-title">${escapeHtml(filename)}</span>
        <span class="photo-time" title="${escapeHtml(photoTime)}">${escapeHtml(photoTime)}</span>
      </div>
    `;
  }

  function armLoadObserver(state) {
    if (state.loadObserver || state.renderedCount >= state.items.length) return;
    if (!("IntersectionObserver" in window)) return;

    const sentinel = state.albumDom.querySelector(".album-load-sentinel");
    if (!sentinel) return;

    state.loadObserver = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;

      state.loadObserver?.disconnect();
      state.loadObserver = null;
      appendAlbumBatch(state);
    }, { rootMargin: state.loadMoreRootMargin });
    state.loadObserver.observe(sentinel);
  }

  function appendAlbumBatch(state) {
    const wrapper = state.albumDom.querySelector(".album-items");
    if (!wrapper || state.renderedCount >= state.items.length) return;

    state.loadObserver?.disconnect();
    state.loadObserver = null;
    const previousCardCount = wrapper.querySelectorAll(state.itemQuery).length;
    const start = state.renderedCount;
    const end = Math.min(start + state.batchSize, state.items.length);
    const batch = state.items.slice(start, end);
    wrapper.insertAdjacentHTML(
      "beforeend",
      batch.map((item, offset) => photoMarkup(item, start + offset, state)).join("")
    );
    state.renderedCount = end;

    const newCards = [...wrapper.querySelectorAll(state.itemQuery)].slice(previousCardCount);
    const newImages = newCards.map(card => card.querySelector(".photo-img")).filter(Boolean);
    newImages.forEach(img => {
      if (!img.complete && !img.dataset.layoutBound) {
        img.dataset.layoutBound = "true";
        img.addEventListener("load", () => scheduleAlbumLayout(state), { once: true });
      }
    });

    window.ViewImage && ViewImage.init(`${state.itemQuery} a`);
    refreshLately(state.timeSelector);
    hydrateTakenTimes(batch, state, state.renderId);
    scheduleAlbumLayout(state);

    if (state.renderedCount >= state.items.length) {
      state.albumDom.querySelector(".album-load-sentinel")?.remove();
      return;
    }

    Promise.all(newImages.map(img => img.complete
      ? Promise.resolve()
      : new Promise(resolve => {
          img.addEventListener("load", resolve, { once: true });
          img.addEventListener("error", resolve, { once: true });
        })
    )).then(() => {
      layoutAlbum(state);
      armLoadObserver(state);
    });
  }

  function renderAlbum(items, state) {
    ++state.renderId;
    const sortedItems = sortItemsByTime(items, state.takenTimeCache);
    const visibleItems = Number.isFinite(state.limit)
      ? sortedItems.slice(0, state.limit)
      : sortedItems;

    state.loadObserver?.disconnect();
    state.loadObserver = null;
    state.items = visibleItems;
    state.renderedCount = 0;

    if (!visibleItems.length) {
      state.albumDom.innerHTML = state.emptyText
        ? `<p class="album-empty">${escapeHtml(state.emptyText)}</p>`
        : "";
      return;
    }

    state.albumDom.innerHTML = `
      <div class="${state.wrapperClass} album-items"></div>
      <div class="album-load-sentinel" aria-hidden="true"></div>
    `;
    appendAlbumBatch(state);

    if (!("IntersectionObserver" in window)) {
      // Older browsers get the complete album; images still retain native lazy loading.
      while (state.renderedCount < state.items.length) appendAlbumBatch(state);
    }
  }

  function render(rawOptions) {
    const prefix = normalizePrefix(rawOptions.prefix);
    const albumDom = document.querySelector(rawOptions.selector);
    if (!albumDom) return;
    const wrapperClass = rawOptions.wrapperClass || "gallery-photos page";

    const state = {
      albumDom,
      prefix,
      emptyText: rawOptions.emptyText || "",
      errorText: rawOptions.errorText || "",
      limit: rawOptions.limit || Infinity,
      wrapperClass,
      itemClass: rawOptions.itemClass || "gallery-photo visible",
      itemQuery: `.${(rawOptions.itemClass || "gallery-photo visible").split(/\s+/)[0]}`,
      timeSelector: rawOptions.timeSelector || ".photo-time",
      eagerCount: rawOptions.eagerCount || 18,
      batchSize: rawOptions.batchSize || 30,
      loadMoreRootMargin: rawOptions.loadMoreRootMargin || "200px 0px",
      takenTimeConcurrency: rawOptions.takenTimeConcurrency || 3,
      listCacheKey: rawOptions.listCacheKey || `album:oss:list:${prefix}:v2`,
      listCacheStorage: rawOptions.listCacheStorage || "session",
      listCacheMaxAge: Object.prototype.hasOwnProperty.call(rawOptions, "listCacheMaxAge")
        ? rawOptions.listCacheMaxAge
        : defaultCacheMaxAge,
      takenTimeCacheKey: rawOptions.takenTimeCacheKey || `album:oss:taken-time:${prefix}:v1`,
      takenTimeCache: readTakenTimeCache(
        rawOptions.takenTimeCacheKey || `album:oss:taken-time:${prefix}:v1`
      ),
      masonry: wrapperClass.split(/\s+/).includes("album-masonry"),
      renderId: 0,
      latelyTimer: null,
      layoutTimer: null,
      items: [],
      renderedCount: 0,
      loadObserver: null
    };

    if (state.masonry) {
      window.addEventListener("resize", () => scheduleAlbumLayout(state));
    }

    const cached = readListCache(state);
    if (cached) renderAlbum(cached.items, state);

    fetchAlbumPages(prefix)
      .then(items => {
        const latestUpdated = items[0]?.lastModified || "";

        if (!items.length) {
          writeListCache(state, []);
          renderAlbum([], state);
          return;
        }

        if (!cached || cached.latestUpdated !== latestUpdated) {
          writeListCache(state, items);
          renderAlbum(items, state);
        }
      })
      .catch(() => {
        if (!cached) {
          state.albumDom.innerHTML = state.errorText
            ? `<p class="album-error">${escapeHtml(state.errorText)}</p>`
            : "";
        }
      });
  }

  window.OssAlbum = {
    render,
    clearCache(options) {
      const prefix = normalizePrefix(options.prefix);
      const listCacheKey = options.listCacheKey || `album:oss:list:${prefix}:v2`;
      const takenTimeCacheKey = options.takenTimeCacheKey || `album:oss:taken-time:${prefix}:v1`;
      storageArea(options.listCacheStorage || "session").removeItem(listCacheKey);
      localStorage.removeItem(takenTimeCacheKey);
    }
  };
})();
