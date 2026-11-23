import '@fontsource/montserrat/200.css';
import '@fontsource/montserrat/300.css';
import '@fontsource/montserrat/500.css';
import '@fontsource/montserrat/700.css';
import '@fontsource/montserrat/800.css';
import '@fontsource/montserrat/900.css';
import './styles/main.css';

import { MinimalClock } from './clock.js';
import { extractPaletteFromSource, IDLE_PALETTE } from './color-extractor.js';
import { VinylDock } from './dock.js';
import { LayoutManager } from './layout-manager.js';
import { KineticLyricsView } from './lyrics-view.js';
import { CircularVisualizer } from './visualizer.js';
import { OverlayWSClient } from './ws-client.js';

const screenEdgeGlow = document.getElementById('screen-edge-glow');
const edgeBloomFrame = document.getElementById('edge-bloom-frame');
const edgeInsetRim = document.getElementById('edge-inset-rim');
const edgeConicRotors = Array.from(
  document.querySelectorAll('#edge-bloom-frame .edge-conic-rotor'),
);
const lyricsRegion = document.getElementById('lyrics-region');
const lyricsStage = document.getElementById('lyrics-stage');
const clockRegion = document.getElementById('clock-region');
const clockTime = document.getElementById('clock-time');
const clockDate = document.getElementById('clock-date');
const visualizerRegion = document.getElementById('visualizer-region');
const visualizerCanvas = document.getElementById('visualizer-canvas');
const coverShell = document.getElementById('cover-shell');
const coverImage = document.getElementById('cover-image');
const trackCaption = document.getElementById('track-caption');
const trackTitle = document.getElementById('track-title');
const trackArtist = document.getElementById('track-artist');

const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let edgeGlowMode = 'dynamic';
let nightBrightnessPct = 100;
let sleepDimActive = false;
let lastEdgeRgbKey = '';
let lastEdgeOrbitKey = '';
let lastEdgePulseKey = -1;
let lastBloomOpKey = -1;
let lastRimOpKey = -1;
let lastGlowFrame = {
  primary: { ...IDLE_PALETTE.primary },
  secondary: { ...IDLE_PALETTE.secondary },
  tertiary: { ...IDLE_PALETTE.tertiary },
  orbitDeg: 0,
  bassEnergy: 0,
  midHighEnergy: 0,
  kickPunch: 0,
  edgePulse: 0,
  punch: 0,
  isActive: false,
  themeMode: 'dynamic',
};

function setLayerOpacity(el, value, prevKey) {
  const clamped = Math.min(1, Math.max(0, value));
  const key = Math.round(clamped * 200);
  if (key === prevKey) return prevKey;
  if (el) {
    el.style.opacity = clamped.toFixed(3);
  }
  return key;
}

function quantizeRgb(c) {
  return {
    r: c.r & ~1,
    g: c.g & ~1,
    b: c.b & ~1,
  };
}

const EDGE_OPACITY_PRESETS = {
  dynamic: {
    idle: [0.13, 0.14],
    active: (pulse) => [0.14 + pulse * 0.84, 0.16 + pulse * 0.84],
  },
  vivid: {
    idle: [0.16, 0.18],
    active: (pulse) => [0.16 + pulse * 0.84, 0.18 + pulse * 0.82],
  },
  monochrome: {
    idle: [0.11, 0.12],
    active: (pulse) => [0.12 + pulse * 0.72, 0.13 + pulse * 0.75],
  },
};

function applyOverlayBrightness() {
  const base = Math.min(1, Math.max(0.25, nightBrightnessPct / 100));
  const effective = sleepDimActive ? Math.min(0.2, base * 0.25) : base;
  document.documentElement.style.setProperty('--overlay-brightness', effective.toFixed(3));
}

function updateScreenEdgeGlow(frame) {
  lastGlowFrame = frame;
  if (!screenEdgeGlow) return;

  const {
    primary,
    secondary,
    tertiary,
    orbitDeg,
    edgePulse,
    isActive,
    themeMode,
  } = frame;
  const off = edgeGlowMode === 'off';
  screenEdgeGlow.classList.toggle('is-disabled', off);

  if (off) {
    lastBloomOpKey = setLayerOpacity(edgeBloomFrame, 0, lastBloomOpKey);
    lastRimOpKey = setLayerOpacity(edgeInsetRim, 0, lastRimOpKey);
    if (lastEdgePulseKey !== 0) {
      lastEdgePulseKey = 0;
      screenEdgeGlow.style.setProperty('--beat-pulse', '0');
    }
    return;
  }

  const c1 = quantizeRgb(primary || IDLE_PALETTE.primary);
  const c2 = quantizeRgb(secondary || IDLE_PALETTE.secondary);
  const c3 = quantizeRgb(tertiary || IDLE_PALETTE.tertiary);

  const rgbKey = `${c1.r},${c1.g},${c1.b}|${c2.r},${c2.g},${c2.b}|${c3.r},${c3.g},${c3.b}`;
  if (rgbKey !== lastEdgeRgbKey) {
    lastEdgeRgbKey = rgbKey;
    screenEdgeGlow.style.setProperty('--c1-r', String(c1.r));
    screenEdgeGlow.style.setProperty('--c1-g', String(c1.g));
    screenEdgeGlow.style.setProperty('--c1-b', String(c1.b));
    screenEdgeGlow.style.setProperty('--c2-r', String(c2.r));
    screenEdgeGlow.style.setProperty('--c2-g', String(c2.g));
    screenEdgeGlow.style.setProperty('--c2-b', String(c2.b));
    screenEdgeGlow.style.setProperty('--c3-r', String(c3.r));
    screenEdgeGlow.style.setProperty('--c3-g', String(c3.g));
    screenEdgeGlow.style.setProperty('--c3-b', String(c3.b));
  }

  const isMinimalist = edgeGlowMode === 'minimalist';
  const targetOrbit = isMinimalist
    ? (performance.now() * 0.008) % 360
    : orbitDeg || 0;
  const degText = prefersReducedMotion ? '0.0deg' : `${targetOrbit.toFixed(1)}deg`;
  if (degText !== lastEdgeOrbitKey) {
    lastEdgeOrbitKey = degText;
    const tf = `translate(-50%, -50%) rotate(${degText})`;
    for (let i = 0; i < edgeConicRotors.length; i++) {
      edgeConicRotors[i].style.transform = tf;
    }
  }

  if (isMinimalist) {
    if (lastEdgePulseKey !== 22) {
      lastEdgePulseKey = 22;
      screenEdgeGlow.style.setProperty('--beat-pulse', '0.22');
    }
    const minBloom = isActive ? 0.28 : 0.16;
    const minRim = isActive ? 0.24 : 0.14;
    lastBloomOpKey = setLayerOpacity(edgeBloomFrame, minBloom, lastBloomOpKey);
    lastRimOpKey = setLayerOpacity(edgeInsetRim, minRim, lastRimOpKey);
    return;
  }

  const rawPulse = prefersReducedMotion || !isActive
    ? 0
    : Math.min(1, Math.max(0, edgePulse || 0));
  const pulseKey = Math.round(rawPulse * 100);
  if (pulseKey !== lastEdgePulseKey) {
    lastEdgePulseKey = pulseKey;
    screenEdgeGlow.style.setProperty('--beat-pulse', (pulseKey / 100).toFixed(2));
  }

  const preset = EDGE_OPACITY_PRESETS[themeMode] || EDGE_OPACITY_PRESETS.dynamic;
  const [bloomOp, rimOp] = isActive ? preset.active(rawPulse) : preset.idle;

  lastBloomOpKey = setLayerOpacity(edgeBloomFrame, bloomOp, lastBloomOpKey);
  lastRimOpKey = setLayerOpacity(edgeInsetRim, rimOp, lastRimOpKey);
}

const clock = new MinimalClock(clockRegion, clockTime, clockDate);
clock.start();

const visualizer = new CircularVisualizer(visualizerCanvas, coverShell, {
  onGlowFrame: updateScreenEdgeGlow,
});
const lyricsView = new KineticLyricsView(lyricsRegion, lyricsStage);

let isConnected = false;
let currentMedia = null;
let currentThumbSrc = '';
let currentColorSignature = '';
let lastExtractedThumbSrc = '';
let paletteExtractSeq = 0;
let audioActive = false;
let overlayVisible = true;
let isOccluded = false;
let rafId = null;
let lastFrameRenderMs = 0;
let forceImmediateFrame = true;
let isDraggingLayout = false;

// Click-through forwarding: allow clicks only when cursor hovers an .interactive element or during layout drag
let lastIgnoreMouse = true;
let lastClientX = -1;
let lastClientY = -1;

function setIgnoreMouse(ignore) {
  const next = isDraggingLayout ? false : Boolean(ignore);
  if (next === lastIgnoreMouse) return;
  lastIgnoreMouse = next;
  window.overlayAPI?.setIgnoreMouseEvents(next);
}

document.addEventListener('mousemove', (event) => {
  lastClientX = event.clientX;
  lastClientY = event.clientY;
  if (isDraggingLayout) {
    setIgnoreMouse(false);
    return;
  }
  const overInteractive = Boolean(event.target?.closest?.('.interactive'));
  setIgnoreMouse(!overInteractive);
});

document.addEventListener('mouseleave', () => setIgnoreMouse(true));
window.addEventListener('blur', () => {
  if (!isDraggingLayout) setIgnoreMouse(true);
});

function updateCaption() {
  if (!isConnected) {
    trackCaption.classList.add('is-idle');
    trackTitle.textContent = 'Backend offline';
    trackArtist.textContent = 'Reconnecting to ws://127.0.0.1:8765';
    return;
  }

  if (!currentMedia) {
    trackCaption.classList.add('is-idle');
    trackTitle.textContent = 'No active media';
    trackArtist.textContent = 'Play audio to visualize';
    return;
  }

  trackCaption.classList.remove('is-idle');
  trackTitle.textContent = currentMedia.title || 'Untitled track';
  trackArtist.textContent = currentMedia.artist || 'Unknown artist';
}

async function runPaletteExtraction(src) {
  const seq = ++paletteExtractSeq;
  lastExtractedThumbSrc = src;
  const palette = await extractPaletteFromSource(src);
  if (seq !== paletteExtractSeq) return;
  visualizer.setTargetPalette(palette);
  requestRender();
}

function updateCover(media) {
  const nextThumb = media?.thumbnail || '';
  const hasMedia = Boolean(media);
  coverShell.classList.toggle('is-idle', !hasMedia || !nextThumb);

  const colorSig = media
    ? `${media.title || ''}::${media.artist || ''}::${nextThumb.length}::${nextThumb.slice(0, 48)}::${nextThumb.slice(-48)}`
    : '';
  const colorNeedsUpdate = colorSig !== currentColorSignature;
  currentColorSignature = colorSig;

  if (!nextThumb) {
    currentThumbSrc = '';
    lastExtractedThumbSrc = '';
    paletteExtractSeq += 1;
    coverImage.removeAttribute('src');
    coverImage.alt = '';
    coverImage.classList.remove('is-loaded');
    visualizer.setCoverImage(null);
    visualizer.setTargetPalette(IDLE_PALETTE);
    requestRender();
    return;
  }

  coverImage.alt = media.title ? `${media.title} album cover` : 'Album cover';
  if (colorNeedsUpdate) {
    void runPaletteExtraction(nextThumb);
  }
  if (nextThumb === currentThumbSrc) return;
  currentThumbSrc = nextThumb;
  coverImage.classList.remove('is-loaded');
  coverImage.src = nextThumb;
}

coverImage.addEventListener('load', () => {
  const activeSrc = coverImage.currentSrc || coverImage.getAttribute('src') || '';
  if (!activeSrc) return;
  coverImage.classList.add('is-loaded');
  visualizer.setCoverImage(coverImage);
  requestRender();
  if (activeSrc !== lastExtractedThumbSrc) {
    void runPaletteExtraction(activeSrc);
  }
});

coverImage.addEventListener('error', () => {
  coverImage.classList.remove('is-loaded');
  paletteExtractSeq += 1;
  visualizer.setCoverImage(null);
  visualizer.setTargetPalette(IDLE_PALETTE);
  requestRender();
});

const wsClient = new OverlayWSClient({
  url: 'ws://127.0.0.1:8765',
  onConnectionChange(connected) {
    isConnected = connected;
    if (connected) {
      console.info('[overlay] ws connected');
      if (!overlayVisible || isOccluded) {
        wsClient.setAudioPaused(true);
      }
    } else {
      currentMedia = null;
      audioActive = false;
      visualizer.setPlaybackState(false);
      visualizer.updateAudio(null, false);
      lyricsView.setHasActiveMedia(false);
      dock.setMedia(null);
      updateCover(null);
    }
    updateCaption();
    requestRender();
  },
  onState(media) {
    currentMedia = media;
    const isPlaying = media?.playback_status === 'playing';
    visualizer.setPlaybackState(isPlaying);
    lyricsView.setHasActiveMedia(Boolean(media));
    dock.setMedia(media);
    updateCover(media);
    updateCaption();
    if (media) {
      lyricsView.updatePosition(wsClient.getPosition());
    }
    requestRender();
  },
  onPosition() {
    if (currentMedia && overlayVisible && !isOccluded) {
      lyricsView.updatePosition(wsClient.getPosition());
    }
  },
  onAudio(frame) {
    const nextActive =
      Boolean(frame?.active) &&
      (Number(frame?.energy || 0) > 0.001 || Number(frame?.peak || 0) > 0.008);
    const shouldWake = nextActive || audioActive;
    audioActive = nextActive;
    visualizer.updateAudio(frame?.bins, Boolean(frame?.active));
    if (shouldWake) {
      requestRender(false);
    }
  },
  onLyrics(payload) {
    lyricsView.setLyrics(payload, Boolean(currentMedia));
    if (currentMedia) {
      lyricsView.updatePosition(wsClient.getPosition());
    }
  },
  onHistory(payload) {
    dock.setHistory(payload);
  },
});

const dock = new VinylDock({
  rootEl: document.getElementById('dock-root'),
  triggerEl: document.getElementById('vinyl-trigger'),
  vinylDiscEl: document.getElementById('vinyl-disc'),
  vinylCoverEl: document.getElementById('vinyl-cover'),
  drawerEl: document.getElementById('dock-drawer'),
  trackTitleEl: document.getElementById('dock-track-title'),
  trackArtistEl: document.getElementById('dock-track-artist'),
  btnPrev: document.getElementById('btn-prev'),
  btnPlayPause: document.getElementById('btn-play-pause'),
  btnNext: document.getElementById('btn-next'),
  btnRefreshLyrics: document.getElementById('btn-refresh-lyrics'),
  btnThemeMode: document.getElementById('btn-theme-mode'),
  themeBadgeEl: document.getElementById('theme-mode-badge'),
  btnLayoutLock: document.getElementById('btn-layout-lock'),
  btnHideOverlay: document.getElementById('btn-hide-overlay'),
  btnToggleClock: document.getElementById('btn-toggle-clock'),
  clockStyleBtns: Array.from(document.querySelectorAll('[data-clock-style].seg-btn')),
  edgeModeBtns: Array.from(document.querySelectorAll('[data-edge-mode].seg-btn')),
  sliderNightBrightness: document.getElementById('slider-night-brightness'),
  nightBrightnessValEl: document.getElementById('night-brightness-value'),
  btnSleepTimer: document.getElementById('btn-sleep-timer'),
  sleepCountdownEl: document.getElementById('sleep-timer-countdown'),
  btnResetLayout: document.getElementById('btn-reset-layout'),
  tabRecent: document.getElementById('tab-recent'),
  tabPinned: document.getElementById('tab-pinned'),
  historyListEl: document.getElementById('history-list'),
  onCommand(action, extra) {
    wsClient.sendCommand(action, extra);
  },
  onCycleTheme() {
    layoutManager.cycleThemeMode();
  },
  onToggleLock() {
    layoutManager.toggleEditMode();
  },
  onToggleClock() {
    layoutManager.toggleClockVisible();
  },
  onSelectClockStyle(style) {
    layoutManager.setClockStyle(style);
  },
  onSelectEdgeMode(mode) {
    layoutManager.setEdgeGlowMode(mode);
  },
  onChangeBrightness(pct) {
    layoutManager.setNightBrightness(pct);
  },
  onSleepExpire() {
    sleepDimActive = true;
    applyOverlayBrightness();
  },
  onWakeFromSleep() {
    if (sleepDimActive) {
      sleepDimActive = false;
      applyOverlayBrightness();
    }
  },
  onResetLayout() {
    layoutManager.resetLayout();
  },
  onHideOverlay() {
    window.overlayAPI?.hideOverlay();
  },
});

const layoutManager = new LayoutManager({
  widgets: {
    visualizer: visualizerRegion,
    lyrics: lyricsRegion,
    clock: clockRegion,
  },
  onVisualizerScale(scale) {
    visualizer.setCssScale(scale);
    requestRender();
  },
  onThemeChange(mode) {
    visualizer.setThemeMode(mode);
    requestRender();
  },
  onEdgeGlowChange(mode) {
    edgeGlowMode = ['off', 'minimalist', 'dynamic'].includes(mode) ? mode : 'dynamic';
    visualizer.setEdgeGlowMode(edgeGlowMode);
    updateScreenEdgeGlow(lastGlowFrame);
    requestRender();
  },
  onClockStyleChange(style) {
    clock.setStyle(style);
  },
  onBrightnessChange(pct) {
    nightBrightnessPct = Number.isFinite(pct) ? pct : 100;
    applyOverlayBrightness();
  },
  onEditModeChange(unlocked) {
    lyricsView.setEditPreview(unlocked);
  },
  onDragStateChange(dragging) {
    isDraggingLayout = dragging;
    if (dragging) {
      setIgnoreMouse(false);
    } else {
      const el =
        lastClientX >= 0 && lastClientY >= 0
          ? document.elementFromPoint(lastClientX, lastClientY)
          : null;
      setIgnoreMouse(!Boolean(el?.closest?.('.interactive')));
    }
  },
  onStateChange(snapshot) {
    dock.syncLayoutState(snapshot);
  },
});

dock.syncLayoutState(layoutManager.getSnapshot());

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    dock.close();
    if (layoutManager.isEditMode) {
      layoutManager.setEditMode(false);
    }
  }
});

function getTargetFrameIntervalMs() {
  if (edgeGlowMode === 'minimalist' || nightBrightnessPct < 70 || sleepDimActive) {
    return 1000 / 30;
  }
  return 1000 / 60;
}

function renderFrame(nowMs) {
  rafId = null;
  if (!overlayVisible || isOccluded) return;

  const minIntervalMs = getTargetFrameIntervalMs();
  const elapsedMs = nowMs - lastFrameRenderMs;
  if (!forceImmediateFrame && lastFrameRenderMs > 0 && elapsedMs < minIntervalMs - 2.5) {
    rafId = requestAnimationFrame(renderFrame);
    return;
  }

  forceImmediateFrame = false;
  lastFrameRenderMs = nowMs;

  const isPlaying = currentMedia?.playback_status === 'playing';
  if (isPlaying) {
    lyricsView.updatePosition(wsClient.getPosition(nowMs));
  }

  visualizer.render(nowMs);

  const shouldContinue = isPlaying || audioActive || !visualizer.isSettled();
  if (shouldContinue) {
    rafId = requestAnimationFrame(renderFrame);
  }
}

function requestRender(immediate = true) {
  if (!overlayVisible || isOccluded) return;
  if (immediate) {
    forceImmediateFrame = true;
  }
  if (rafId !== null) return;
  rafId = requestAnimationFrame(renderFrame);
}

function syncOverlayRuntimeState() {
  const paused = !overlayVisible || isOccluded;
  document.body.classList.toggle('is-occluded', paused);
  if (paused) {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    wsClient.setAudioPaused(true);
  } else {
    wsClient.setAudioPaused(false);
    requestRender(true);
  }
}

window.overlayAPI?.onVisibilityChange((visible) => {
  overlayVisible = Boolean(visible);
  if (!overlayVisible) {
    dock.close();
    if (layoutManager.isEditMode) {
      layoutManager.setEditMode(false);
    }
  }
  syncOverlayRuntimeState();
});

window.overlayAPI?.onOcclusionChange?.((occluded) => {
  const next = Boolean(occluded);
  if (next === isOccluded) return;
  isOccluded = next;
  syncOverlayRuntimeState();
});

window.addEventListener('resize', () => {
  layoutManager.handleViewportResize();
  visualizer.resize();
  requestRender();
});

updateCaption();
requestRender();
wsClient.connect();
