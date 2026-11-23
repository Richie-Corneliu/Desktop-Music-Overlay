const THEME_LABELS = {
  dynamic: 'Dynamic',
  vivid: 'Vivid',
  minimal: 'Minimal',
  monochrome: 'Mono',
};

const SLEEP_PRESETS_MIN = [0, 30, 60, 90];
const SVG_NS = 'http://www.w3.org/2000/svg';

function createSvgIcon(paths, viewBox = '0 0 24 24', stroke = true) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  if (stroke) {
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
  } else {
    svg.setAttribute('fill', 'currentColor');
  }

  for (const def of paths) {
    const el = document.createElementNS(SVG_NS, def.tag || 'path');
    for (const [k, v] of Object.entries(def)) {
      if (k === 'tag') continue;
      el.setAttribute(k, String(v));
    }
    svg.appendChild(el);
  }
  return svg;
}

function formatCountdown(remainingMs) {
  const totalSec = Math.max(0, Math.ceil(remainingMs / 1000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export class VinylDock {
  constructor({
    rootEl,
    triggerEl,
    vinylDiscEl,
    vinylCoverEl,
    drawerEl,
    trackTitleEl,
    trackArtistEl,
    btnPrev,
    btnPlayPause,
    btnNext,
    btnRefreshLyrics,
    btnThemeMode,
    themeBadgeEl,
    btnLayoutLock,
    btnHideOverlay,
    btnToggleClock,
    clockStyleBtns,
    edgeModeBtns,
    sliderNightBrightness,
    nightBrightnessValEl,
    btnSleepTimer,
    sleepCountdownEl,
    btnResetLayout,
    tabRecent,
    tabPinned,
    historyListEl,
    onCommand,
    onCycleTheme,
    onToggleLock,
    onToggleClock,
    onSelectClockStyle,
    onSelectEdgeMode,
    onChangeBrightness,
    onSleepExpire,
    onWakeFromSleep,
    onResetLayout,
    onHideOverlay,
  }) {
    this.rootEl = rootEl;
    this.triggerEl = triggerEl;
    this.vinylDiscEl = vinylDiscEl;
    this.vinylCoverEl = vinylCoverEl;
    this.drawerEl = drawerEl;
    this.trackTitleEl = trackTitleEl;
    this.trackArtistEl = trackArtistEl;

    this.btnPrev = btnPrev;
    this.btnPlayPause = btnPlayPause;
    this.btnNext = btnNext;
    this.btnRefreshLyrics = btnRefreshLyrics;
    this.btnThemeMode = btnThemeMode;
    this.themeBadgeEl = themeBadgeEl;
    this.btnLayoutLock = btnLayoutLock;
    this.btnHideOverlay = btnHideOverlay;
    this.btnToggleClock = btnToggleClock;
    this.clockStyleBtns = Array.isArray(clockStyleBtns) ? clockStyleBtns : [];
    this.edgeModeBtns = Array.isArray(edgeModeBtns) ? edgeModeBtns : [];
    this.sliderNightBrightness = sliderNightBrightness;
    this.nightBrightnessValEl = nightBrightnessValEl;
    this.btnSleepTimer = btnSleepTimer;
    this.sleepCountdownEl = sleepCountdownEl;
    this.btnResetLayout = btnResetLayout;
    this.tabRecent = tabRecent;
    this.tabPinned = tabPinned;
    this.historyListEl = historyListEl;

    this.onCommand = onCommand;
    this.onCycleTheme = onCycleTheme;
    this.onToggleLock = onToggleLock;
    this.onToggleClock = onToggleClock;
    this.onSelectClockStyle = onSelectClockStyle;
    this.onSelectEdgeMode = onSelectEdgeMode;
    this.onChangeBrightness = onChangeBrightness;
    this.onSleepExpire = onSleepExpire;
    this.onWakeFromSleep = onWakeFromSleep;
    this.onResetLayout = onResetLayout;
    this.onHideOverlay = onHideOverlay;

    this._isHoverOpen = false;
    this._isPinnedOpen = false;
    this._closeTimer = null;
    this._activeTab = 'recent';
    this._media = null;
    this._history = { recent: [], pinned: [] };
    this._isPlaying = false;

    this._sleepPresetIdx = 0;
    this._sleepEndMs = 0;
    this._sleepTickTimer = null;

    this._bindEvents();
    this._renderPlaybackIcon();
    this._renderLockIcon(false);
    this._renderSleepState();
    this._renderHistory();
  }

  _isDrawerOpen() {
    return this._isHoverOpen || this._isPinnedOpen;
  }

  _syncDrawerVisibility() {
    const open = this._isDrawerOpen();
    this.drawerEl.hidden = !open;
    this.drawerEl.classList.toggle('is-open', open);
    this.triggerEl.setAttribute('aria-expanded', String(open));
  }

  _clearCloseTimer() {
    if (this._closeTimer !== null) {
      clearTimeout(this._closeTimer);
      this._closeTimer = null;
    }
  }

  close() {
    this._clearCloseTimer();
    this._isHoverOpen = false;
    this._isPinnedOpen = false;
    this._syncDrawerVisibility();
  }

  setMedia(media) {
    this._media = media || null;
    const playing = this._media?.playback_status === 'playing';
    this._isPlaying = playing;
    this.vinylDiscEl.classList.toggle('is-playing', playing);

    const thumb = this._media?.thumbnail || '';
    if (thumb) {
      if (this.vinylCoverEl.getAttribute('src') !== thumb) {
        this.vinylCoverEl.src = thumb;
      }
      this.vinylCoverEl.classList.add('is-loaded');
    } else {
      this.vinylCoverEl.removeAttribute('src');
      this.vinylCoverEl.classList.remove('is-loaded');
    }

    if (this._media) {
      this.trackTitleEl.textContent = this._media.title || 'Untitled track';
      this.trackArtistEl.textContent = this._media.artist || 'Unknown artist';
    } else {
      this.trackTitleEl.textContent = 'No active media';
      this.trackArtistEl.textContent = 'Waiting for playback';
    }

    this._renderPlaybackIcon();
    this._renderHistory();
  }

  setHistory(payload) {
    this._history = {
      recent: Array.isArray(payload?.recent) ? payload.recent : [],
      pinned: Array.isArray(payload?.pinned) ? payload.pinned : [],
    };
    this.tabRecent.textContent = `Recent (${this._history.recent.length})`;
    this.tabPinned.textContent = `Pinned (${this._history.pinned.length})`;
    this._renderHistory();
  }

  syncLayoutState(snapshot) {
    if (!snapshot) return;
    const unlocked = Boolean(snapshot.isEditMode);
    this.btnLayoutLock.setAttribute('aria-pressed', String(unlocked));
    this.btnLayoutLock.classList.toggle('is-active', unlocked);
    this.btnLayoutLock.setAttribute(
      'aria-label',
      unlocked ? 'Lock layout positions' : 'Unlock layout to drag and scale'
    );
    this.btnLayoutLock.title = unlocked ? 'Lock layout' : 'Unlock layout (drag & wheel)';
    this._renderLockIcon(unlocked);

    const clockVisible = Boolean(snapshot.clock?.visible);
    this.btnToggleClock.setAttribute('aria-checked', String(clockVisible));
    this.btnToggleClock.classList.toggle('is-on', clockVisible);

    const clockStyle = snapshot.clockStyle || 'editorial';
    for (const btn of this.clockStyleBtns) {
      const active = btn.dataset.clockStyle === clockStyle;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', String(active));
    }

    const edgeMode = snapshot.edgeGlow || 'dynamic';
    for (const btn of this.edgeModeBtns) {
      const active = btn.dataset.edgeMode === edgeMode;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', String(active));
    }

    const brightness = Number.isFinite(snapshot.nightBrightness)
      ? snapshot.nightBrightness
      : 100;
    if (this.sliderNightBrightness) {
      this.sliderNightBrightness.value = String(brightness);
    }
    if (this.nightBrightnessValEl) {
      this.nightBrightnessValEl.textContent = `${brightness}%`;
    }

    const themeLabel = THEME_LABELS[snapshot.themeMode] || 'Dynamic';
    this.themeBadgeEl.textContent = themeLabel;
    this.btnThemeMode.title = `Glow theme: ${themeLabel}`;
  }

  _stopSleepInterval() {
    if (this._sleepTickTimer !== null) {
      clearInterval(this._sleepTickTimer);
      this._sleepTickTimer = null;
    }
  }

  _cycleSleepTimer() {
    this.onWakeFromSleep?.();
    this._sleepPresetIdx = (this._sleepPresetIdx + 1) % SLEEP_PRESETS_MIN.length;
    const minutes = SLEEP_PRESETS_MIN[this._sleepPresetIdx];
    this._stopSleepInterval();

    if (minutes === 0) {
      this._sleepEndMs = 0;
      this._renderSleepState();
      return;
    }

    this._sleepEndMs = Date.now() + minutes * 60_000;
    this._renderSleepState();
    this._sleepTickTimer = setInterval(() => this._tickSleepTimer(), 1000);
  }

  _tickSleepTimer() {
    if (this._sleepEndMs <= 0) {
      this._stopSleepInterval();
      return;
    }
    const remaining = this._sleepEndMs - Date.now();
    if (remaining <= 0) {
      this._stopSleepInterval();
      this._sleepPresetIdx = 0;
      this._sleepEndMs = 0;
      this._renderSleepState('Dimmed');
      this.onCommand?.('pause');
      this.onSleepExpire?.();
      return;
    }
    this._renderSleepState();
  }

  _renderSleepState(overrideText = null) {
    if (!this.btnSleepTimer || !this.sleepCountdownEl) return;
    const active = this._sleepEndMs > 0;
    this.btnSleepTimer.classList.toggle('is-active', active);

    if (overrideText) {
      this.sleepCountdownEl.textContent = overrideText;
      this.sleepCountdownEl.classList.remove('is-counting');
      return;
    }

    if (!active) {
      this.sleepCountdownEl.textContent = 'Off';
      this.sleepCountdownEl.classList.remove('is-counting');
      return;
    }

    this.sleepCountdownEl.textContent = formatCountdown(this._sleepEndMs - Date.now());
    this.sleepCountdownEl.classList.add('is-counting');
  }

  _renderPlaybackIcon() {
    const icon = this._isPlaying
      ? createSvgIcon(
          [
            { tag: 'rect', x: 6, y: 5, width: 4, height: 14, rx: 1 },
            { tag: 'rect', x: 14, y: 5, width: 4, height: 14, rx: 1 },
          ],
          '0 0 24 24',
          false
        )
      : createSvgIcon(
          [{ tag: 'polygon', points: '7,5 19,12 7,19' }],
          '0 0 24 24',
          false
        );

    this.btnPlayPause.replaceChildren(icon);
    this.btnPlayPause.setAttribute('aria-label', this._isPlaying ? 'Pause' : 'Play');
  }

  _renderLockIcon(unlocked) {
    const icon = unlocked
      ? createSvgIcon([
          { tag: 'rect', x: 5, y: 11, width: 14, height: 10, rx: 2 },
          { d: 'M7 11V7a5 5 0 0 1 9.33-2.5' },
        ])
      : createSvgIcon([
          { tag: 'rect', x: 5, y: 11, width: 14, height: 10, rx: 2 },
          { d: 'M7 11V7a5 5 0 0 1 10 0v4' },
        ]);
    this.btnLayoutLock.replaceChildren(icon);
  }

  _renderHistory() {
    const items =
      this._activeTab === 'pinned' ? this._history.pinned : this._history.recent;

    if (items.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'history-empty';
      empty.textContent =
        this._activeTab === 'pinned'
          ? 'No pinned tracks yet. Pin a track from Recent.'
          : 'No recently played tracks yet.';
      this.historyListEl.replaceChildren(empty);
      return;
    }

    const activeId = this._media?.track_id || null;
    const frag = document.createDocumentFragment();

    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'history-item';
      if (item.track_id === activeId) {
        row.classList.add('is-current');
      }

      const mainBtn = document.createElement('button');
      mainBtn.type = 'button';
      mainBtn.className = 'history-item-main';
      mainBtn.setAttribute(
        'aria-label',
        item.track_id === activeId
          ? `Toggle playback for ${item.title}`
          : `${item.pinned ? 'Unpin' : 'Pin'} ${item.title}`
      );
      mainBtn.addEventListener('click', () => {
        if (item.track_id === activeId) {
          this.onWakeFromSleep?.();
          this.onCommand?.('play_pause');
        } else {
          this.onCommand?.('toggle_pin', { track_id: item.track_id });
        }
      });

      const thumbWrap = document.createElement('div');
      thumbWrap.className = 'history-thumb-wrap';
      if (item.thumbnail) {
        const img = document.createElement('img');
        img.className = 'history-thumb';
        img.src = item.thumbnail;
        img.alt = '';
        img.width = 34;
        img.height = 34;
        img.decoding = 'async';
        thumbWrap.appendChild(img);
      } else {
        const fallback = document.createElement('div');
        fallback.className = 'history-thumb-fallback';
        thumbWrap.appendChild(fallback);
      }

      const meta = document.createElement('div');
      meta.className = 'history-meta';
      const title = document.createElement('span');
      title.className = 'history-title';
      title.textContent = item.title || 'Untitled track';
      const artist = document.createElement('span');
      artist.className = 'history-artist';
      artist.textContent = item.artist || 'Unknown artist';
      meta.append(title, artist);

      mainBtn.append(thumbWrap, meta);

      const pinBtn = document.createElement('button');
      pinBtn.type = 'button';
      pinBtn.className = 'history-pin-btn';
      pinBtn.classList.toggle('is-pinned', Boolean(item.pinned));
      pinBtn.setAttribute('aria-pressed', String(Boolean(item.pinned)));
      pinBtn.setAttribute(
        'aria-label',
        item.pinned ? `Unpin ${item.title}` : `Pin ${item.title}`
      );
      pinBtn.title = item.pinned ? 'Unpin track' : 'Pin track';
      pinBtn.appendChild(
        createSvgIcon(
          [
            {
              tag: 'polygon',
              points:
                '12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2',
            },
          ],
          '0 0 24 24',
          !item.pinned
        )
      );
      pinBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onCommand?.('toggle_pin', { track_id: item.track_id });
      });

      row.append(mainBtn, pinBtn);
      frag.appendChild(row);
    }

    this.historyListEl.replaceChildren(frag);
  }

  _bindEvents() {
    this.rootEl.addEventListener('mouseenter', () => {
      this._clearCloseTimer();
      this._isHoverOpen = true;
      this._syncDrawerVisibility();
    });

    this.rootEl.addEventListener('mouseleave', () => {
      this._isHoverOpen = false;
      this._clearCloseTimer();
      this._closeTimer = setTimeout(() => {
        this._closeTimer = null;
        this._syncDrawerVisibility();
      }, 260);
    });

    this.triggerEl.addEventListener('click', () => {
      this._clearCloseTimer();
      if (this._isPinnedOpen) {
        this._isPinnedOpen = false;
        this._isHoverOpen = false;
      } else {
        this._isPinnedOpen = true;
      }
      this._syncDrawerVisibility();
    });

    this.btnPrev.addEventListener('click', () => {
      this.onWakeFromSleep?.();
      this.onCommand?.('prev');
    });
    this.btnPlayPause.addEventListener('click', () => {
      this.onWakeFromSleep?.();
      this.onCommand?.('play_pause');
    });
    this.btnNext.addEventListener('click', () => {
      this.onWakeFromSleep?.();
      this.onCommand?.('next');
    });

    this.btnRefreshLyrics.addEventListener('click', () => {
      this.onCommand?.('refresh_lyrics');
      this.btnRefreshLyrics.classList.remove('is-spinning');
      void this.btnRefreshLyrics.offsetWidth;
      this.btnRefreshLyrics.classList.add('is-spinning');
      setTimeout(() => this.btnRefreshLyrics.classList.remove('is-spinning'), 650);
    });

    this.btnThemeMode.addEventListener('click', () => this.onCycleTheme?.());
    this.btnLayoutLock.addEventListener('click', () => this.onToggleLock?.());
    this.btnHideOverlay.addEventListener('click', () => this.onHideOverlay?.());
    this.btnToggleClock.addEventListener('click', () => this.onToggleClock?.());
    this.btnResetLayout.addEventListener('click', () => this.onResetLayout?.());

    for (const btn of this.clockStyleBtns) {
      btn.addEventListener('click', () => {
        this.onSelectClockStyle?.(btn.dataset.clockStyle);
      });
    }

    for (const btn of this.edgeModeBtns) {
      btn.addEventListener('click', () => {
        this.onSelectEdgeMode?.(btn.dataset.edgeMode);
      });
    }

    this.sliderNightBrightness?.addEventListener('input', (e) => {
      this.onWakeFromSleep?.();
      const val = Number(e.target.value);
      if (this.nightBrightnessValEl) {
        this.nightBrightnessValEl.textContent = `${Math.round(val)}%`;
      }
      this.onChangeBrightness?.(val);
    });

    this.btnSleepTimer?.addEventListener('click', () => this._cycleSleepTimer());

    const switchTab = (tab) => {
      this._activeTab = tab;
      const isRecent = tab === 'recent';
      this.tabRecent.classList.toggle('is-active', isRecent);
      this.tabRecent.setAttribute('aria-selected', String(isRecent));
      this.tabPinned.classList.toggle('is-active', !isRecent);
      this.tabPinned.setAttribute('aria-selected', String(!isRecent));
      this._renderHistory();
    };

    this.tabRecent.addEventListener('click', () => switchTab('recent'));
    this.tabPinned.addEventListener('click', () => switchTab('pinned'));
  }
}
