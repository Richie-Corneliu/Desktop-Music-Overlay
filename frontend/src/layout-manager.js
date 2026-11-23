const STORAGE_KEY = 'music-overlay-config-v1';
const WIDGET_NAMES = ['visualizer', 'lyrics', 'clock'];
const THEME_MODES = ['dynamic', 'vivid', 'minimal', 'monochrome'];
const CLOCK_STYLES = ['editorial', 'stacked', 'minimal'];
const EDGE_GLOW_MODES = ['off', 'minimalist', 'dynamic'];
const MIN_SCALE = 0.5;
const MAX_SCALE = 2.0;
const MIN_BRIGHTNESS = 25;
const MAX_BRIGHTNESS = 100;
const BURN_IN_INTERVAL_MS = 180_000;
const BURN_IN_OFFSETS = [
  [0, 0],
  [2, 1],
  [3, 0],
  [2, -2],
  [0, -3],
  [-2, -2],
  [-3, 0],
  [-2, 2],
];

const WIDGET_LABELS = {
  visualizer: 'VISUALIZER',
  lyrics: 'LYRICS',
  clock: 'CLOCK',
};

function clamp(val, min, max) {
  return Math.min(max, Math.max(min, val));
}

function getDefaults(vw = window.innerWidth, vh = window.innerHeight) {
  const width = Math.max(640, vw || 1920);
  const height = Math.max(480, vh || 1080);
  return {
    visualizer: {
      x: Math.round(width / 2),
      y: Math.round(height / 2),
      scale: 1,
      visible: true,
    },
    lyrics: {
      x: Math.round(Math.max(220, width * 0.12)),
      y: 64,
      scale: 1,
      visible: true,
    },
    clock: {
      x: Math.round(Math.max(24, width - 220)),
      y: 64,
      scale: 1,
      visible: true,
    },
    themeMode: 'dynamic',
    edgeGlow: 'dynamic',
    clockStyle: 'editorial',
    nightBrightness: 100,
  };
}

export class LayoutManager {
  constructor({
    widgets,
    onVisualizerScale,
    onThemeChange,
    onEdgeGlowChange,
    onClockStyleChange,
    onBrightnessChange,
    onEditModeChange,
    onDragStateChange,
    onStateChange,
  } = {}) {
    this.widgets = widgets || {};
    this.onVisualizerScale = onVisualizerScale;
    this.onThemeChange = onThemeChange;
    this.onEdgeGlowChange = onEdgeGlowChange;
    this.onClockStyleChange = onClockStyleChange;
    this.onBrightnessChange = onBrightnessChange;
    this.onEditModeChange = onEditModeChange;
    this.onDragStateChange = onDragStateChange;
    this.onStateChange = onStateChange;

    this.isEditMode = false;
    this._drag = null;
    this._wheelSaveTimer = null;
    this._burnInStep = 0;
    this._burnInTimer = null;
    this.state = this._load();

    this._bindEvents();
    this._startAntiBurnIn();
    this.applyAll();
  }

  _clampWidgetPos(name, x, y) {
    const vw = Math.max(640, window.innerWidth || 1920);
    const vh = Math.max(480, window.innerHeight || 1080);
    if (name === 'visualizer') {
      return {
        x: Math.round(clamp(x, 80, vw - 80)),
        y: Math.round(clamp(y, 80, vh - 80)),
      };
    }
    if (name === 'clock') {
      return {
        x: Math.round(clamp(x, 16, Math.max(16, vw - 110))),
        y: Math.round(clamp(y, 16, Math.max(16, vh - 60))),
      };
    }
    return {
      x: Math.round(clamp(x, 16, Math.max(16, vw - 160))),
      y: Math.round(clamp(y, 16, Math.max(16, vh - 80))),
    };
  }

  _load() {
    const defaults = getDefaults();
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaults;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return defaults;

      const rawEdgeGlow = parsed.edgeGlow;
      let edgeGlowMode = defaults.edgeGlow;
      if (EDGE_GLOW_MODES.includes(rawEdgeGlow)) {
        edgeGlowMode = rawEdgeGlow;
      } else if (typeof rawEdgeGlow === 'boolean') {
        edgeGlowMode = rawEdgeGlow ? 'dynamic' : 'off';
      }

      const rawBrightness = Number(parsed.nightBrightness);
      const nightBrightness = Number.isFinite(rawBrightness)
        ? Math.round(clamp(rawBrightness, MIN_BRIGHTNESS, MAX_BRIGHTNESS))
        : defaults.nightBrightness;

      const merged = {
        ...defaults,
        themeMode: THEME_MODES.includes(parsed.themeMode)
          ? parsed.themeMode
          : defaults.themeMode,
        edgeGlow: edgeGlowMode,
        clockStyle: CLOCK_STYLES.includes(parsed.clockStyle)
          ? parsed.clockStyle
          : defaults.clockStyle,
        nightBrightness,
      };

      for (const name of WIDGET_NAMES) {
        const saved = parsed[name];
        const base = defaults[name];
        if (!saved || typeof saved !== 'object') continue;

        const rawX = Number.isFinite(Number(saved.x)) ? Number(saved.x) : base.x;
        const rawY = Number.isFinite(Number(saved.y)) ? Number(saved.y) : base.y;
        const pos = this._clampWidgetPos(name, rawX, rawY);
        const scale = Number.isFinite(Number(saved.scale))
          ? clamp(Number(saved.scale), MIN_SCALE, MAX_SCALE)
          : base.scale;
        const visible = typeof saved.visible === 'boolean' ? saved.visible : base.visible;

        merged[name] = {
          x: pos.x,
          y: pos.y,
          scale: Math.round(scale * 100) / 100,
          visible,
        };
      }
      return merged;
    } catch {
      return defaults;
    }
  }

  _save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      // Ignore storage quota errors
    }
  }

  _getBurnInOffset(name) {
    if (this.isEditMode) return [0, 0];
    const idx = name === 'clock' ? this._burnInStep : (this._burnInStep + 3) % BURN_IN_OFFSETS.length;
    return BURN_IN_OFFSETS[idx];
  }

  _startAntiBurnIn() {
    if (this._burnInTimer !== null) return;
    this._burnInTimer = setInterval(() => {
      this._burnInStep = (this._burnInStep + 1) % BURN_IN_OFFSETS.length;
      if (this.isEditMode) return;
      for (const name of WIDGET_NAMES) {
        this._applyWidget(name);
      }
    }, BURN_IN_INTERVAL_MS);
  }

  _applyWidget(name) {
    const el = this.widgets[name];
    const cfg = this.state[name];
    if (!el || !cfg) return;

    const pos = this._clampWidgetPos(name, cfg.x, cfg.y);
    cfg.x = pos.x;
    cfg.y = pos.y;

    const [ox, oy] = this._getBurnInOffset(name);
    el.style.left = `${cfg.x}px`;
    el.style.top = `${cfg.y}px`;

    if (name === 'visualizer') {
      el.style.transform = `translate(calc(-50% + ${ox}px), calc(-50% + ${oy}px)) scale(${cfg.scale})`;
      this.onVisualizerScale?.(cfg.scale);
    } else {
      el.style.transform = `translate(${ox}px, ${oy}px) scale(${cfg.scale})`;
    }

    el.classList.toggle('is-user-hidden', !cfg.visible);

    const badge = el.querySelector('.widget-badge');
    if (badge) {
      badge.textContent = `${WIDGET_LABELS[name]} ${Math.round(cfg.scale * 100)}%`;
    }
  }

  applyAll() {
    for (const name of WIDGET_NAMES) {
      this._applyWidget(name);
    }
    this.onThemeChange?.(this.state.themeMode);
    this.onEdgeGlowChange?.(this.state.edgeGlow);
    this.onClockStyleChange?.(this.state.clockStyle);
    this.onBrightnessChange?.(this.state.nightBrightness);
    this.onStateChange?.(this.getSnapshot());
  }

  getSnapshot() {
    return {
      isEditMode: this.isEditMode,
      themeMode: this.state.themeMode,
      edgeGlow: this.state.edgeGlow,
      clockStyle: this.state.clockStyle,
      nightBrightness: this.state.nightBrightness,
      visualizer: { ...this.state.visualizer },
      lyrics: { ...this.state.lyrics },
      clock: { ...this.state.clock },
    };
  }

  setEditMode(unlocked) {
    const next = Boolean(unlocked);
    if (next === this.isEditMode) return;
    this.isEditMode = next;

    document.body.classList.toggle('is-layout-editing', next);
    for (const name of WIDGET_NAMES) {
      const el = this.widgets[name];
      if (!el) continue;
      el.classList.toggle('interactive', next);
      if (!next) {
        el.classList.remove('is-dragging');
      }
      this._applyWidget(name);
    }

    if (!next && this._drag) {
      this._drag = null;
      this.onDragStateChange?.(false);
    }

    this.onEditModeChange?.(next);
    this.onStateChange?.(this.getSnapshot());
  }

  toggleEditMode() {
    this.setEditMode(!this.isEditMode);
    return this.isEditMode;
  }

  setWidgetVisible(name, visible) {
    if (!this.state[name]) return;
    this.state[name].visible = Boolean(visible);
    this._applyWidget(name);
    this._save();
    this.onStateChange?.(this.getSnapshot());
  }

  toggleClockVisible() {
    const next = !this.state.clock.visible;
    this.setWidgetVisible('clock', next);
    return next;
  }

  setEdgeGlowMode(mode) {
    let next = 'dynamic';
    if (EDGE_GLOW_MODES.includes(mode)) {
      next = mode;
    } else if (typeof mode === 'boolean') {
      next = mode ? 'dynamic' : 'off';
    }
    this.state.edgeGlow = next;
    this._save();
    this.onEdgeGlowChange?.(next);
    this.onStateChange?.(this.getSnapshot());
    return next;
  }

  setEdgeGlow(enabled) {
    return this.setEdgeGlowMode(enabled);
  }

  toggleEdgeGlow() {
    const idx = EDGE_GLOW_MODES.indexOf(this.state.edgeGlow);
    const next = EDGE_GLOW_MODES[(idx + 1) % EDGE_GLOW_MODES.length];
    return this.setEdgeGlowMode(next);
  }

  setClockStyle(style) {
    const next = CLOCK_STYLES.includes(style) ? style : 'editorial';
    this.state.clockStyle = next;
    this._save();
    this.onClockStyleChange?.(next);
    this.onStateChange?.(this.getSnapshot());
    return next;
  }

  setNightBrightness(pct) {
    const val = Number(pct);
    const next = Number.isFinite(val)
      ? Math.round(clamp(val, MIN_BRIGHTNESS, MAX_BRIGHTNESS))
      : 100;
    this.state.nightBrightness = next;
    this._save();
    this.onBrightnessChange?.(next);
    this.onStateChange?.(this.getSnapshot());
    return next;
  }

  destroy() {
    if (this._burnInTimer !== null) {
      clearInterval(this._burnInTimer);
      this._burnInTimer = null;
    }
  }

  setThemeMode(mode) {
    const next = THEME_MODES.includes(mode) ? mode : 'dynamic';
    this.state.themeMode = next;
    this._save();
    this.onThemeChange?.(next);
    this.onStateChange?.(this.getSnapshot());
  }

  cycleThemeMode() {
    const idx = THEME_MODES.indexOf(this.state.themeMode);
    const next = THEME_MODES[(idx + 1) % THEME_MODES.length];
    this.setThemeMode(next);
    return next;
  }

  resetLayout() {
    const defaults = getDefaults();
    for (const name of WIDGET_NAMES) {
      this.state[name] = { ...defaults[name] };
    }
    this.applyAll();
    this._save();
  }

  handleViewportResize() {
    for (const name of WIDGET_NAMES) {
      this._applyWidget(name);
    }
  }

  _bindEvents() {
    for (const name of WIDGET_NAMES) {
      const el = this.widgets[name];
      if (!el) continue;

      el.addEventListener('pointerdown', (e) => {
        if (!this.isEditMode || e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();

        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          // Ignore if capture unsupported
        }

        el.classList.add('is-dragging');
        this._drag = {
          name,
          pointerId: e.pointerId,
          startMouseX: e.clientX,
          startMouseY: e.clientY,
          startX: this.state[name].x,
          startY: this.state[name].y,
        };
        this.onDragStateChange?.(true);
      });

      el.addEventListener('pointermove', (e) => {
        if (!this._drag || this._drag.name !== name) return;
        const dx = e.clientX - this._drag.startMouseX;
        const dy = e.clientY - this._drag.startMouseY;
        const clamped = this._clampWidgetPos(
          name,
          this._drag.startX + dx,
          this._drag.startY + dy
        );
        this.state[name].x = clamped.x;
        this.state[name].y = clamped.y;
        this._applyWidget(name);
      });

      const endDrag = (e) => {
        if (!this._drag || this._drag.name !== name) return;
        el.classList.remove('is-dragging');
        try {
          if (el.hasPointerCapture?.(e.pointerId)) {
            el.releasePointerCapture(e.pointerId);
          }
        } catch {
          // Ignore
        }
        this._drag = null;
        this.onDragStateChange?.(false);
        this._save();
      };

      el.addEventListener('pointerup', endDrag);
      el.addEventListener('pointercancel', endDrag);

      el.addEventListener(
        'wheel',
        (e) => {
          if (!this.isEditMode) return;
          e.preventDefault();
          e.stopPropagation();
          const step = e.deltaY < 0 ? 0.06 : -0.06;
          const nextScale = clamp(this.state[name].scale + step, MIN_SCALE, MAX_SCALE);
          this.state[name].scale = Math.round(nextScale * 100) / 100;
          this._applyWidget(name);
          this.onStateChange?.(this.getSnapshot());

          if (this._wheelSaveTimer !== null) {
            clearTimeout(this._wheelSaveTimer);
          }
          this._wheelSaveTimer = setTimeout(() => {
            this._wheelSaveTimer = null;
            this._save();
          }, 180);
        },
        { passive: false }
      );

      el.addEventListener('dblclick', (e) => {
        if (!this.isEditMode) return;
        e.preventDefault();
        const defaults = getDefaults();
        this.state[name] = {
          ...defaults[name],
          visible: this.state[name].visible,
        };
        this._applyWidget(name);
        this._save();
        this.onStateChange?.(this.getSnapshot());
      });
    }
  }
}
