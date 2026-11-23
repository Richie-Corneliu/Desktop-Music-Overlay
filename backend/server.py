"""WebSocket server streaming SMTC state, WASAPI FFT audio bins, lyrics, and history."""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import logging
from pathlib import Path
import sys
from typing import Any

import numpy as np
from websockets.asyncio.server import Server, ServerConnection, serve
from websockets.exceptions import ConnectionClosed

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from backend.artwork import ArtworkService
    from backend.audio_fft import AudioLoopbackCapture
    from backend.config import (
        AUDIO_REBIND_CHECK_INTERVAL,
        FFT_FPS,
        SMTC_POLL_INTERVAL,
        WS_HOST,
        WS_PORT,
    )
    from backend.history import HistoryStore
    from backend.lyrics import LyricsService
    from backend.smtc import SMTCReader
else:
    from .artwork import ArtworkService
    from .audio_fft import AudioLoopbackCapture
    from .config import (
        AUDIO_REBIND_CHECK_INTERVAL,
        FFT_FPS,
        SMTC_POLL_INTERVAL,
        WS_HOST,
        WS_PORT,
    )
    from .history import HistoryStore
    from .lyrics import LyricsService
    from .smtc import SMTCReader

logger = logging.getLogger(__name__)

AUDIO_SILENCE_IDLE_SECONDS = 2.0
AUDIO_IDLE_POLL_INTERVAL = 0.2
AUDIO_SILENCE_PEAK_THRESHOLD = 0.004
ZERO_AUDIO_FRAME = b"\x00" * 64


def _empty_lyrics_payload(track_id: str | None = None, status: str = "not_found") -> dict[str, Any]:
    return {
        "track_id": track_id,
        "status": status,
        "cached": False,
        "instrumental": False,
        "lines": [],
        "plain": None,
    }


class MusicOverlayServer:
    """Asyncio WebSocket server coordinating SMTC, WASAPI FFT, lyrics, and history."""

    def __init__(
        self,
        host: str = WS_HOST,
        port: int = WS_PORT,
        smtc: SMTCReader | None = None,
        audio: AudioLoopbackCapture | None = None,
        lyrics: LyricsService | None = None,
        history: HistoryStore | None = None,
        artwork: ArtworkService | None = None,
    ) -> None:
        self.host = host
        self.port = int(port)
        self.smtc = smtc or SMTCReader()
        self.audio = audio or AudioLoopbackCapture()
        self.lyrics = lyrics or LyricsService()
        self.history = history or HistoryStore()
        self.artwork = artwork or ArtworkService()

        self.clients: set[ServerConnection] = set()
        self._paused_clients: set[ServerConnection] = set()
        self.current_media: dict[str, Any] | None = None
        self.current_lyrics: dict[str, Any] | None = None

        self._ws_server: Server | None = None
        self._tasks: list[asyncio.Task[Any]] = []
        self._lyrics_task: asyncio.Task[Any] | None = None
        self._artwork_task: asyncio.Task[Any] | None = None
        self._hd_artwork_track_id: str | None = None
        self._hd_artwork_uri: str | None = None
        self._poll_wakeup = asyncio.Event()
        self._audio_wakeup = asyncio.Event()
        self._running = False

    async def _send_json(self, ws: ServerConnection, payload: dict[str, Any]) -> None:
        try:
            await ws.send(json.dumps(payload, ensure_ascii=False))
        except ConnectionClosed:
            pass
        except Exception as exc:
            logger.debug("Failed sending message to client: %s", exc)

    async def _send_raw(
        self, raw: str | bytes, targets: list[ServerConnection] | None = None
    ) -> None:
        conns = targets if targets is not None else list(self.clients)
        if not conns:
            return
        stale: list[ServerConnection] = []
        for ws in conns:
            try:
                await ws.send(raw)
            except ConnectionClosed:
                stale.append(ws)
            except Exception as exc:
                logger.debug("Broadcast error: %s", exc)
                stale.append(ws)
        for ws in stale:
            self.clients.discard(ws)
            self._paused_clients.discard(ws)

    async def _broadcast(self, payload: dict[str, Any]) -> None:
        if not self.clients:
            return
        await self._send_raw(json.dumps(payload, ensure_ascii=False))

    def _schedule_lyrics_fetch(
        self, media: dict[str, Any], force_refresh: bool = False
    ) -> None:
        if self._lyrics_task is not None and not self._lyrics_task.done():
            self._lyrics_task.cancel()

        track_id = media["track_id"]

        async def _worker() -> None:
            loading = _empty_lyrics_payload(track_id=track_id, status="loading")
            self.current_lyrics = loading
            await self._broadcast({"type": "lyrics", **loading})

            result = await self.lyrics.get_lyrics(
                track_id=track_id,
                title=media.get("title", ""),
                artist=media.get("artist", ""),
                album=media.get("album", ""),
                duration=float(media.get("duration") or 0.0),
                force_refresh=force_refresh,
            )
            if self.current_media and self.current_media.get("track_id") == track_id:
                self.current_lyrics = result
                await self._broadcast({"type": "lyrics", **result})

        self._lyrics_task = asyncio.create_task(_worker())

    def _schedule_artwork_fetch(self, media: dict[str, Any]) -> None:
        if self._artwork_task is not None and not self._artwork_task.done():
            self._artwork_task.cancel()

        track_id = media["track_id"]

        async def _worker() -> None:
            hd_uri = await self.artwork.get_hd_artwork(
                title=media.get("title", ""),
                artist=media.get("artist", ""),
            )
            if not hd_uri:
                return
            if self.current_media and self.current_media.get("track_id") == track_id:
                self._hd_artwork_track_id = track_id
                self._hd_artwork_uri = hd_uri
                updated = dict(self.current_media)
                updated["thumbnail"] = hd_uri
                self.current_media = updated
                await self._broadcast({"type": "state", "media": updated})

        self._artwork_task = asyncio.create_task(_worker())

    async def _poll_media_once(self) -> None:
        new_media = await self.smtc.get_media_state()
        old_media = self.current_media
        old_id = old_media.get("track_id") if old_media else None
        new_id = new_media.get("track_id") if new_media else None

        if new_id != old_id:
            self._hd_artwork_track_id = None
            self._hd_artwork_uri = None
            if self._artwork_task is not None and not self._artwork_task.done():
                self._artwork_task.cancel()

            self.current_media = new_media
            if new_media and new_media.get("playback_status") == "playing":
                self._audio_wakeup.set()
            await self._broadcast({"type": "state", "media": new_media})

            if new_media is not None:
                if self.history.record_play(new_media):
                    await self._broadcast({"type": "history", **self.history.get_payload()})
                self._schedule_lyrics_fetch(new_media, force_refresh=False)
                self._schedule_artwork_fetch(new_media)
            else:
                if self._lyrics_task is not None and not self._lyrics_task.done():
                    self._lyrics_task.cancel()
                self.current_lyrics = _empty_lyrics_payload(None, "not_found")
                await self._broadcast({"type": "lyrics", **self.current_lyrics})
            return

        if new_media is None or old_media is None:
            return

        # Keep cached/fetched HD artwork instead of letting subsequent SMTC polls revert it
        if self._hd_artwork_track_id == new_id and self._hd_artwork_uri:
            new_media = dict(new_media)
            new_media["thumbnail"] = self._hd_artwork_uri

        pos_jump = abs(float(new_media["position"]) - float(old_media["position"]))
        state_changed = (
            new_media["playback_status"] != old_media["playback_status"]
            or new_media["thumbnail"] != old_media["thumbnail"]
            or new_media["duration"] != old_media["duration"]
            or pos_jump > 1.5
        )
        if state_changed:
            was_playing = old_media.get("playback_status") == "playing"
            self.current_media = new_media
            if not was_playing and new_media.get("playback_status") == "playing":
                self._audio_wakeup.set()
            await self._broadcast({"type": "state", "media": new_media})
        elif (
            new_media["playback_status"] == "playing"
            or new_media["position"] != old_media["position"]
        ):
            self.current_media["position"] = new_media["position"]
            self.current_media["updated_at"] = new_media["updated_at"]
            await self._broadcast(
                {
                    "type": "position",
                    "position": new_media["position"],
                    "duration": new_media["duration"],
                    "playback_status": new_media["playback_status"],
                    "updated_at": new_media["updated_at"],
                }
            )

    async def _media_loop(self) -> None:
        while self._running:
            try:
                await self._poll_media_once()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning("SMTC poll loop error: %s", exc)

            try:
                await asyncio.wait_for(
                    self._poll_wakeup.wait(), timeout=SMTC_POLL_INTERVAL
                )
                self._poll_wakeup.clear()
            except asyncio.TimeoutError:
                pass

    async def _audio_loop(self) -> None:
        active_interval = 1.0 / float(FFT_FPS)
        loop = asyncio.get_running_loop()

        def _wake_from_audio_thread() -> None:
            if self._running:
                loop.call_soon_threadsafe(self._audio_wakeup.set)

        set_cb = getattr(self.audio, "set_signal_callback", None)
        arm_wake = getattr(self.audio, "arm_signal_wakeup", None)
        if callable(set_cb):
            set_cb(_wake_from_audio_thread)

        try:
            await asyncio.to_thread(self.audio.start)
        except Exception as exc:
            logger.warning("Initial WASAPI loopback start failed: %s", exc)

        last_rebind_check = loop.time()
        rebind_task: asyncio.Task[bool] | None = None
        silence_since: float | None = None
        deep_idle = False
        sent_zero_idle = False
        next_tick = loop.time()

        try:
            while self._running:
                now = loop.time()
                if (
                    (rebind_task is None or rebind_task.done())
                    and (now - last_rebind_check) >= AUDIO_REBIND_CHECK_INTERVAL
                ):
                    last_rebind_check = now
                    rebind_task = asyncio.create_task(
                        asyncio.to_thread(self.audio.check_and_rebind),
                        name="wasapi_audio_rebind",
                    )

                active_clients = [
                    ws for ws in self.clients if ws not in self._paused_clients
                ]

                if not active_clients:
                    silence_since = None
                    if not deep_idle:
                        deep_idle = True
                        sent_zero_idle = False
                    if callable(arm_wake):
                        arm_wake(False)
                    try:
                        await asyncio.wait_for(
                            self._audio_wakeup.wait(), timeout=AUDIO_IDLE_POLL_INTERVAL
                        )
                        self._audio_wakeup.clear()
                    except asyncio.TimeoutError:
                        pass
                    next_tick = loop.time()
                    continue

                is_playing = bool(
                    self.current_media
                    and self.current_media.get("playback_status") == "playing"
                )

                if hasattr(self.audio, "get_binary_frame"):
                    frame_bytes, _energy, peak, active = self.audio.get_binary_frame()
                else:
                    frame = self.audio.get_frame()
                    bins = frame.get("bins") or []
                    arr = np.clip(
                        np.rint(np.asarray(bins, dtype=np.float32) * 255.0), 0, 255
                    ).astype(np.uint8)
                    frame_bytes = arr.tobytes()[:64].ljust(64, b"\x00")
                    peak = float(frame.get("peak") or 0.0)
                    active = bool(frame.get("active"))

                near_zero = (not active) and peak <= AUDIO_SILENCE_PEAK_THRESHOLD

                if is_playing or not near_zero:
                    silence_since = None
                    if deep_idle:
                        deep_idle = False
                        self._audio_wakeup.clear()
                        next_tick = loop.time()
                    sent_zero_idle = False
                    if callable(arm_wake):
                        arm_wake(False)
                    await self._send_raw(frame_bytes, targets=active_clients)
                else:
                    if silence_since is None:
                        silence_since = now

                    if (now - silence_since) > AUDIO_SILENCE_IDLE_SECONDS:
                        if not sent_zero_idle:
                            await self._send_raw(ZERO_AUDIO_FRAME, targets=active_clients)
                            sent_zero_idle = True
                        if not deep_idle:
                            deep_idle = True
                            self._audio_wakeup.clear()
                        if callable(arm_wake):
                            arm_wake(True)
                    else:
                        if deep_idle:
                            deep_idle = False
                            self._audio_wakeup.clear()
                            next_tick = loop.time()
                        sent_zero_idle = False
                        if callable(arm_wake):
                            arm_wake(False)
                        await self._send_raw(frame_bytes, targets=active_clients)

                if deep_idle:
                    try:
                        await asyncio.wait_for(
                            self._audio_wakeup.wait(), timeout=AUDIO_IDLE_POLL_INTERVAL
                        )
                        self._audio_wakeup.clear()
                    except asyncio.TimeoutError:
                        pass
                    next_tick = loop.time()
                else:
                    next_tick += active_interval
                    now = loop.time()
                    sleep_for = next_tick - now
                    if sleep_for < -active_interval:
                        next_tick = now
                        sleep_for = active_interval
                    await asyncio.sleep(max(0.001, sleep_for))
        finally:
            if callable(set_cb):
                set_cb(None)
            if rebind_task is not None and not rebind_task.done():
                rebind_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await rebind_task

    async def _send_full_snapshot(self, ws: ServerConnection) -> None:
        await self._send_json(ws, {"type": "state", "media": self.current_media})
        lyrics_payload = self.current_lyrics or _empty_lyrics_payload(
            self.current_media.get("track_id") if self.current_media else None,
            "not_found",
        )
        await self._send_json(ws, {"type": "lyrics", **lyrics_payload})
        await self._send_json(ws, {"type": "history", **self.history.get_payload()})

    async def _delayed_poll_wakeup(self, delay: float = 0.15) -> None:
        await asyncio.sleep(delay)
        self._poll_wakeup.set()

    async def _handle_client_message(
        self, ws: ServerConnection, raw: str | bytes
    ) -> None:
        try:
            msg = json.loads(raw)
        except Exception:
            await self._send_json(
                ws,
                {"type": "ack", "command": "unknown", "ok": False, "detail": "Invalid JSON"},
            )
            return

        if not isinstance(msg, dict):
            await self._send_json(
                ws,
                {"type": "ack", "command": "unknown", "ok": False, "detail": "Expected JSON object"},
            )
            return

        action = msg.get("action") or msg.get("command")
        if not action or not isinstance(action, str):
            await self._send_json(
                ws,
                {"type": "ack", "command": "unknown", "ok": False, "detail": "Missing action"},
            )
            return

        if action in ("play", "pause", "play_pause", "next", "prev"):
            ok, detail = await self.smtc.send_command(action)
            await self._send_json(
                ws, {"type": "ack", "command": action, "ok": ok, "detail": detail}
            )
            if ok:
                asyncio.create_task(self._delayed_poll_wakeup(0.15))
            return

        if action == "refresh_lyrics":
            if self.current_media:
                self._schedule_lyrics_fetch(self.current_media, force_refresh=True)
                await self._send_json(
                    ws,
                    {"type": "ack", "command": action, "ok": True, "detail": "Refreshing lyrics"},
                )
            else:
                await self._send_json(
                    ws,
                    {"type": "ack", "command": action, "ok": False, "detail": "No active track"},
                )
            return

        if action in ("pin_track", "unpin_track", "toggle_pin"):
            track_id = msg.get("track_id") or (
                self.current_media.get("track_id") if self.current_media else None
            )
            if not track_id:
                await self._send_json(
                    ws,
                    {"type": "ack", "command": action, "ok": False, "detail": "Missing track_id"},
                )
                return

            if action == "pin_track":
                ok = self.history.pin_track(track_id, fallback_media=self.current_media)
                detail = "Pinned" if ok else "Track not found"
            elif action == "unpin_track":
                ok = self.history.unpin_track(track_id)
                detail = "Unpinned" if ok else "Track not pinned"
            else:
                ok, now_pinned = self.history.toggle_pin(
                    track_id, fallback_media=self.current_media
                )
                detail = "Pinned" if now_pinned else ("Unpinned" if ok else "Track not found")

            if ok:
                await self._broadcast({"type": "history", **self.history.get_payload()})
            await self._send_json(
                ws, {"type": "ack", "command": action, "ok": ok, "detail": detail}
            )
            return

        if action == "get_state":
            await self._send_full_snapshot(ws)
            await self._send_json(
                ws, {"type": "ack", "command": action, "ok": True, "detail": "State sent"}
            )
            return

        if action in ("set_audio_paused", "pause_audio", "resume_audio"):
            if action == "pause_audio":
                paused = True
            elif action == "resume_audio":
                paused = False
            else:
                paused = bool(msg.get("paused", True))

            if paused:
                self._paused_clients.add(ws)
            else:
                self._paused_clients.discard(ws)
                self._audio_wakeup.set()

            await self._send_json(
                ws,
                {
                    "type": "ack",
                    "command": action,
                    "ok": True,
                    "detail": "Audio paused" if paused else "Audio resumed",
                },
            )
            return

        await self._send_json(
            ws,
            {"type": "ack", "command": action, "ok": False, "detail": f"Unknown action: {action}"},
        )

    async def _ws_handler(self, websocket: ServerConnection) -> None:
        self.clients.add(websocket)
        self._audio_wakeup.set()
        logger.info("Client connected (%d total)", len(self.clients))
        try:
            await self._send_full_snapshot(websocket)
            async for raw in websocket:
                await self._handle_client_message(websocket, raw)
        except ConnectionClosed:
            pass
        finally:
            self.clients.discard(websocket)
            self._paused_clients.discard(websocket)
            logger.info("Client disconnected (%d total)", len(self.clients))

    async def start(self) -> None:
        """Bind WebSocket server first, then launch SMTC and WASAPI background loops."""
        if self._running:
            return
        self._running = True

        self._ws_server = await serve(self._ws_handler, self.host, self.port)
        sockets = self._ws_server.sockets or []
        if sockets:
            self.port = int(sockets[0].getsockname()[1])

        logger.info("WebSocket server ready and listening on ws://%s:%d", self.host, self.port)

        self._tasks = [
            asyncio.create_task(self._media_loop(), name="smtc_media_loop"),
            asyncio.create_task(self._audio_loop(), name="wasapi_audio_loop"),
        ]

    async def stop(self) -> None:
        """Shut down background tasks, WebSocket server, HTTP client, and audio stream."""
        self._running = False
        for task in self._tasks:
            task.cancel()
        if self._lyrics_task is not None and not self._lyrics_task.done():
            self._lyrics_task.cancel()
        if self._artwork_task is not None and not self._artwork_task.done():
            self._artwork_task.cancel()

        for task in self._tasks:
            with contextlib.suppress(asyncio.CancelledError):
                await task
        self._tasks.clear()

        if self._lyrics_task is not None:
            with contextlib.suppress(asyncio.CancelledError):
                await self._lyrics_task
            self._lyrics_task = None

        if self._artwork_task is not None:
            with contextlib.suppress(asyncio.CancelledError):
                await self._artwork_task
            self._artwork_task = None

        if self._ws_server is not None:
            self._ws_server.close()
            await self._ws_server.wait_closed()
            self._ws_server = None

        await self.lyrics.close()
        await self.artwork.close()
        await asyncio.to_thread(self.audio.stop)
        logger.info("WebSocket server stopped")

    async def run_forever(self) -> None:
        """Start server and block until cancelled."""
        await self.start()
        try:
            await asyncio.Future()
        finally:
            await self.stop()


def main() -> None:
    parser = argparse.ArgumentParser(description="Windows 11 Music Overlay WebSocket Backend")
    parser.add_argument("--host", default=WS_HOST, help="Bind host (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=WS_PORT, help="Bind port (default: 8765)")
    parser.add_argument(
        "--log-level", default="INFO", choices=["DEBUG", "INFO", "WARNING", "ERROR"]
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level),
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    server = MusicOverlayServer(host=args.host, port=args.port)
    try:
        asyncio.run(server.run_forever())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
