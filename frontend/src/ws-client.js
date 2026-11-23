const RECONNECT_DELAYS_MS = [1000, 1500, 2500, 4000, 5000];

export class OverlayWSClient {
  constructor({
    url = 'ws://127.0.0.1:8765',
    onState,
    onPosition,
    onAudio,
    onLyrics,
    onHistory,
    onConnectionChange,
  } = {}) {
    this.url = url;
    this.onState = onState;
    this.onPosition = onPosition;
    this.onAudio = onAudio;
    this.onLyrics = onLyrics;
    this.onHistory = onHistory;
    this.onConnectionChange = onConnectionChange;

    this._ws = null;
    this._reconnectAttempt = 0;
    this._reconnectTimer = null;
    this._disposed = false;

    this._trackId = null;
    this._anchorPos = 0;
    this._anchorMs = performance.now();
    this._duration = 0;
    this._playing = false;

    this._audioBins = new Float32Array(64);
    this._audioFrame = {
      bins: this._audioBins,
      energy: 0,
      peak: 0,
      active: false,
    };
  }

  connect() {
    if (this._disposed) return;
    this._clearReconnect();

    try {
      this._ws = new WebSocket(this.url);
      this._ws.binaryType = 'arraybuffer';
    } catch {
      this._scheduleReconnect();
      return;
    }

    this._ws.addEventListener('open', () => {
      this._reconnectAttempt = 0;
      this.onConnectionChange?.(true);
    });

    this._ws.addEventListener('message', (event) => {
      if (event.data instanceof ArrayBuffer) {
        this._handleBinaryAudio(event.data);
        return;
      }
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      this._handleMessage(msg);
    });

    this._ws.addEventListener('close', () => {
      this._ws = null;
      this._playing = false;
      this.onConnectionChange?.(false);
      this._scheduleReconnect();
    });

    this._ws.addEventListener('error', () => {
      if (this._ws && this._ws.readyState === WebSocket.OPEN) {
        this._ws.close();
      }
    });
  }

  _clearReconnect() {
    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  _scheduleReconnect() {
    if (this._disposed || this._reconnectTimer !== null) return;
    const idx = Math.min(this._reconnectAttempt, RECONNECT_DELAYS_MS.length - 1);
    const delay = RECONNECT_DELAYS_MS[idx];
    this._reconnectAttempt += 1;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect();
    }, delay);
  }

  _syncTimeline(position, duration, playbackStatus, trackId = this._trackId) {
    const nowMs = performance.now();
    const incoming = Math.max(0, Number(position) || 0);
    const nextDuration = Math.max(0, Number(duration) || 0);
    const nextPlaying = playbackStatus === 'playing';
    const trackChanged = trackId !== this._trackId;
    const statusChanged = nextPlaying !== this._playing;

    if (trackChanged || statusChanged) {
      this._trackId = trackId;
      this._anchorPos = incoming;
      this._anchorMs = nowMs;
      this._duration = nextDuration;
      this._playing = nextPlaying;
      return;
    }

    const predicted = this.getPosition(nowMs);
    const delta = incoming - predicted;
    const absDelta = Math.abs(delta);

    if (absDelta > 0.35) {
      this._anchorPos = incoming;
      this._anchorMs = nowMs;
    } else if (absDelta > 0.08) {
      this._anchorPos = predicted + delta * 0.35;
      this._anchorMs = nowMs;
    }

    this._duration = nextDuration;
    this._playing = nextPlaying;
  }

  _handleBinaryAudio(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes.length !== 64) return;

    let sum = 0;
    let peak = 0;
    for (let i = 0; i < 64; i += 1) {
      const norm = bytes[i] * (1 / 255);
      this._audioBins[i] = norm;
      sum += norm;
      if (norm > peak) peak = norm;
    }

    this._audioFrame.energy = sum / 64;
    this._audioFrame.peak = peak;
    this._audioFrame.active = peak > 0.004;
    this.onAudio?.(this._audioFrame);
  }

  _handleMessage(msg) {
    switch (msg?.type) {
      case 'state': {
        const media = msg.media || null;
        if (media) {
          this._syncTimeline(
            media.position,
            media.duration,
            media.playback_status,
            media.track_id
          );
        } else {
          this._trackId = null;
          this._anchorPos = 0;
          this._anchorMs = performance.now();
          this._duration = 0;
          this._playing = false;
        }
        this.onState?.(media);
        break;
      }
      case 'position': {
        this._syncTimeline(msg.position, msg.duration, msg.playback_status);
        this.onPosition?.(msg);
        break;
      }
      case 'audio': {
        this.onAudio?.(msg);
        break;
      }
      case 'lyrics': {
        this.onLyrics?.(msg);
        break;
      }
      case 'history': {
        this.onHistory?.(msg);
        break;
      }
      default:
        break;
    }
  }

  getPosition(nowMs = performance.now()) {
    if (!this._playing) {
      return this._anchorPos;
    }
    const elapsed = Math.max(0, (nowMs - this._anchorMs) / 1000);
    const pos = this._anchorPos + elapsed;
    return this._duration > 0 ? Math.min(pos, this._duration) : pos;
  }

  sendCommand(action, extra = {}) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return false;
    this._ws.send(JSON.stringify({ type: 'command', action, ...extra }));
    return true;
  }

  setAudioPaused(paused) {
    return this.sendCommand('set_audio_paused', { paused: Boolean(paused) });
  }

  destroy() {
    this._disposed = true;
    this._clearReconnect();
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
  }
}
