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
  const playButton = player.querySelector('.music-player__play');
  const progress = player.querySelector('input[type="range"]');
  const currentTime = player.querySelector('[data-current-time]');
  const totalTime = player.querySelector('[data-total-time]');
  const trackButtons = [...root.querySelectorAll('[data-track-index]')];
  const albumShelf = root.querySelector('.music-album-shelf');
  const albumGrid = root.querySelector('.music-album-grid');
  const albumCovers = [...root.querySelectorAll('.music-album-card__art img')];
  let currentIndex = 0;
  let activeLyricIndex = -1;
  let shelfFrame = 0;

  const updateShelfPerspective = () => {
    shelfFrame = 0;
    const rawViewportCenter = albumShelf.scrollLeft + albumShelf.clientWidth / 2 - albumGrid.offsetLeft;
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
      // Fan-shaped shelf: the center sleeve is exactly edge-on while sleeves
      // on either side turn toward the viewer and reveal progressively more art.
      const direction = distance < 0 ? 1 : -1;
      const yaw = direction * (55 + proximity * 35);
      button.style.setProperty('--shelf-yaw', `${yaw}deg`);
      button.style.setProperty('--shelf-z', `${Math.round(proximity * 52)}px`);
      button.style.setProperty('--shelf-lift', `${Math.round(proximity * -12)}px`);
      button.style.setProperty('--shelf-light', String(0.7 + proximity * 0.3));
      button.style.setProperty('--album-half-width', `${button.offsetWidth / 2}px`);
    });
  };

  const queueShelfPerspective = () => {
    if (!shelfFrame) shelfFrame = window.requestAnimationFrame(updateShelfPerspective);
  };

  const formatTime = seconds => {
    if (!Number.isFinite(seconds)) return '0:00';
    return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
  };

  const renderLyrics = () => {
    const track = tracks[currentIndex];
    player.style.setProperty('--track-accent', track.accent || '#ff7a59');
    const lyricLines = track.timedLyrics?.length ? track.timedLyrics.map(line => line.text) : track.lyrics || [];
    lyrics.replaceChildren(...lyricLines.map((line, index) => {
      const lyric = document.createElement('p');
      lyric.textContent = line;
      lyric.dataset.lyricIndex = index;
      return lyric;
    }));
  };

  const selectTrack = (index, shouldPlay = false) => {
    currentIndex = (index + tracks.length) % tracks.length;
    const track = tracks[currentIndex];
    title.textContent = track.title || '未命名曲目';
    artist.textContent = track.artist || '';
    const coverPath = track.cover || '';
    const hasCover = Boolean(coverPath);
    cover.src = coverPath;
    record.classList.toggle('has-cover', hasCover);
    totalTime.textContent = track.duration || '--:--';
    progress.value = 0;
    currentTime.textContent = '0:00';
    audio.src = track.audio || '';
    activeLyricIndex = -1;
    renderLyrics();
    trackButtons.forEach(button => {
      button.classList.toggle('is-active', Number(button.dataset.trackIndex) === currentIndex);
      button.classList.remove('is-playing');
    });
    if (shouldPlay && audio.src) audio.play().catch(() => {});
  };

  cover.addEventListener('error', () => record.classList.remove('has-cover'));
  albumCovers.forEach(image => image.addEventListener('error', () => image.parentElement.classList.add('has-no-cover')));

  const togglePlay = () => {
    if (!audio.src) return;
    if (audio.paused) audio.play().catch(() => {}); else audio.pause();
  };

  const openModal = () => {
    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
    window.requestAnimationFrame(() => {
      modal.classList.add('is-open');
      player.classList.add('is-revealed');
    });
    closeButton.focus();
  };

  const closeModal = () => {
    audio.pause();
    modal.classList.remove('is-open');
    player.classList.remove('is-revealed');
    modal.setAttribute('aria-hidden', 'true');
    trackButtons.forEach(button => button.classList.remove('is-active'));
    trackButtons[currentIndex].focus();
    window.setTimeout(() => { modal.hidden = true; }, 360);
  };

  playButton.addEventListener('click', togglePlay);
  player.querySelector('.music-player__previous').addEventListener('click', () => selectTrack(currentIndex - 1, true));
  player.querySelector('.music-player__next').addEventListener('click', () => selectTrack(currentIndex + 1, true));
  trackButtons.forEach(button => button.addEventListener('click', () => {
    const index = Number(button.dataset.trackIndex);
    selectTrack(index, true);
    button.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    window.setTimeout(openModal, 720);
  }));
  albumGrid.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const direction = event.key === 'ArrowLeft' ? -1 : 1;
      currentIndex = (currentIndex + direction + tracks.length) % tracks.length;
      trackButtons.forEach(button => button.classList.remove('is-active'));
      trackButtons[currentIndex].scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    } else {
      selectTrack(currentIndex, true);
      window.setTimeout(openModal, 720);
    }
  });
  albumShelf.addEventListener('wheel', event => {
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    event.preventDefault();
    albumShelf.scrollLeft += event.deltaY;
  });
  albumShelf.addEventListener('scroll', queueShelfPerspective, { passive: true });
  window.addEventListener('resize', queueShelfPerspective, { passive: true });
  closeButton.addEventListener('click', closeModal);
  modal.addEventListener('click', event => { if (event.target === modal) closeModal(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !modal.hidden) closeModal(); });
  audio.addEventListener('play', () => { player.classList.add('is-playing'); trackButtons[currentIndex].classList.add('is-playing'); playButton.textContent = 'Ⅱ'; playButton.setAttribute('aria-label', '暂停'); });
  audio.addEventListener('pause', () => { player.classList.remove('is-playing'); trackButtons[currentIndex].classList.remove('is-playing'); playButton.textContent = '▶'; playButton.setAttribute('aria-label', '播放'); });
  audio.addEventListener('timeupdate', () => {
    progress.value = audio.duration ? audio.currentTime / audio.duration * 100 : 0;
    currentTime.textContent = formatTime(audio.currentTime);
    const timedLyrics = tracks[currentIndex].timedLyrics || [];
    const activeIndex = timedLyrics.length
      ? timedLyrics.reduce((current, line, index) => line.time <= audio.currentTime ? index : current, 0)
      : Math.min(Math.floor((audio.currentTime / Math.max(audio.duration, 1)) * lyrics.children.length), lyrics.children.length - 1);
    [...lyrics.children].forEach((line, index) => line.classList.toggle('is-active', index === activeIndex));
    if (activeIndex !== activeLyricIndex && lyrics.children[activeIndex]) {
      lyrics.children[activeIndex].scrollIntoView({ block: 'center', behavior: 'smooth' });
      activeLyricIndex = activeIndex;
    }
  });
  audio.addEventListener('loadedmetadata', () => { totalTime.textContent = formatTime(audio.duration); });
  audio.addEventListener('ended', () => selectTrack(currentIndex + 1, true));
  progress.addEventListener('input', () => { if (audio.duration) audio.currentTime = audio.duration * progress.value / 100; });
  selectTrack(0);
  trackButtons.forEach(button => button.classList.remove('is-active'));
  updateShelfPerspective();
})();
