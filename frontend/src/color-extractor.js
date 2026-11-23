/** Default understated cool-slate palette when idle or cover decode fails. */
export const IDLE_GLOW_COLOR = { r: 132, g: 144, b: 168 };

export const IDLE_PALETTE = {
  primary: { r: 132, g: 144, b: 168 },
  secondary: { r: 96, g: 108, b: 132 },
  tertiary: { r: 156, g: 166, b: 188 },
};

const SAMPLE_SIZE = 40;
const HUE_BINS = 24;
const MIN_HUE_SEPARATION = 0.07; // ~25 degrees on [0..1] hue circle

let offscreenCanvas = null;
let offscreenCtx = null;

function getOffscreenContext() {
  if (!offscreenCanvas) {
    offscreenCanvas = document.createElement('canvas');
    offscreenCanvas.width = SAMPLE_SIZE;
    offscreenCanvas.height = SAMPLE_SIZE;
    offscreenCtx = offscreenCanvas.getContext('2d', { willReadFrequently: true });
  }
  return offscreenCtx;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function rgbToHsl(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;

  if (max === min) {
    return { h: 0, s: 0, l };
  }

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;

  if (max === rn) {
    h = (gn - bn) / d + (gn < bn ? 6 : 0);
  } else if (max === gn) {
    h = (bn - rn) / d + 2;
  } else {
    h = (rn - gn) / d + 4;
  }

  return { h: h / 6, s, l };
}

function hueToChannel(p, q, t) {
  let wrapped = t;
  if (wrapped < 0) wrapped += 1;
  if (wrapped > 1) wrapped -= 1;
  if (wrapped < 1 / 6) return p + (q - p) * 6 * wrapped;
  if (wrapped < 1 / 2) return q;
  if (wrapped < 2 / 3) return p + (q - p) * (2 / 3 - wrapped) * 6;
  return p;
}

function hslToRgb(h, s, l) {
  if (s <= 0.001) {
    const v = Math.round(clamp01(l) * 255);
    return { r: v, g: v, b: v };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: Math.round(hueToChannel(p, q, h + 1 / 3) * 255),
    g: Math.round(hueToChannel(p, q, h) * 255),
    b: Math.round(hueToChannel(p, q, h - 1 / 3) * 255),
  };
}

function hueDistance(h1, h2) {
  const diff = Math.abs(h1 - h2);
  return Math.min(diff, 1 - diff);
}

/**
 * Refine saturation and lightness into deep vivid tones while strictly preserving natural hue.
 */
function refineCoverColor(h, rawS, rawL, lightOffset = 0, satScale = 1) {
  const baseSat = rawS < 0.06
    ? Math.min(rawS * 1.15, 0.14)
    : Math.max(0.84, Math.min(0.98, rawS * 1.32));
  const minSat = rawS < 0.06 ? 0 : 0.78;
  const s = clamp01(Math.max(minSat, Math.min(0.98, baseSat * satScale)));

  // Keep lightness in rich deep band (0.34 - 0.50) to avoid washed-out pastel glow on HDR/4K TVs
  const centerL = Math.max(0.38, Math.min(0.47, 0.36 + rawL * 0.14));
  const l = Math.max(0.34, Math.min(0.50, centerL + lightOffset * 0.55));

  return hslToRgb(h, s, l);
}

function cloneIdlePalette() {
  return {
    primary: { ...IDLE_PALETTE.primary },
    secondary: { ...IDLE_PALETTE.secondary },
    tertiary: { ...IDLE_PALETTE.tertiary },
  };
}

function extractBucketHsl(bucket) {
  const r = bucket.rSum / bucket.weightSum;
  const g = bucket.gSum / bucket.weightSum;
  const b = bucket.bSum / bucket.weightSum;
  return rgbToHsl(r, g, b);
}

/**
 * Extract 2 to 3 authentic cover colors preserving natural hues.
 * Falls back to tonal variations of the cover's own hue when fewer hues exist.
 */
export function extractVibrantPalette(imgElement) {
  if (!imgElement || !imgElement.complete || imgElement.naturalWidth === 0) {
    return cloneIdlePalette();
  }

  try {
    const ctx = getOffscreenContext();
    if (!ctx) return cloneIdlePalette();

    ctx.clearRect(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
    ctx.drawImage(imgElement, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
    const { data } = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);

    const bins = Array.from({ length: HUE_BINS }, () => ({
      weightSum: 0,
      rSum: 0,
      gSum: 0,
      bSum: 0,
    }));

    let achromaticWeight = 0;
    let achromaticLSum = 0;

    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 96) continue;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const { h, s, l } = rgbToHsl(r, g, b);

      if (l < 0.05 || l > 0.96) continue;

      if (s < 0.06) {
        achromaticWeight += 1;
        achromaticLSum += l;
        continue;
      }

      const binIndex = Math.floor(h * HUE_BINS) % HUE_BINS;
      const salience = (0.35 + s * 1.65) * (1 - Math.abs(l - 0.5) * 0.45);
      const bin = bins[binIndex];
      bin.weightSum += salience;
      bin.rSum += r * salience;
      bin.gSum += g * salience;
      bin.bSum += b * salience;
    }

    const sortedBins = bins
      .filter((bin) => bin.weightSum > 0)
      .map((bin) => ({ ...bin, hsl: extractBucketHsl(bin) }))
      .sort((a, b) => b.weightSum - a.weightSum);

    if (sortedBins.length === 0) {
      if (achromaticWeight === 0) return cloneIdlePalette();
      const avgL = Math.max(0.46, Math.min(0.68, achromaticLSum / achromaticWeight));
      return {
        primary: hslToRgb(0.6, 0.08, avgL),
        secondary: hslToRgb(0.6, 0.08, Math.max(0.38, avgL - 0.11)),
        tertiary: hslToRgb(0.6, 0.06, Math.min(0.76, avgL + 0.11)),
      };
    }

    const minSignificantWeight = sortedBins[0].weightSum * 0.06;
    const chosen = [sortedBins[0].hsl];

    for (let i = 1; i < sortedBins.length && chosen.length < 3; i++) {
      const candidate = sortedBins[i];
      if (candidate.weightSum < minSignificantWeight) break;
      const distinct = chosen.every(
        (existing) => hueDistance(existing.h, candidate.hsl.h) >= MIN_HUE_SEPARATION,
      );
      if (distinct) {
        chosen.push(candidate.hsl);
      }
    }

    const c1 = chosen[0];
    const primary = refineCoverColor(c1.h, c1.s, c1.l, 0, 1);

    if (chosen.length === 1) {
      return {
        primary,
        secondary: refineCoverColor(c1.h, c1.s, c1.l, -0.09, 0.88),
        tertiary: refineCoverColor(c1.h, c1.s, c1.l, 0.10, 0.92),
      };
    }

    const c2 = chosen[1];
    const secondary = refineCoverColor(c2.h, c2.s, c2.l, 0, 1);

    if (chosen.length === 2) {
      return {
        primary,
        secondary,
        tertiary: refineCoverColor(c1.h, c1.s, c1.l, 0.08, 0.88),
      };
    }

    const c3 = chosen[2];
    return {
      primary,
      secondary,
      tertiary: refineCoverColor(c3.h, c3.s, c3.l, 0, 1),
    };
  } catch {
    return cloneIdlePalette();
  }
}

/**
 * Decode an image URL/data-URL on an offscreen Image before extracting its palette.
 * Prevents reading an unpopulated canvas before image decode finishes.
 */
export async function extractPaletteFromSource(src) {
  if (!src) {
    return cloneIdlePalette();
  }

  const probe = new Image();
  probe.crossOrigin = 'anonymous';

  try {
    const loaded = await new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      probe.addEventListener('load', () => finish(true), { once: true });
      probe.addEventListener('error', () => finish(false), { once: true });
      probe.src = src;
      if (probe.complete && probe.naturalWidth > 0) {
        finish(true);
      }
    });

    if (!loaded) {
      return cloneIdlePalette();
    }

    if (typeof probe.decode === 'function') {
      await probe.decode().catch(() => {});
    }

    if (probe.naturalWidth === 0) {
      return cloneIdlePalette();
    }

    return extractVibrantPalette(probe);
  } catch {
    return cloneIdlePalette();
  }
}

export function extractDominantColor(imgElement) {
  return extractVibrantPalette(imgElement).primary;
}
