"""Centralized configuration constants for the Phase 1 WebSocket backend."""

from pathlib import Path

WS_HOST = "127.0.0.1"
WS_PORT = 8765

FFT_BINS = 64
FFT_SIZE = 4096
FFT_FPS = 55
FFT_MIN_FREQ = 30.0
FFT_MAX_FREQ = 16000.0
AUDIO_REBIND_CHECK_INTERVAL = 1.5

SMTC_POLL_INTERVAL = 0.25
SMTC_REQUEST_TIMEOUT = 3.0
SMTC_OP_TIMEOUT = 2.5

LRCLIB_BASE_URL = "https://lrclib.net/api"
LRCLIB_USER_AGENT = "WindowsMusicOverlay/1.0"
LYRICS_NOT_FOUND_TTL_SECONDS = 86400

DEEZER_SEARCH_URL = "https://api.deezer.com/search"
ITUNES_SEARCH_URL = "https://itunes.apple.com/search"
ARTWORK_NOT_FOUND_TTL_SECONDS = 86400
ARTWORK_CACHE_MAX_ENTRIES = 150
ARTWORK_MAX_IMAGE_BYTES = 8_000_000

HISTORY_MAX_RECENT = 50
MAX_HISTORY_THUMB_BYTES = 500_000

DATA_DIR = Path(__file__).resolve().parent / "data"
LYRICS_CACHE_PATH = DATA_DIR / "lyrics_cache.json"
ARTWORK_CACHE_PATH = DATA_DIR / "artwork_cache.json"
HISTORY_PATH = DATA_DIR / "history.json"
