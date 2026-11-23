import { IDLE_PALETTE } from './color-extractor.js';

const FFT_BIN_COUNT = 64;
const DISPLAY_BAR_COUNT = 128;
const TRANSITION_MS = 600;
const CANVAS_OVERSCAN_PX = 280; // Matches CSS inset: -140px on all four edges
const GLASS_RIM_WIDTH = 7.5; // 6-9px top-down crystal glass lip thickness

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function cloneColor(rgb) {
  return { r: rgb.r, g: rgb.g, b: rgb.b };
}

function clonePalette(palette) {
  return {
    primary: cloneColor(palette.primary),
    secondary: cloneColor(palette.secondary),
    tertiary: cloneColor(palette.tertiary),
  };
}

function lerpChannel(a, b, t) {
  return Math.round(a + (b - a) * t);
}

function lerpRgb(c1, c2, t) {
  return {
    r: lerpChannel(c1.r, c2.r, t),
    g: lerpChannel(c1.g, c2.g, t),
    b: lerpChannel(c1.b, c2.b, t),
  };
}

function toMonochromeRgb(rgb) {
  const lum = clamp(
    Math.round(0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b),
    158,
    240,
  );
  return { r: lum, g: lum, b: lum };
}

function rgba(rgb, alpha = 1) {
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${clamp(alpha, 0, 1).toFixed(4)})`;
}

function buildConicStops(ctx, cx, cy, angleRad, palette, alpha = 1) {
  const grad = ctx.createConicGradient(angleRad, cx, cy);
  grad.addColorStop(0, rgba(palette.primary, alpha));
  grad.addColorStop(0.33, rgba(palette.secondary, alpha));
  grad.addColorStop(0.67, rgba(palette.tertiary, alpha));
  grad.addColorStop(1, rgba(palette.primary, alpha));
  return grad;
}

/**
 * High-DPI Canvas circular audio visualizer with upright HD album cover,
 * top-down 3D crystal glass rim, and crisp rotating 128-bar radial spectrum.
 */
export class CircularVisualizer {
  constructor(canvasElement, coverShell = null, { onGlowFrame = null } = {}) {
    this._canvas = canvasElement;
    this._ctx = canvasElement.getContext('2d');
    this._coverShell = coverShell;
    this._onGlowFrame = typeof onGlowFrame === 'function' ? onGlowFrame : null;

    this._width = 640;
    this._height = 640;
    this._coverRadius = 86;
    this._cssScale = 1;

    this._bins = new Float32Array(FFT_BIN_COUNT);
    this._themeMode = 'dynamic';
    this._edgeGlowMode = 'dynamic';
    this._isPlaying = false;
    this._audioActive = false;
    this._reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    this._bassEnergy = 0;
    this._midHighEnergy = 0;
    this._kickPunch = 0;
    this._punch = 0;
    this._prevSubBass = 0;
    this._edgeSubBass = 0;
    this._edgeKick = 0;
    this._edgePulse = 0;
    this._prevEdgeSub = 0;
    this._orbitAngle = -Math.PI / 2;
    this._barsAngle = -Math.PI / 2;

    this._fromPalette = clonePalette(IDLE_PALETTE);
    this._toPalette = clonePalette(IDLE_PALETTE);
    this._currentPalette = clonePalette(IDLE_PALETTE);
    this._transitionStartMs = 0;
    this._inTransition = false;
    this._lastRenderMs = 0;

    this._coverBitmap = null;
    this._coverFallback = null;
    this._coverLoadSeq = 0;

    this.resize();
  }

  setCoverImage(imgElement) {
    this._coverLoadSeq += 1;
    const seq = this._coverLoadSeq;

    if (!imgElement || !imgElement.complete || imgElement.naturalWidth <= 0) {
      if (this._coverBitmap && typeof this._coverBitmap.close === 'function') {
        this._coverBitmap.close();
      }
      this._coverBitmap = null;
      this._coverFallback = null;
      return;
    }

    // Keep synchronous fallback drawable active until async ImageBitmap upgrade finishes
    this._coverFallback = imgElement;

    if (typeof createImageBitmap === 'function') {
      createImageBitmap(imgElement)
        .then((bitmap) => {
          if (seq !== this._coverLoadSeq) {
            if (typeof bitmap.close === 'function') bitmap.close();
            return;
          }
          if (this._coverBitmap && typeof this._coverBitmap.close === 'function') {
            this._coverBitmap.close();
          }
          this._coverBitmap = bitmap;
          this._coverFallback = null;
        })
        .catch(() => {
          // Retain HTMLImageElement fallback when createImageBitmap fails
        });
    }
  }

  setCssScale(scale) {
    const next = Number.isFinite(scale) && scale > 0 ? scale : 1;
    if (Math.abs(next - this._cssScale) > 0.01) {
      this._cssScale = next;
      this.resize();
    }
  }

  setThemeMode(mode) {
    this._themeMode = mode || 'dynamic';
  }

  setEdgeGlowMode(mode) {
    const next = ['off', 'minimalist', 'dynamic'].includes(mode) ? mode : 'dynamic';
    if (next === this._edgeGlowMode) return;
    this._edgeGlowMode = next;
    this.resize();
  }

  setTargetPalette(palette) {
    if (!palette || !palette.primary || !palette.secondary || !palette.tertiary) {
      return;
    }
    this._fromPalette = clonePalette(this._currentPalette);
    this._toPalette = clonePalette(palette);
    this._transitionStartMs = performance.now();
    this._inTransition = true;
  }

  setPlaybackState(isPlaying) {
    this._isPlaying = Boolean(isPlaying);
  }

  updateAudio(bins, active) {
    this._audioActive = Boolean(active);
    if (!bins || typeof bins.length !== 'number' || !this._audioActive) {
      return;
    }
    const count = Math.min(FFT_BIN_COUNT, bins.length);
    for (let i = 0; i < count; i++) {
      const val = bins[i];
      this._bins[i] = val > 0 ? (val < 1 ? val : 1) : 0;
    }
  }

  isSettled() {
    if (this._inTransition || this._isPlaying || this._audioActive) return false;
    if (
      this._bassEnergy > 0.004 ||
      this._kickPunch > 0.004 ||
      this._edgePulse > 0.004
    ) {
      return false;
    }
    for (let i = 0; i < FFT_BIN_COUNT; i++) {
      if (this._bins[i] > 0.004) return false;
    }
    return true;
  }

  resize() {
    if (!this._canvas || !this._ctx) return;

    const width = Math.max(240, this._canvas.clientWidth || 640);
    const height = Math.max(240, this._canvas.clientHeight || 640);
    const maxDpr = this._edgeGlowMode === 'dynamic' ? 1.5 : 1.25;
    const baseDpr = Math.max(1, window.devicePixelRatio || 1);
    const dpr = Math.min(maxDpr, baseDpr * Math.max(1, this._cssScale));

    this._width = width;
    this._height = height;

    const coverWidth = this._coverShell ? this._coverShell.clientWidth : 0;
    const innerSize = Math.max(180, Math.min(width, height) - CANVAS_OVERSCAN_PX);
    this._coverRadius = coverWidth > 0 ? coverWidth / 2 : innerSize * 0.22;

    this._canvas.width = Math.round(width * dpr);
    this._canvas.height = Math.round(height * dpr);
    this._ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  render(nowMs = performance.now()) {
    const dtSec = this._lastRenderMs > 0
      ? Math.min(0.05, Math.max(0, (nowMs - this._lastRenderMs) / 1000))
      : 0.016;
    this._lastRenderMs = nowMs;

    this._updateState(nowMs, dtSec);
    this._drawFrame();
  }

  _updateState(nowMs, dtSec) {
    if (this._inTransition) {
      const elapsed = Math.max(0, nowMs - this._transitionStartMs);
      const rawT = clamp(elapsed / TRANSITION_MS, 0, 1);
      const ease = 1 - Math.pow(1 - rawT, 3);
      this._currentPalette = {
        primary: lerpRgb(this._fromPalette.primary, this._toPalette.primary, ease),
        secondary: lerpRgb(this._fromPalette.secondary, this._toPalette.secondary, ease),
        tertiary: lerpRgb(this._fromPalette.tertiary, this._toPalette.tertiary, ease),
      };
      if (rawT >= 1) {
        this._inTransition = false;
      }
    }

    if (!this._audioActive) {
      for (let i = 0; i < FFT_BIN_COUNT; i++) {
        this._bins[i] *= 0.86;
        if (this._bins[i] < 0.002) this._bins[i] = 0;
      }
    }

    let subBassSum = 0;
    for (let i = 0; i < 5; i++) subBassSum += this._bins[i];
    const subBass = subBassSum / 5;

    let bassSum = 0;
    for (let i = 0; i < 11; i++) bassSum += this._bins[i];
    const bass = bassSum / 11;

    let midHighSum = 0;
    for (let i = 16; i < 48; i++) midHighSum += this._bins[i];
    const midHigh = midHighSum / 32;

    const bassDelta = Math.max(0, subBass - this._prevSubBass);
    this._prevSubBass = subBass;

    this._bassEnergy = this._bassEnergy * 0.76 + bass * 0.24;
    this._midHighEnergy = this._midHighEnergy * 0.75 + midHigh * 0.25;

    const impulse = bassDelta * 3.8 + Math.max(0, subBass - 0.48) * 0.85;
    this._kickPunch = Math.max(this._kickPunch * 0.84, clamp(impulse, 0, 1));
    this._punch = clamp(this._bassEnergy * 0.6 + this._kickPunch * 0.65, 0, 1);

    // Edge-only isolated 30-110Hz sub-bass + kick transient with exponential collapse
    let edgeSubSum = 0;
    for (let i = 0; i < 6; i++) edgeSubSum += this._bins[i];
    const rawEdgeSub = edgeSubSum / 6;
    const edgeDelta = Math.max(0, rawEdgeSub - this._prevEdgeSub);
    this._prevEdgeSub = rawEdgeSub;

    const gatedSub = Math.max(0, (rawEdgeSub - 0.14) / 0.86);
    const subExp = Math.pow(gatedSub, 2.2);
    const edgeAttack = 1 - Math.exp(-dtSec / 0.016);
    const edgeDecay = Math.exp(-dtSec / 0.068);
    if (subExp > this._edgeSubBass) {
      this._edgeSubBass += (subExp - this._edgeSubBass) * edgeAttack;
    } else {
      this._edgeSubBass *= edgeDecay;
    }

    const edgeTransient = clamp(edgeDelta * 5.2 + Math.max(0, subExp - 0.55) * 0.9, 0, 1);
    const kickDecay = Math.exp(-dtSec / 0.055);
    this._edgeKick = Math.max(this._edgeKick * kickDecay, edgeTransient);
    this._edgePulse = clamp(
      Math.max(this._edgeKick, this._edgeSubBass * 0.88) + this._edgeSubBass * 0.12,
      0,
      1,
    );

    if (!this._reducedMotion) {
      const active = this._isPlaying || this._audioActive;
      const orbitSpeed = active
        ? 0.26 + this._bassEnergy * 0.38 + this._kickPunch * 1.15
        : 0.08;
      this._orbitAngle = (this._orbitAngle + orbitSpeed * dtSec) % (Math.PI * 2);

      const barSpinSpeed = active
        ? 0.18 + this._bassEnergy * 0.22 + this._kickPunch * 0.65
        : 0.04;
      this._barsAngle = (this._barsAngle + barSpinSpeed * dtSec) % (Math.PI * 2);
    }
  }

  _getEffectivePalette() {
    if (this._themeMode === 'monochrome') {
      return {
        primary: toMonochromeRgb(this._currentPalette.primary),
        secondary: toMonochromeRgb(this._currentPalette.secondary),
        tertiary: toMonochromeRgb(this._currentPalette.tertiary),
      };
    }
    return this._currentPalette;
  }

  _getInterpolatedBar(barIndex) {
    const half = DISPLAY_BAR_COUNT / 2;
    const mirrorPos = barIndex < half ? barIndex : DISPLAY_BAR_COUNT - 1 - barIndex;
    const binFloat = (mirrorPos / (half - 1)) * (FFT_BIN_COUNT - 1);
    const lo = Math.floor(binFloat);
    const hi = Math.min(FFT_BIN_COUNT - 1, lo + 1);
    const frac = binFloat - lo;
    const center = this._bins[lo] * (1 - frac) + this._bins[hi] * frac;
    const prev = this._bins[Math.max(0, lo - 1)];
    const next = this._bins[Math.min(FFT_BIN_COUNT - 1, hi + 1)];
    return prev * 0.14 + center * 0.72 + next * 0.14;
  }

  _renderCoverArt(cx, cy, radius) {
    const source = this._coverBitmap || this._coverFallback;
    if (!source) return;

    const iw = source.naturalWidth ?? source.width ?? 0;
    const ih = source.naturalHeight ?? source.height ?? 0;
    if (iw <= 0 || ih <= 0) return;

    const ctx = this._ctx;
    const cropSize = Math.min(iw, ih);
    const sx = (iw - cropSize) * 0.5;
    const sy = (ih - cropSize) * 0.5;
    const r = Math.max(1, radius);

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, sx, sy, cropSize, cropSize, cx - r, cy - r, r * 2, r * 2);

    // Subtle inner concave rim shadow so cover sits recessed inside glass lip
    const innerShadowR = Math.max(1, r - 11);
    const wellGrad = ctx.createRadialGradient(cx, cy, innerShadowR, cx, cy, r);
    wellGrad.addColorStop(0.0, 'rgba(0, 0, 0, 0.0)');
    wellGrad.addColorStop(0.45, 'rgba(0, 0, 0, 0.08)');
    wellGrad.addColorStop(0.82, 'rgba(0, 0, 0, 0.28)');
    wellGrad.addColorStop(1.0, 'rgba(0, 0, 0, 0.56)');
    ctx.fillStyle = wellGrad;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    ctx.restore();
  }

  _drawSpecularArc(cx, cy, radius, centerAngle, halfSpan, lineWidth, rgb, peakAlpha) {
    const ctx = this._ctx;
    const startAngle = centerAngle - halfSpan;
    const endAngle = centerAngle + halfSpan;
    const fracSpan = (halfSpan * 2) / (Math.PI * 2);

    const arcGrad = ctx.createConicGradient(startAngle, cx, cy);
    arcGrad.addColorStop(0.0, rgba(rgb, 0));
    arcGrad.addColorStop(fracSpan * 0.22, rgba(rgb, peakAlpha * 0.45));
    arcGrad.addColorStop(fracSpan * 0.50, rgba(rgb, peakAlpha));
    arcGrad.addColorStop(fracSpan * 0.78, rgba(rgb, peakAlpha * 0.45));
    arcGrad.addColorStop(fracSpan, rgba(rgb, 0));
    arcGrad.addColorStop(1.0, rgba(rgb, 0));

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, startAngle, endAngle);
    ctx.lineCap = 'round';
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = arcGrad;
    ctx.stroke();
    ctx.restore();
  }

  _renderGlassRim(cx, cy, innerR, outerR, palette, isActive) {
    const ctx = this._ctx;
    const midR = (innerR + outerR) * 0.5;
    const thickness = outerR - innerR;
    const activeMul = isActive ? 1 : 0.65;
    const isMinimal = this._themeMode === 'minimal';

    const coolWhite = { r: 226, g: 240, b: 255 };
    const primaryGlass = lerpRgb(coolWhite, palette.primary, isMinimal ? 0.14 : 0.30);
    const secondaryGlass = lerpRgb(coolWhite, palette.secondary, isMinimal ? 0.14 : 0.36);

    // Semi-transparent 3D glass lip body tightly bounded between innerR and outerR
    const bodyGrad = ctx.createRadialGradient(cx, cy, innerR, cx, cy, outerR);
    bodyGrad.addColorStop(0.0, 'rgba(14, 18, 26, 0.38)');
    bodyGrad.addColorStop(0.24, rgba(primaryGlass, 0.18 * activeMul));
    bodyGrad.addColorStop(0.55, 'rgba(225, 238, 255, 0.11)');
    bodyGrad.addColorStop(0.84, rgba(secondaryGlass, 0.20 * activeMul));
    bodyGrad.addColorStop(1.0, 'rgba(12, 16, 22, 0.32)');

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, midR, 0, Math.PI * 2);
    ctx.lineWidth = thickness;
    ctx.strokeStyle = bodyGrad;
    ctx.stroke();

    // Thin, sharp inner bevel line
    ctx.beginPath();
    ctx.arc(cx, cy, innerR + 0.6, 0, Math.PI * 2);
    ctx.lineWidth = 1.1;
    ctx.strokeStyle = rgba(primaryGlass, (0.42 + this._punch * 0.16) * activeMul);
    ctx.stroke();

    // Thin, sharp outer bevel line tinted by rotating cover colors
    ctx.beginPath();
    ctx.arc(cx, cy, outerR - 0.5, 0, Math.PI * 2);
    ctx.lineWidth = 1.15;
    ctx.strokeStyle = buildConicStops(
      ctx,
      cx,
      cy,
      this._orbitAngle,
      lerpPaletteWithCrystal(palette, isMinimal ? 0.35 : 0.55),
      (0.46 + this._kickPunch * 0.24) * activeMul,
    );
    ctx.stroke();
    ctx.restore();

    // Opposing curved specular refraction arcs inside the glass channel
    const primaryArcAlpha = (isMinimal ? 0.42 : 0.68 + this._kickPunch * 0.20) * activeMul;
    const secondaryArcAlpha = (isMinimal ? 0.28 : 0.46 + this._kickPunch * 0.16) * activeMul;

    this._drawSpecularArc(cx, cy, midR - 0.3, -2.35, 0.62, 2.8, primaryGlass, primaryArcAlpha);
    this._drawSpecularArc(cx, cy, midR - 1.1, -2.35, 0.36, 1.0, { r: 248, g: 252, b: 255 }, primaryArcAlpha);

    this._drawSpecularArc(cx, cy, midR + 0.4, 0.79, 0.52, 2.4, secondaryGlass, secondaryArcAlpha);
    this._drawSpecularArc(cx, cy, midR + 1.1, 0.79, 0.30, 0.9, { r: 242, g: 248, b: 255 }, secondaryArcAlpha * 0.9);
  }

  _renderSpectrumBars(cx, cy, barStartR, maxSafeRadius, palette, isActive) {
    const ctx = this._ctx;
    const isMinimal = this._themeMode === 'minimal';
    const isVivid = this._themeMode === 'vivid';

    const availableSpan = Math.max(32, maxSafeRadius - barStartR - 6);
    const exponent = isVivid ? 1.45 : 1.55;
    const maxBarLen = Math.min(
      availableSpan,
      (isMinimal ? 48 : isVivid ? 92 : 76) + this._kickPunch * 12,
    );
    const baseWidth = clamp(1.75 + this._kickPunch * 0.35, 1.6, 2.2);
    const barGrad = buildConicStops(ctx, cx, cy, this._orbitAngle, palette, 1);

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineCap = 'round';

    const bars = [];
    for (let i = 0; i < DISPLAY_BAR_COUNT; i++) {
      const rawValue = this._getInterpolatedBar(i);
      const shaped = Math.pow(rawValue, exponent);
      const barLen = 3 + this._kickPunch * 2.5 + shaped * maxBarLen;
      const angle = this._barsAngle + (i / DISPLAY_BAR_COUNT) * Math.PI * 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      bars.push({
        rawValue,
        x1: cx + cos * barStartR,
        y1: cy + sin * barStartR,
        x2: cx + cos * (barStartR + barLen),
        y2: cy + sin * (barStartR + barLen),
      });
    }

    // Crisp primary 4K HD bar body
    ctx.strokeStyle = barGrad;
    ctx.lineWidth = baseWidth;
    ctx.globalAlpha = (isMinimal ? 0.80 : 0.96) * (isActive ? 1 : 0.48);
    ctx.beginPath();
    for (let i = 0; i < bars.length; i++) {
      ctx.moveTo(bars[i].x1, bars[i].y1);
      ctx.lineTo(bars[i].x2, bars[i].y2);
    }
    ctx.stroke();

    // Subtle crisp core highlight on strong peaks without halo blur
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.90)';
    ctx.lineWidth = baseWidth * 0.42;
    for (let i = 0; i < bars.length; i++) {
      if (bars[i].rawValue <= 0.46) continue;
      ctx.globalAlpha = Math.min(0.36, (bars[i].rawValue - 0.46) * 0.68);
      ctx.beginPath();
      ctx.moveTo(bars[i].x1, bars[i].y1);
      ctx.lineTo(bars[i].x2, bars[i].y2);
      ctx.stroke();
    }

    ctx.restore();
  }

  _drawFrame() {
    const ctx = this._ctx;
    if (!ctx) return;

    const w = this._width;
    const h = this._height;
    const cx = w / 2;
    const cy = h / 2;
    const palette = this._getEffectivePalette();
    const isActive = this._isPlaying || this._audioActive;

    // Pure transparent canvas outside cover, glass rim, and spectrum bars
    ctx.clearRect(0, 0, w, h);

    const maxSafeRadius = Math.min(w, h) * 0.48;
    const rimInnerR = this._coverRadius;
    const rimOuterR = rimInnerR + GLASS_RIM_WIDTH;
    const barStartR = rimOuterR + 4;

    // Upright HD album cover + recessed inner glass shadow
    this._renderCoverArt(cx, cy, rimInnerR);

    // Tightly bounded top-down crystal glass rim hugging cover perimeter
    this._renderGlassRim(cx, cy, rimInnerR, rimOuterR, palette, isActive);

    // Thin, razor-sharp 128-bar rotating spectrum
    this._renderSpectrumBars(cx, cy, barStartR, maxSafeRadius, palette, isActive);

    if (this._onGlowFrame) {
      this._onGlowFrame({
        primary: palette.primary,
        secondary: palette.secondary,
        tertiary: palette.tertiary,
        orbitDeg: ((this._orbitAngle * 180) / Math.PI) % 360,
        bassEnergy: this._bassEnergy,
        midHighEnergy: this._midHighEnergy,
        kickPunch: this._kickPunch,
        edgePulse: this._edgePulse,
        punch: this._punch,
        isActive,
        themeMode: this._themeMode,
      });
    }
  }
}

function lerpPaletteWithCrystal(palette, colorWeight) {
  const crystal = { r: 224, g: 238, b: 255 };
  return {
    primary: lerpRgb(crystal, palette.primary, colorWeight),
    secondary: lerpRgb(crystal, palette.secondary, colorWeight),
    tertiary: lerpRgb(crystal, palette.tertiary, colorWeight),
  };
}
