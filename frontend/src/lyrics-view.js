export class KineticLyricsView {
  constructor(regionEl, stageEl) {
    this.regionEl = regionEl;
    this.stageEl = stageEl;
    this._trackId = null;
    this._lines = [];
    this._activeIndex = -1;
    this._nodes = new Map();
    this._hasActiveMedia = false;
    this._editPreview = false;
    this._previewEl = null;
  }

  setEditPreview(enabled) {
    this._editPreview = Boolean(enabled);
    this._syncVisibility();
  }

  setLyrics(payload, hasActiveMedia = true) {
    this._hasActiveMedia = Boolean(hasActiveMedia);
    const nextTrackId = payload?.track_id || null;
    const nextLines =
      payload?.status === 'synced' && Array.isArray(payload.lines) ? payload.lines : [];

    const sameTrack = nextTrackId === this._trackId;
    const sameLength = nextLines.length === this._lines.length;
    if (sameTrack && sameLength && nextLines.length === 0) {
      this._syncVisibility();
      return;
    }

    this._trackId = nextTrackId;
    this._lines = nextLines;
    this._activeIndex = -1;
    this._clearStage();
    this._syncVisibility();
  }

  setHasActiveMedia(hasActiveMedia) {
    this._hasActiveMedia = Boolean(hasActiveMedia);
    if (!this._hasActiveMedia) {
      this._activeIndex = -1;
      this._clearStage();
    }
    this._syncVisibility();
  }

  _clearStage() {
    this._nodes.clear();
    this._previewEl = null;
    this.stageEl.replaceChildren();
  }

  _ensurePreviewEl() {
    if (this._previewEl) return this._previewEl;
    const box = document.createElement('div');
    box.className = 'lyrics-preview-placeholder';
    const title = document.createElement('p');
    title.className = 'lyric-line is-active';
    title.textContent = 'Lyrics Zone';
    const sub = document.createElement('p');
    sub.className = 'lyrics-preview-sub';
    sub.textContent = 'Drag to reposition · Scroll to scale';
    box.append(title, sub);
    this._previewEl = box;
    return box;
  }

  _syncVisibility() {
    const hasSynced = this._hasActiveMedia && this._lines.length > 0;
    if (!hasSynced && this._editPreview) {
      const preview = this._ensurePreviewEl();
      if (preview.parentNode !== this.stageEl) {
        this.stageEl.appendChild(preview);
      }
      this.regionEl.classList.remove('is-hidden');
      return;
    }

    if (this._previewEl) {
      this._previewEl.remove();
      this._previewEl = null;
    }
    this.regionEl.classList.toggle('is-hidden', !hasSynced);
  }

  _findLineIndex(positionSec) {
    const lines = this._lines;
    if (lines.length === 0) return -1;

    const target = positionSec + 0.06;
    if (target < lines[0].time) return -1;

    let lo = 0;
    let hi = lines.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].time <= target) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans;
  }

  updatePosition(positionSec) {
    if (!this._hasActiveMedia || this._lines.length === 0) return;

    const nextIdx = this._findLineIndex(positionSec);
    if (nextIdx === this._activeIndex) return;

    const prevIdx = this._activeIndex;
    const isJump = prevIdx < 0 || Math.abs(nextIdx - prevIdx) > 1;
    this._activeIndex = nextIdx;

    if (nextIdx < 0) {
      this._clearStage();
      this._syncVisibility();
      return;
    }

    if (isJump) {
      this._clearStage();
    } else if (this._previewEl) {
      this._previewEl.remove();
      this._previewEl = null;
    }

    // Balanced 3-row window: Past (index - 1) -> Now (index) -> Upcoming (index + 1)
    const minKeep = Math.max(0, nextIdx - 1);
    const maxKeep = Math.min(this._lines.length - 1, nextIdx + 1);
    const keepIndices = new Set();
    for (let idx = minKeep; idx <= maxKeep; idx += 1) {
      keepIndices.add(idx);
    }

    for (const [idx, el] of this._nodes.entries()) {
      if (!keepIndices.has(idx)) {
        this._nodes.delete(idx);
        el.remove();
      }
    }

    const orderedNodes = [];
    for (let idx = minKeep; idx <= maxKeep; idx += 1) {
      const roleClass =
        idx < nextIdx ? 'is-past' : idx === nextIdx ? 'is-active' : 'is-upcoming';
      let el = this._nodes.get(idx);
      const isNew = !el;

      if (isNew) {
        el = document.createElement('p');
        el.textContent = this._lines[idx].text;
        el.className = 'lyric-line is-entering';
        this._nodes.set(idx, el);
        requestAnimationFrame(() => {
          if (this._nodes.get(idx) === el) {
            el.className = `lyric-line ${roleClass}`;
          }
        });
      } else {
        el.className = `lyric-line ${roleClass}`;
      }
      orderedNodes.push(el);
    }

    // Keep DOM sequence strictly top-to-bottom [past, active, upcoming]
    for (let i = 0; i < orderedNodes.length; i += 1) {
      const node = orderedNodes[i];
      const currentAtSlot = this.stageEl.children[i];
      if (currentAtSlot !== node) {
        this.stageEl.insertBefore(node, currentAtSlot || null);
      }
    }
  }
}
