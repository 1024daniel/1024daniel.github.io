(() => {
  const root = document.querySelector('.music-room[data-tracks]');
  if (!root) return;

  const tracks = JSON.parse(root.dataset.tracks || '[]');
  if (!tracks.length) return;

  const player = root.querySelector('.music-player');
  const modal = root.querySelector('[data-player-modal]');
  const closeButton = modal.querySelector('.music-modal__close');
  const audio = player.querySelector('audio');
  const title = player.querySelector('[data-current-title]');
  const artist = player.querySelector('[data-current-artist]');
  const record = player.querySelector('.music-player__record');
  const cover = player.querySelector('[data-current-cover]');
  const lyrics = player.querySelector('[data-lyrics]');
  const lyricsPanel = player.querySelector('.music-player__lyrics');
  const lyricsDisclosure = lyricsPanel?.closest('details');
  const playButton = player.querySelector('.music-player__play');
  const progress = player.querySelector('input[type="range"]');
  const currentTime = player.querySelector('[data-current-time]');
  const totalTime = player.querySelector('[data-total-time]');
  const status = player.querySelector('[data-player-status]');
  const recordTitle = player.querySelector('[data-record-title]');
  const recordArtist = player.querySelector('[data-record-artist]');
  const trackButtons = [...root.querySelectorAll('[data-track-index]')];
  const albumShelf = root.querySelector('.music-album-shelf');
  const albumGrid = root.querySelector('.music-album-grid');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let currentIndex = 0;
  let activeLyricIndex = -1;
  let shelfFrame = 0;
  let revealFrame = 0;
  let openTimer = 0;
  let closeTimer = 0;
  let savedOverflow = null;
  let drag = null;
  let suppressClickUntil = 0;

  const scrollBehavior = () => reducedMotion.matches ? 'auto' : 'smooth';
  const setStatus = message => { if (status) status.textContent = message; };
  const formatTime = seconds => {
    if (!Number.isFinite(seconds)) return '0:00';
    return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
  };

  const centerActiveLyric = () => {
    const activeLine = lyrics.children[activeLyricIndex];
    if (!activeLine || !lyricsPanel || modal.hidden || (lyricsDisclosure && !lyricsDisclosure.open)) return;
    const top = lyricsPanel.scrollTop + activeLine.getBoundingClientRect().top - lyricsPanel.getBoundingClientRect().top - lyricsPanel.clientHeight / 2 + activeLine.clientHeight / 2;
    lyricsPanel.scrollTo({ top: Math.max(0, top), behavior: scrollBehavior() });
  };
  lyricsDisclosure?.addEventListener('toggle', () => { if (lyricsDisclosure.open) centerActiveLyric(); });

  const updateShelfPerspective = () => {
    shelfFrame = 0;
    const currentShift = parseFloat(albumGrid.style.getPropertyValue('--shelf-static-shift')) || 0;
    const rawViewportCenter = albumShelf.scrollLeft + albumShelf.clientWidth / 2 - albumGrid.offsetLeft + currentShift;
    const firstButton = trackButtons[0];
    const lastButton = trackButtons[trackButtons.length - 1];
    const groupCenter = ((firstButton.offsetLeft + firstButton.offsetWidth / 2) + (lastButton.offsetLeft + lastButton.offsetWidth / 2)) / 2;
    const groupWidth = lastButton.offsetLeft + lastButton.offsetWidth - firstButton.offsetLeft;
    const isStaticShelf = groupWidth <= albumShelf.clientWidth * 0.9;
    const viewportCenter = isStaticShelf ? groupCenter : rawViewportCenter;
    albumGrid.style.setProperty('--shelf-static-shift', `${isStaticShelf ? rawViewportCenter - groupCenter : 0}px`);
    albumGrid.style.setProperty('--shelf-perspective-origin', `${viewportCenter}px`);
    const influenceRange = Math.max(albumShelf.clientWidth * 0.42, 260);
    trackButtons.forEach(button => {
      const cardCenter = button.offsetLeft + button.offsetWidth / 2;
      const distance = (cardCenter - viewportCenter) / influenceRange;
      const proximity = Math.max(0, 1 - Math.min(Math.abs(distance), 1));
      const direction = distance < 0 ? 1 : -1;
      // Keep every sleeve perpendicular to the screen; perspective alone reveals its cover.
      button.style.setProperty('--shelf-yaw', `${direction * 90}deg`);
      button.style.setProperty('--shelf-z', `${Math.round(proximity * 52)}px`);
      button.style.setProperty('--shelf-lift', `${Math.round(proximity * -12)}px`);
      button.style.setProperty('--shelf-light', String(0.7 + proximity * 0.3));
      button.style.setProperty('--album-half-width', `${button.offsetWidth / 2}px`);
    });
  };

  const queueShelfPerspective = () => {
    if (!shelfFrame) shelfFrame = window.requestAnimationFrame(updateShelfPerspective);
  };

  const syncPlayback = () => {
    const playing = !audio.paused && !audio.ended;
    player.classList.toggle('is-playing', playing);
    player.classList.toggle('is-paused', !playing);
    trackButtons.forEach((button, index) => button.classList.toggle('is-playing', playing && index === currentIndex));
    playButton.textContent = playing ? 'Ⅱ' : '▶';
    playButton.setAttribute('aria-label', playing ? '暂停' : '播放');
  };

  const playAudio = () => {
    if (!tracks[currentIndex].audio) return;
    const source = audio.src;
    setStatus('');
    audio.play().catch(error => {
      if (error.name === 'AbortError' || source !== audio.src) return;
      setStatus(error.name === 'NotAllowedError' ? '请点击播放按钮开始播放。' : '暂时无法播放这首歌，请重试或切换下一首。');
      syncPlayback();
    });
  };

  const selectTrack = (index, shouldPlay = false) => {
    currentIndex = (index + tracks.length) % tracks.length;
    const track = tracks[currentIndex];
    title.textContent = track.title || '未命名曲目';
    artist.textContent = track.artist || '';
    if (recordTitle) recordTitle.textContent = title.textContent;
    if (recordArtist) recordArtist.textContent = artist.textContent;
    if (track.cover) cover.src = track.cover; else cover.removeAttribute('src');
    record.classList.toggle('has-cover', Boolean(track.cover));
    totalTime.textContent = track.duration || '--:--';
    progress.value = 0;
    currentTime.textContent = '0:00';
    activeLyricIndex = -1;
    player.style.setProperty('--track-accent', track.accent || '#ff7a59');
    const lyricLines = track.timedLyrics?.length ? track.timedLyrics.map(line => line.text) : track.lyrics || [];
    lyrics.replaceChildren(...(lyricLines.length ? lyricLines : ['纯粹聆听，暂无歌词']).map((line, lyricIndex) => {
      const lyric = document.createElement('p');
      lyric.textContent = line;
      lyric.dataset.lyricIndex = lyricIndex;
      return lyric;
    }));
    if (lyricsPanel) lyricsPanel.scrollTop = 0;
    trackButtons.forEach((button, trackIndex) => button.classList.toggle('is-active', trackIndex === currentIndex));
    audio.pause();
    if (track.audio) audio.src = track.audio; else audio.removeAttribute('src');
    playButton.disabled = !track.audio;
    setStatus(track.audio ? '' : '这首歌暂时没有可用音源。');
    syncPlayback();
    queueShelfPerspective();
    if (shouldPlay) playAudio();
  };

  cover.addEventListener('error', () => record.classList.remove('has-cover'));
  root.querySelectorAll('.music-album-card__art img').forEach(image => {
    image.addEventListener('error', () => image.parentElement.classList.add('has-no-cover'));
  });

  const openModal = () => {
    openTimer = 0;
    window.clearTimeout(closeTimer);
    if (savedOverflow === null) savedOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
    revealFrame = window.requestAnimationFrame(() => {
      modal.classList.add('is-open');
      player.classList.add('is-revealed');
      centerActiveLyric();
    });
    closeButton.focus({ preventScroll: true });
  };

  const closeModal = () => {
    window.clearTimeout(openTimer);
    window.clearTimeout(closeTimer);
    window.cancelAnimationFrame(revealFrame);
    openTimer = 0;
    audio.pause();
    modal.classList.remove('is-open');
    player.classList.remove('is-revealed');
    trackButtons.forEach(button => button.classList.remove('is-active'));
    trackButtons[currentIndex].focus({ preventScroll: true });
    modal.setAttribute('aria-hidden', 'true');
    if (savedOverflow !== null) {
      document.body.style.overflow = savedOverflow;
      savedOverflow = null;
    }
    closeTimer = window.setTimeout(() => { modal.hidden = true; }, reducedMotion.matches ? 0 : 360);
    queueShelfPerspective();
  };

  const openTrack = index => {
    window.clearTimeout(openTimer);
    window.clearTimeout(closeTimer);
    selectTrack(index, true);
    trackButtons[currentIndex].scrollIntoView({ behavior: scrollBehavior(), block: 'nearest', inline: 'center' });
    openTimer = window.setTimeout(openModal, reducedMotion.matches ? 0 : 720);
  };

  playButton.addEventListener('click', () => { if (audio.paused) playAudio(); else audio.pause(); });
  player.querySelector('.music-player__previous').addEventListener('click', () => selectTrack(currentIndex - 1, true));
  player.querySelector('.music-player__next').addEventListener('click', () => selectTrack(currentIndex + 1, true));
  trackButtons.forEach(button => button.addEventListener('click', () => openTrack(Number(button.dataset.trackIndex))));

  albumGrid.addEventListener('keydown', event => {
    const focusedCard = event.target.closest('[data-track-index]');
    const focusedIndex = focusedCard ? Number(focusedCard.dataset.trackIndex) : currentIndex;
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      let nextIndex = (focusedIndex + (event.key === 'ArrowLeft' ? -1 : 1) + tracks.length) % tracks.length;
      if (event.key === 'Home') nextIndex = 0;
      if (event.key === 'End') nextIndex = tracks.length - 1;
      trackButtons[nextIndex].focus({ preventScroll: true });
      trackButtons[nextIndex].scrollIntoView({ behavior: scrollBehavior(), block: 'nearest', inline: 'center' });
    } else if (!focusedCard && ['Enter', ' '].includes(event.key)) {
      event.preventDefault();
      openTrack(currentIndex);
    }
  });

  albumShelf.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    drag = { id: event.pointerId, startX: event.clientX, scrollLeft: albumShelf.scrollLeft, moved: false };
  });
  window.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    const distance = event.clientX - drag.startX;
    if (!drag.moved && Math.abs(distance) < 6) return;
    if (!drag.moved) {
      drag.moved = true;
      albumShelf.setPointerCapture(event.pointerId);
      albumShelf.classList.add('is-dragging');
    }
    event.preventDefault();
    albumShelf.scrollLeft = drag.scrollLeft - distance;
  });
  const endDrag = event => {
    if (!drag || event.pointerId !== drag.id) return;
    if (drag.moved) suppressClickUntil = performance.now() + 350;
    drag = null;
    albumShelf.classList.remove('is-dragging');
    if (albumShelf.hasPointerCapture(event.pointerId)) albumShelf.releasePointerCapture(event.pointerId);
  };
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);
  albumShelf.addEventListener('lostpointercapture', endDrag);
  albumShelf.addEventListener('dragstart', event => event.preventDefault());
  albumShelf.addEventListener('click', event => {
    if (event.detail && performance.now() < suppressClickUntil) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, true);
  albumShelf.addEventListener('wheel', event => {
    if (event.ctrlKey || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    const maximum = albumShelf.scrollWidth - albumShelf.clientWidth;
    if (maximum <= 1 || (event.deltaY < 0 && albumShelf.scrollLeft <= 0) || (event.deltaY > 0 && albumShelf.scrollLeft >= maximum - 1)) return;
    event.preventDefault();
    const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? albumShelf.clientWidth : 1;
    albumShelf.scrollLeft += event.deltaY * multiplier;
  }, { passive: false });
  albumShelf.addEventListener('scroll', queueShelfPerspective, { passive: true });
  albumGrid.addEventListener('transitionend', event => {
    if (event.propertyName === 'margin-right' && event.target.matches('.music-album-card')) queueShelfPerspective();
  });
  window.addEventListener('resize', queueShelfPerspective, { passive: true });

  closeButton.addEventListener('click', closeModal);
  modal.addEventListener('click', event => { if (event.target === modal) closeModal(); });
  document.addEventListener('keydown', event => {
    const isOpen = modal.getAttribute('aria-hidden') === 'false';
    if (event.key === 'Escape' && (isOpen || openTimer)) {
      event.preventDefault();
      closeModal();
    }
    if (event.key !== 'Tab' || !isOpen) return;
    const focusable = [...modal.querySelectorAll('button:not([disabled]), input:not([disabled]), a[href], summary, [tabindex]:not([tabindex="-1"])')].filter(element => {
      const closedDisclosure = element.closest('details:not([open])');
      return element.getClientRects().length && (!closedDisclosure || (element.matches('summary') && element.parentElement === closedDisclosure));
    });
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) {
      event.preventDefault();
      first.focus();
    }
  });

  audio.addEventListener('play', syncPlayback);
  audio.addEventListener('pause', syncPlayback);
  audio.addEventListener('error', () => {
    setStatus('音源加载失败，请重试或切换下一首。');
    syncPlayback();
  });
  audio.addEventListener('timeupdate', () => {
    progress.value = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.currentTime / audio.duration * 100 : 0;
    currentTime.textContent = formatTime(audio.currentTime);
    const timedLyrics = tracks[currentIndex].timedLyrics || [];
    const activeIndex = timedLyrics.length
      ? timedLyrics.reduce((current, line, index) => line.time <= audio.currentTime ? index : current, -1)
      : Math.min(Math.floor((audio.currentTime / Math.max(audio.duration || 1, 1)) * lyrics.children.length), lyrics.children.length - 1);
    [...lyrics.children].forEach((line, index) => line.classList.toggle('is-active', index === activeIndex));
    if (activeIndex !== activeLyricIndex) {
      activeLyricIndex = activeIndex;
      centerActiveLyric();
    }
  });
  audio.addEventListener('loadedmetadata', () => { totalTime.textContent = formatTime(audio.duration); });
  audio.addEventListener('ended', () => selectTrack(currentIndex + 1, true));
  progress.addEventListener('input', () => {
    if (Number.isFinite(audio.duration) && audio.duration > 0) audio.currentTime = audio.duration * progress.value / 100;
  });
  selectTrack(0);
  trackButtons.forEach(button => button.classList.remove('is-active'));
  updateShelfPerspective();
})();
