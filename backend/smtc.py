"""Windows SMTC media reader and transport command controller via PyWinRT."""

from __future__ import annotations

import asyncio
import base64
from datetime import datetime, timezone
import hashlib
import logging
import re
import time
from typing import Any

from winrt.windows.media.control import (
    GlobalSystemMediaTransportControlsSessionManager as MediaManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlaybackStatus,
)
from winrt.windows.storage.streams import Buffer, DataReader, InputStreamOptions

from .config import SMTC_OP_TIMEOUT, SMTC_REQUEST_TIMEOUT

logger = logging.getLogger(__name__)


async def _await_winrt(operation: Any, timeout: float) -> Any:
    """Await a WinRT IAsyncOperation/IAsyncAction with a bounded timeout."""
    async def _runner() -> Any:
        return await operation

    return await asyncio.wait_for(_runner(), timeout=timeout)

_STATUS_MAP = {
    PlaybackStatus.CLOSED: "closed",
    PlaybackStatus.OPENED: "opened",
    PlaybackStatus.CHANGING: "changing",
    PlaybackStatus.STOPPED: "stopped",
    PlaybackStatus.PLAYING: "playing",
    PlaybackStatus.PAUSED: "paused",
}

_MAX_THUMB_READ_BYTES = 10 * 1024 * 1024
_READ_CHUNK_BYTES = 64 * 1024


def _timespan_to_seconds(ts: Any) -> float:
    """Convert WinRT TimeSpan or timedelta to non-negative float seconds."""
    if ts is None:
        return 0.0
    if hasattr(ts, "total_seconds"):
        return max(0.0, float(ts.total_seconds()))
    duration = getattr(ts, "duration", None)
    if duration is not None:
        return max(0.0, float(duration) / 10_000_000.0)
    return 0.0


def _sniff_image_mime(data: bytes) -> str:
    """Detect common image MIME types from magic bytes."""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if data.startswith(b"BM"):
        return "image/bmp"
    return "image/jpeg"


def _buffer_to_bytes(ibuf: Any) -> bytes:
    """Extract raw bytes from a WinRT IBuffer."""
    length = int(getattr(ibuf, "length", 0))
    if length <= 0:
        return b""
    try:
        raw = bytes(ibuf)
        if len(raw) == length:
            return raw
    except TypeError:
        pass
    reader = DataReader.from_buffer(ibuf)
    buf = bytearray(length)
    reader.read_bytes(buf)
    return bytes(buf)


def make_track_id(artist: str, title: str, album: str = "") -> str:
    """Build a stable 16-char hex ID from normalized artist and title."""
    norm_artist = re.sub(r"\s+", " ", (artist or "").strip().lower())
    norm_title = re.sub(r"\s+", " ", (title or "").strip().lower())
    key = f"{norm_artist}::{norm_title}"
    return hashlib.sha1(key.encode("utf-8")).hexdigest()[:16]


class SMTCReader:
    """Reads active Windows media metadata and sends SMTC transport commands."""

    def __init__(self) -> None:
        self._manager: MediaManager | None = None
        self._manager_lock = asyncio.Lock()
        self._thumb_cache_key: tuple[str, str, str, str] | None = None
        self._thumb_cache_uri: str | None = None
        self._thumb_hash: bytes | None = None
        self._last_thumb_check_mono: float = 0.0
        self._anchor_key: tuple[str, float] | None = None
        self._anchor_mono: float = 0.0

    async def _ensure_manager(self) -> MediaManager | None:
        if self._manager is not None:
            return self._manager
        async with self._manager_lock:
            if self._manager is not None:
                return self._manager
            try:
                self._manager = await _await_winrt(
                    MediaManager.request_async(), SMTC_REQUEST_TIMEOUT
                )
            except asyncio.TimeoutError:
                logger.warning(
                    "SMTC SessionManager request_async timed out after %.1fs",
                    SMTC_REQUEST_TIMEOUT,
                )
                self._manager = None
            except Exception as exc:
                logger.warning("Failed to acquire SMTC SessionManager: %s", exc)
                self._manager = None
            return self._manager

    def _select_session(self, manager: MediaManager) -> Any:
        try:
            current = manager.get_current_session()
            if current is not None:
                return current
            sessions = list(manager.get_sessions())
        except Exception as exc:
            logger.debug("Error listing SMTC sessions: %s", exc)
            self._manager = None
            return None

        if not sessions:
            return None

        for sess in sessions:
            try:
                info = sess.get_playback_info()
                if info and info.playback_status == PlaybackStatus.PLAYING:
                    return sess
            except Exception:
                continue
        return sessions[0]

    async def _read_thumbnail_bytes(self, thumb_ref: Any) -> bytes | None:
        if thumb_ref is None:
            return None
        stream = None
        try:
            stream = await _await_winrt(thumb_ref.open_read_async(), SMTC_OP_TIMEOUT)
            if stream is None:
                return None

            stream_size = int(getattr(stream, "size", 0) or 0)
            if stream_size > _MAX_THUMB_READ_BYTES:
                logger.warning("Skipping oversized SMTC thumbnail (%d bytes)", stream_size)
                return None

            chunks: list[bytes] = []
            total = 0
            while total < _MAX_THUMB_READ_BYTES:
                to_read = (
                    min(_READ_CHUNK_BYTES, stream_size - total)
                    if stream_size > 0
                    else _READ_CHUNK_BYTES
                )
                if to_read <= 0:
                    break
                win_buf = Buffer(to_read)
                result_buf = await _await_winrt(
                    stream.read_async(win_buf, to_read, InputStreamOptions.READ_AHEAD),
                    SMTC_OP_TIMEOUT,
                )
                chunk = _buffer_to_bytes(result_buf if result_buf is not None else win_buf)
                if not chunk:
                    break
                chunks.append(chunk)
                total += len(chunk)
                if stream_size > 0 and total >= stream_size:
                    break

            raw = b"".join(chunks)
            return raw or None
        except asyncio.TimeoutError:
            logger.debug("Timed out reading SMTC thumbnail")
            return None
        except Exception as exc:
            logger.debug("Failed reading SMTC thumbnail: %s", exc)
            return None
        finally:
            if stream is not None and hasattr(stream, "close"):
                try:
                    stream.close()
                except Exception:
                    pass

    async def _read_thumbnail_data_uri(self, thumb_ref: Any) -> str | None:
        raw = await self._read_thumbnail_bytes(thumb_ref)
        if not raw:
            return None
        mime = _sniff_image_mime(raw)
        encoded = base64.b64encode(raw).decode("ascii")
        return f"data:{mime};base64,{encoded}"

    def _compute_position(
        self,
        track_id: str,
        status_str: str,
        timeline: Any,
        playback_rate: float,
        duration: float,
    ) -> float:
        if timeline is None:
            return 0.0

        raw_pos = _timespan_to_seconds(getattr(timeline, "position", None))
        pos = raw_pos

        if status_str == "playing":
            rate = playback_rate if playback_rate and playback_rate > 0 else 1.0
            last_upd = getattr(timeline, "last_updated_time", None)
            used_timestamp = False

            if isinstance(last_upd, datetime) and last_upd.year > 1900:
                dt_utc = (
                    last_upd.replace(tzinfo=timezone.utc)
                    if last_upd.tzinfo is None
                    else last_upd.astimezone(timezone.utc)
                )
                elapsed = (datetime.now(timezone.utc) - dt_utc).total_seconds()
                max_valid_elapsed = max(duration + 5.0, 3600.0)
                if 0.0 <= elapsed <= max_valid_elapsed:
                    pos = raw_pos + elapsed * rate
                    used_timestamp = True

            if not used_timestamp:
                anchor = (track_id, round(raw_pos, 3))
                now_mono = time.monotonic()
                if self._anchor_key != anchor:
                    self._anchor_key = anchor
                    self._anchor_mono = now_mono
                pos = raw_pos + max(0.0, now_mono - self._anchor_mono) * rate
        else:
            self._anchor_key = None

        if duration > 0:
            return min(max(0.0, pos), duration)
        return max(0.0, pos)

    async def get_media_state(self, force_thumbnail: bool = False) -> dict[str, Any] | None:
        """Query current active SMTC session state, or return None if unavailable."""
        manager = await self._ensure_manager()
        if manager is None:
            return None

        session = self._select_session(manager)
        if session is None:
            return None

        try:
            source_app = str(getattr(session, "source_app_user_model_id", "") or "")
            playback_info = session.get_playback_info()
            timeline = session.get_timeline_properties()
            media_props = await _await_winrt(
                session.try_get_media_properties_async(), SMTC_OP_TIMEOUT
            )
        except asyncio.TimeoutError:
            logger.debug("Timed out reading SMTC session properties")
            return None
        except Exception as exc:
            logger.debug("Failed reading SMTC session properties: %s", exc)
            return None

        if media_props is None:
            return None

        title = str(getattr(media_props, "title", "") or "").strip()
        artist = str(getattr(media_props, "artist", "") or "").strip()
        album = str(getattr(media_props, "album_title", "") or "").strip()
        if not title and not artist:
            return None

        raw_status = getattr(playback_info, "playback_status", None) if playback_info else None
        status_str = _STATUS_MAP.get(raw_status, "closed")
        raw_rate = getattr(playback_info, "playback_rate", None) if playback_info else None
        playback_rate = float(raw_rate) if raw_rate else 1.0

        start_time = _timespan_to_seconds(getattr(timeline, "start_time", None)) if timeline else 0.0
        end_time = _timespan_to_seconds(getattr(timeline, "end_time", None)) if timeline else 0.0
        duration = max(0.0, end_time - start_time)

        track_id = make_track_id(artist, title, album)
        position = self._compute_position(track_id, status_str, timeline, playback_rate, duration)

        thumb_key = (source_app, title, artist, album)
        thumb_ref = getattr(media_props, "thumbnail", None)
        now_mono = time.monotonic()
        key_changed = thumb_key != self._thumb_cache_key
        should_check = (
            force_thumbnail
            or key_changed
            or self._thumb_cache_uri is None
            or (now_mono - self._last_thumb_check_mono) >= 1.5
        )

        if should_check:
            self._last_thumb_check_mono = now_mono
            raw = await self._read_thumbnail_bytes(thumb_ref)
            if raw:
                raw_hash = hashlib.sha1(raw).digest()
                if raw_hash != self._thumb_hash or self._thumb_cache_uri is None:
                    mime = _sniff_image_mime(raw)
                    encoded = base64.b64encode(raw).decode("ascii")
                    self._thumb_cache_uri = f"data:{mime};base64,{encoded}"
                    self._thumb_hash = raw_hash
            elif key_changed or force_thumbnail:
                self._thumb_cache_uri = None
                self._thumb_hash = None
            self._thumb_cache_key = thumb_key

        return {
            "track_id": track_id,
            "title": title,
            "artist": artist,
            "album": album,
            "thumbnail": self._thumb_cache_uri,
            "playback_status": status_str,
            "position": round(position, 3),
            "duration": round(duration, 3),
            "source_app": source_app,
            "updated_at": round(time.time(), 3),
        }

    async def send_command(self, action: str) -> tuple[bool, str]:
        """Dispatch an SMTC transport control command to the active session."""
        manager = await self._ensure_manager()
        if manager is None:
            return False, "SMTC manager unavailable"

        session = self._select_session(manager)
        if session is None:
            return False, "No active media session"

        method_map = {
            "play": "try_play_async",
            "pause": "try_pause_async",
            "play_pause": "try_toggle_play_pause_async",
            "next": "try_skip_next_async",
            "prev": "try_skip_previous_async",
        }
        method_name = method_map.get(action)
        if not method_name:
            return False, f"Unsupported SMTC action: {action}"

        method = getattr(session, method_name, None)
        if method is None:
            return False, f"SMTC method missing: {method_name}"

        try:
            ok = bool(await _await_winrt(method(), SMTC_OP_TIMEOUT))
            return ok, "ok" if ok else f"SMTC rejected {action}"
        except asyncio.TimeoutError:
            logger.warning("SMTC command %s timed out after %.1fs", action, SMTC_OP_TIMEOUT)
            return False, "SMTC command timed out"
        except Exception as exc:
            logger.warning("SMTC command %s failed: %s", action, exc)
            return False, str(exc)
