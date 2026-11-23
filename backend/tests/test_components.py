"""Component and integration test suite for Phase 1 Python WebSocket backend."""

from __future__ import annotations

import asyncio
import base64
import ctypes
import io
import json
from pathlib import Path
import sys
import tempfile
import time

import httpx
import numpy as np
from PIL import Image
from websockets.asyncio.client import connect

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import backend.audio_fft as audio_fft_mod
from backend.audio_fft import (
    AudioLoopbackCapture,
    FFTProcessor,
    get_default_render_endpoint_id,
)
from backend.artwork import ArtworkService, upgrade_itunes_artwork_url
from backend.history import HistoryStore
from backend.lyrics import LyricsService, _clean_artist, _clean_title, parse_lrc
from backend.server import MusicOverlayServer
from backend.smtc import SMTCReader, make_track_id


def test_fft_processor() -> None:
    proc = FFTProcessor(sample_rate=48000, fft_size=4096, num_bins=64)
    t = np.arange(4096, dtype=np.float32) / 48000.0
    sine = 0.5 * np.sin(2.0 * np.pi * 440.0 * t).astype(np.float32)

    bins, energy, peak, active = proc.process(sine)
    assert len(bins) == 64, f"Expected 64 bins, got {len(bins)}"
    assert all(isinstance(b, float) and 0.0 <= b <= 1.0 for b in bins), "Bins out of [0, 1]"
    assert active is True, "Expected active=True for 440Hz sine"
    assert peak > 0.4, f"Expected peak > 0.4, got {peak}"
    assert energy > 0.0

    q_bytes, _q_energy, _q_peak, q_active = proc.process_quantized(sine)
    assert isinstance(q_bytes, bytes) and len(q_bytes) == 64, "Expected 64-byte quantized FFT"
    assert q_active is True and max(q_bytes) > 100

    for _ in range(40):
        bins, energy, peak, active = proc.process(None)

    assert active is False, "Expected active=False after silence"
    assert peak < 0.05, f"Expected peak < 0.05 after silence decay, got {peak}"
    q_idle, _, _, q_idle_active = proc.process_quantized(None)
    assert q_idle_active is False and max(q_idle) <= 13
    print(f"[PASS] FFTProcessor: 440Hz active peak + 64B uint8 quantization, decayed to {peak:.4f}")


def test_lrc_parser() -> None:
    sample_lrc = """
    [ti:Test Song]
    [ar:Test Artist]
    [offset:500]
    [00:12.00][00:24.50]<00:12.00>Repeated <00:12.40>chorus
    [00:05.250]First line
    """
    lines = parse_lrc(sample_lrc)
    assert len(lines) == 3, f"Expected 3 lines, got {len(lines)}"
    assert lines[0] == {"time": 4.75, "text": "First line"}, f"Unexpected line 0: {lines[0]}"
    assert lines[1] == {"time": 11.5, "text": "Repeated chorus"}, f"Unexpected line 1: {lines[1]}"
    assert lines[2] == {"time": 24.0, "text": "Repeated chorus"}, f"Unexpected line 2: {lines[2]}"
    print(f"[PASS] parse_lrc: parsed {len(lines)} lines with offset & multi-timestamps")


async def test_lyrics_service() -> None:
    assert _clean_artist("Queen - Topic") == "Queen"
    assert _clean_title("Song (Official Audio)") == "Song"
    assert _clean_title("Song (Official Video) [Lyrics]") == "Song"
    assert _clean_title("Song (Acoustic)") == "Song (Acoustic)"

    call_count = 0
    seen_queries: list[dict[str, str]] = []

    def _mock_handler(request: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        seen_queries.append(dict(request.url.params))
        if request.url.path.endswith("/get"):
            return httpx.Response(
                200,
                json={
                    "id": 1,
                    "trackName": "Test Song",
                    "artistName": "Test Artist",
                    "instrumental": False,
                    "plainLyrics": "Line one\nLine two",
                    "syncedLyrics": "[00:01.00]Line one\n[00:05.00]Line two",
                },
            )
        return httpx.Response(404)

    with tempfile.TemporaryDirectory() as tmp:
        cache_path = Path(tmp) / "lyrics_cache.json"
        mock_client = httpx.AsyncClient(transport=httpx.MockTransport(_mock_handler))
        try:
            svc = LyricsService(cache_path=cache_path, client=mock_client)
            tid = make_track_id("Test Artist", "Test Song")
            res1 = await svc.get_lyrics(
                tid,
                "Test Song (Official Video) [Lyrics]",
                "Test Artist - Topic",
                duration=180.0,
            )
            assert res1["status"] == "synced"
            assert res1["cached"] is False
            assert len(res1["lines"]) == 2
            assert call_count == 1
            assert seen_queries[0]["track_name"] == "Test Song"
            assert seen_queries[0]["artist_name"] == "Test Artist"

            # Reload from disk cache and ensure no extra HTTP call
            svc2 = LyricsService(cache_path=cache_path, client=mock_client)
            res2 = await svc2.get_lyrics(tid, "Test Song", "Test Artist", duration=180.0)
            assert res2["status"] == "synced"
            assert res2["cached"] is True
            assert call_count == 1
        finally:
            await mock_client.aclose()

    # Optional live lrclib.net smoke check (warn only if offline)
    with tempfile.TemporaryDirectory() as tmp:
        live_svc = LyricsService(cache_path=Path(tmp) / "live_cache.json")
        try:
            tid = make_track_id("Fleetwood Mac", "The Chain")
            live_res = await live_svc.get_lyrics(
                tid, "The Chain", "Fleetwood Mac", duration=269.0
            )
            if live_res["status"] in ("synced", "plain"):
                print(
                    f"[PASS] LyricsService: local cache verified + live lrclib.net ok "
                    f"(status={live_res['status']}, lines={len(live_res['lines'])})"
                )
            else:
                print(
                    f"[WARN] LyricsService: local cache verified; live lrclib.net returned "
                    f"status={live_res['status']}"
                )
        except Exception as exc:
            print(f"[WARN] LyricsService: local cache verified; live lrclib.net skipped ({exc})")
        finally:
            await live_svc.close()


def test_history_store() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        hist_path = Path(tmp) / "history.json"
        store = HistoryStore(history_path=hist_path, max_recent=50)
        t1 = {
            "track_id": make_track_id("Artist A", "Track 1"),
            "title": "Track 1",
            "artist": "Artist A",
            "album": "Album 1",
            "duration": 200.0,
            "thumbnail": "data:image/png;base64,AAAA",
        }
        t2 = {
            "track_id": make_track_id("Artist B", "Track 2"),
            "title": "Track 2",
            "artist": "Artist B",
            "album": "Album 2",
            "duration": 180.0,
            "thumbnail": None,
        }

        assert store.record_play(t1) is True
        assert store.record_play(t1) is False  # consecutive dedupe
        assert store.record_play(t2) is True
        assert store.record_play(t1) is True  # play_count -> 2

        ok, now_pinned = store.toggle_pin(t1["track_id"])
        assert ok and now_pinned is True

        reloaded = HistoryStore(history_path=hist_path, max_recent=50)
        payload = reloaded.get_payload()
        assert len(payload["recent"]) == 2
        assert payload["recent"][0]["track_id"] == t1["track_id"]
        assert payload["recent"][0]["play_count"] == 2
        assert payload["recent"][0]["pinned"] is True
        assert len(payload["pinned"]) == 1
        assert payload["pinned"][0]["track_id"] == t1["track_id"]
        print("[PASS] HistoryStore: dedupe, play_count, toggle_pin, and disk persistence verified")


async def test_live_probes() -> None:
    smtc = SMTCReader()
    state = await smtc.get_media_state()
    if state:
        print(
            f"[PASS] SMTC probe: {state['artist']} - {state['title']} "
            f"[{state['playback_status']} {state['position']:.1f}/{state['duration']:.1f}s]"
        )
    else:
        print("[PASS] SMTC probe: no active media session (handled cleanly)")

    dev = await asyncio.to_thread(AudioLoopbackCapture.get_default_loopback_device)
    if dev:
        print(
            f"[PASS] WASAPI loopback probe: {dev.get('name')} "
            f"({int(dev.get('defaultSampleRate', 0))} Hz, {dev.get('maxInputChannels')} ch)"
        )
    else:
        print("[WARN] WASAPI loopback probe: no default loopback device detected")


async def test_ws_server_integration() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        server = MusicOverlayServer(
            host="127.0.0.1",
            port=18765,
            lyrics=LyricsService(cache_path=tmp_dir / "lyrics.json"),
            history=HistoryStore(history_path=tmp_dir / "history.json"),
        )
        await server.start()
        try:
            url = f"ws://127.0.0.1:{server.port}"
            seen_types: set[str] = set()
            audio_frames: list[dict] = []
            ack_msg: dict | None = None

            async with connect(url) as ws:
                start = time.monotonic()
                cmd_sent = False
                while time.monotonic() - start < 1.5:
                    raw = await asyncio.wait_for(ws.recv(), timeout=2.0)
                    if isinstance(raw, (bytes, bytearray)):
                        assert len(raw) == 64, f"Expected 64 binary FFT bytes, got {len(raw)}"
                        seen_types.add("audio")
                        audio_frames.append({"len": len(raw)})
                        continue

                    msg = json.loads(raw)
                    mtype = msg.get("type")
                    if mtype:
                        seen_types.add(mtype)
                    if mtype == "ack":
                        ack_msg = msg

                    if not cmd_sent and {"state", "lyrics", "history"}.issubset(seen_types):
                        await ws.send(json.dumps({"type": "command", "action": "get_state"}))
                        cmd_sent = True

                # Drain briefly if ack hasn't arrived yet
                if ack_msg is None:
                    deadline = time.monotonic() + 0.5
                    while time.monotonic() < deadline and ack_msg is None:
                        raw = await asyncio.wait_for(ws.recv(), timeout=0.5)
                        if isinstance(raw, (bytes, bytearray)):
                            continue
                        msg = json.loads(raw)
                        if msg.get("type") == "ack":
                            ack_msg = msg

                elapsed = time.monotonic() - start
                hz = len(audio_frames) / max(0.1, elapsed)
                assert {"state", "lyrics", "history", "audio"}.issubset(
                    seen_types
                ), f"Missing initial message types, got {seen_types}"
                assert ack_msg is not None and ack_msg.get("ok") is True, f"Bad ack: {ack_msg}"
                assert hz >= 40.0, f"Audio rate too low: {hz:.1f} Hz"
                print(
                    f"[PASS] WS server integration: {len(audio_frames)} audio frames "
                    f"in {elapsed:.2f}s ({hz:.1f} Hz), get_state ack OK"
                )
        finally:
            await server.stop()


class _SlowSMTC:
    async def get_media_state(self, force_thumbnail: bool = False):
        await asyncio.sleep(5.0)
        return None

    async def send_command(self, action: str) -> tuple[bool, str]:
        return True, "ok"


async def test_nonblocking_startup_and_com_apartment() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        server = MusicOverlayServer(
            host="127.0.0.1",
            port=0,
            smtc=_SlowSMTC(),  # type: ignore[arg-type]
            lyrics=LyricsService(cache_path=tmp_dir / "lyrics.json"),
            history=HistoryStore(history_path=tmp_dir / "history.json"),
        )
        t0 = time.monotonic()
        await server.start()
        startup_sec = time.monotonic() - t0
        try:
            assert startup_sec < 0.5, f"Startup blocked by slow SMTC/audio ({startup_sec:.2f}s)"
            async with connect(f"ws://127.0.0.1:{server.port}") as ws:
                seen = set()
                for _ in range(25):
                    raw = await asyncio.wait_for(ws.recv(), timeout=1.0)
                    if isinstance(raw, (bytes, bytearray)):
                        continue
                    msg = json.loads(raw)
                    seen.add(msg.get("type"))
                    if {"state", "lyrics", "history"}.issubset(seen):
                        break
                assert {"state", "lyrics", "history"}.issubset(
                    seen
                ), f"Expected initial snapshot, got {seen}"
                await asyncio.sleep(0.15)

            apt_type = ctypes.c_int(-1)
            apt_qual = ctypes.c_int(-1)
            hr = ctypes.windll.ole32.CoGetApartmentType(
                ctypes.byref(apt_type), ctypes.byref(apt_qual)
            )
            is_main_sta = (hr == 0) and (apt_type.value == 3)
            assert not is_main_sta, "Main thread entered APTTYPE_MAINSTA"
            print(
                f"[PASS] Non-blocking WS startup ({startup_sec * 1000:.1f}ms) + "
                f"main thread COM apt={apt_type.value} (hr={hex(hr & 0xffffffff)})"
            )
        finally:
            await server.stop()


async def test_audio_auto_rebind() -> None:
    live_ep = await asyncio.to_thread(get_default_render_endpoint_id)
    if sys.platform == "win32":
        assert isinstance(live_ep, str) and len(live_ep) > 0, f"Bad endpoint ID: {live_ep}"

    cap = AudioLoopbackCapture()
    cap._bound_endpoint_id = "endpoint-A"
    events: list[str] = []

    orig_fn = audio_fft_mod.get_default_render_endpoint_id
    current_ep = "endpoint-A"
    audio_fft_mod.get_default_render_endpoint_id = lambda: current_ep
    cap.is_running = lambda: True  # type: ignore[method-assign]
    cap.stop = lambda: events.append("stop")  # type: ignore[method-assign]

    def _fake_start() -> bool:
        events.append("start")
        cap._bound_endpoint_id = current_ep
        return True

    cap.start = _fake_start  # type: ignore[method-assign]
    try:
        # Identical endpoint -> no rebind
        assert cap.check_and_rebind() is False
        assert events == []

        # Changed endpoint -> stop() then start()
        current_ep = "endpoint-B"
        assert cap.check_and_rebind() is True
        assert events == ["stop", "start"]
        assert cap._bound_endpoint_id == "endpoint-B"
    finally:
        audio_fft_mod.get_default_render_endpoint_id = orig_fn

    print(f"[PASS] Audio auto-rebind: endpoint change rebinds cleanly (live={live_ep})")


async def test_artwork_service() -> None:
    assert (
        upgrade_itunes_artwork_url(
            "https://is1-ssl.mzstatic.com/image/thumb/Music1/v4/aa/100x100bb.jpg"
        )
        == "https://is1-ssl.mzstatic.com/image/thumb/Music1/v4/aa/1200x1200bb.jpg"
    )

    jpeg_bytes = b"\xff\xd8\xff\xe0" + (b"\x11" * 128)
    png_bytes = b"\x89PNG\r\n\x1a\n" + (b"\x22" * 128)
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        calls.append(url)
        if "api.deezer.com" in url:
            if "FallbackTrack" in url:
                return httpx.Response(200, json={"data": []})
            return httpx.Response(
                200,
                json={
                    "data": [
                        {
                            "title": "Blinding Lights",
                            "artist": {"name": "The Weeknd"},
                            "album": {
                                "cover_xl": "https://cdn-images.dzcdn.net/images/cover/abc/1000x1000-000000-80-0-0.jpg"
                            },
                        }
                    ]
                },
            )
        if "itunes.apple.com" in url:
            return httpx.Response(
                200,
                json={
                    "results": [
                        {
                            "trackName": "FallbackTrack",
                            "artistName": "Indie Artist",
                            "artworkUrl100": "https://is1-ssl.mzstatic.com/image/thumb/Music/v4/100x100bb.jpg",
                        }
                    ]
                },
            )
        if "1000x1000-000000-80-0-0.jpg" in url:
            return httpx.Response(200, content=jpeg_bytes, headers={"Content-Type": "image/jpeg"})
        if "1200x1200bb.jpg" in url:
            return httpx.Response(200, content=png_bytes, headers={"Content-Type": "image/png"})
        if "1024x1024-real.png" in url:
            big = Image.new("RGB", (1024, 1024), (210, 40, 80))
            buf = io.BytesIO()
            big.save(buf, format="PNG")
            return httpx.Response(200, content=buf.getvalue(), headers={"Content-Type": "image/png"})
        return httpx.Response(404)

    transport = httpx.MockTransport(handler)
    with tempfile.TemporaryDirectory() as tmp:
        cache_path = Path(tmp) / "artwork_cache.json"
        async with httpx.AsyncClient(transport=transport) as client:
            svc = ArtworkService(cache_path=cache_path, client=client)
            uri1 = await svc.get_hd_artwork(
                "Blinding Lights (Official Audio)", "The Weeknd - Topic"
            )
            assert uri1 and uri1.startswith("data:image/jpeg;base64,")
            assert len(calls) == 2, f"Expected 2 HTTP calls (search + img), got {calls}"

            # Persistent cache reload must make zero HTTP requests
            svc2 = ArtworkService(cache_path=cache_path, client=client)
            uri2 = await svc2.get_hd_artwork("Blinding Lights", "The Weeknd")
            assert uri2 == uri1
            assert len(calls) == 2

            # Deezer empty -> iTunes 1200x1200 fallback
            uri3 = await svc2.get_hd_artwork("FallbackTrack [Lyrics]", "Indie Artist")
            assert uri3 and uri3.startswith("data:image/png;base64,")
            assert any("1200x1200bb.jpg" in u for u in calls), calls

            # Real 1024x1024 image -> resized to <= 512x512 WebP/JPEG
            real_uri = await svc2._download_data_uri("https://cdn.example/1024x1024-real.png")
            assert real_uri and (
                real_uri.startswith("data:image/webp;base64,")
                or real_uri.startswith("data:image/jpeg;base64,")
            ), f"Unexpected resized mime: {real_uri[:40] if real_uri else None}"
            raw_resized = base64.b64decode(real_uri.split(",", 1)[1])
            with Image.open(io.BytesIO(raw_resized)) as im:
                assert im.size == (512, 512), f"Expected (512, 512), got {im.size}"

    print("[PASS] ArtworkService: Deezer + iTunes 1200px fallback + 512x512 resize + local cache")


class _SwitchableSMTC:
    def __init__(self, thumb: str) -> None:
        self.thumb = thumb
        self.active = False
        self.polls = 0

    async def get_media_state(self, force_thumbnail: bool = False):
        if not self.active:
            return None
        self.polls += 1
        return {
            "track_id": "track-hd-1",
            "title": "Blinding Lights",
            "artist": "The Weeknd",
            "album": "After Hours",
            "playback_status": "playing",
            "position": 10.0 + self.polls * 0.25,
            "duration": 200.0,
            "thumbnail": self.thumb,
            "updated_at": time.time(),
        }

    async def send_command(self, action: str) -> tuple[bool, str]:
        return True, "ok"


async def test_artwork_server_upgrade() -> None:
    hd_bytes = b"\xff\xd8\xff\xe0" + (b"\x44" * 256)
    smtc_thumb = "data:image/png;base64,LOWRES200"

    async def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if "api.deezer.com" in url:
            await asyncio.sleep(0.08)
            return httpx.Response(
                200,
                json={
                    "data": [
                        {
                            "title": "Blinding Lights",
                            "artist": {"name": "The Weeknd"},
                            "album": {"cover_xl": "https://cdn.example/1000x1000.jpg"},
                        }
                    ]
                },
            )
        if "1000x1000.jpg" in url:
            return httpx.Response(200, content=hd_bytes, headers={"Content-Type": "image/jpeg"})
        return httpx.Response(404)

    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        smtc = _SwitchableSMTC(smtc_thumb)
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            artwork = ArtworkService(cache_path=tmp_dir / "artwork.json", client=client)
            server = MusicOverlayServer(
                host="127.0.0.1",
                port=0,
                smtc=smtc,  # type: ignore[arg-type]
                lyrics=LyricsService(cache_path=tmp_dir / "lyrics.json", client=client),
                history=HistoryStore(history_path=tmp_dir / "history.json"),
                artwork=artwork,
            )
            server._schedule_lyrics_fetch = lambda *a, **kw: None  # type: ignore[method-assign]
            await server.start()
            try:
                async with connect(f"ws://127.0.0.1:{server.port}") as ws:
                    smtc.active = True
                    server._poll_wakeup.set()

                    thumbs: list[str] = []
                    deadline = time.monotonic() + 2.5
                    while time.monotonic() < deadline and len(thumbs) < 2:
                        raw = await asyncio.wait_for(ws.recv(), timeout=1.0)
                        if isinstance(raw, (bytes, bytearray)):
                            continue
                        msg = json.loads(raw)
                        if msg.get("type") == "state" and msg.get("media"):
                            t = msg["media"].get("thumbnail")
                            if t and (not thumbs or thumbs[-1] != t):
                                thumbs.append(t)

                    assert thumbs[0] == smtc_thumb, f"First thumb must be instant SMTC: {thumbs}"
                    assert thumbs[1].startswith("data:image/jpeg;base64,"), f"Missing HD upgrade: {thumbs}"

                    # Verify repeated SMTC polls do not revert HD artwork back to smtc_thumb
                    await asyncio.sleep(0.35)
                    assert server.current_media["thumbnail"] == thumbs[1]
            finally:
                await server.stop()

    print("[PASS] Server HD artwork: instant SMTC then HD upgrade preserved across polls")


class _MockControllableAudio:
    def __init__(self) -> None:
        self.active = False
        self.armed = False
        self.cb = None
        self.calls = 0

    def start(self) -> bool:
        return True

    def stop(self) -> None:
        pass

    def check_and_rebind(self) -> bool:
        return False

    def set_signal_callback(self, cb) -> None:
        self.cb = cb

    def arm_signal_wakeup(self, armed: bool = True) -> None:
        self.armed = bool(armed)

    def trigger_audio(self) -> None:
        self.active = True
        if self.armed and self.cb:
            self.armed = False
            self.cb()

    def get_binary_frame(self) -> tuple[bytes, float, float, bool]:
        self.calls += 1
        if self.active:
            return bytes([180] * 64), 0.7, 0.7, True
        return b"\x00" * 64, 0.0, 0.0, False


async def test_audio_deep_idle_and_pause() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        audio = _MockControllableAudio()
        server = MusicOverlayServer(
            host="127.0.0.1",
            port=0,
            smtc=_SlowSMTC(),  # type: ignore[arg-type]
            audio=audio,  # type: ignore[arg-type]
            lyrics=LyricsService(cache_path=tmp_dir / "lyrics.json"),
            history=HistoryStore(history_path=tmp_dir / "history.json"),
        )
        await server.start()
        try:
            async with connect(f"ws://127.0.0.1:{server.port}") as ws:
                # Drain initial JSON snapshot
                seen_init: set[str] = set()
                while not {"state", "lyrics", "history"}.issubset(seen_init):
                    raw = await asyncio.wait_for(ws.recv(), timeout=1.0)
                    if isinstance(raw, str):
                        m = json.loads(raw)
                        if m.get("type"):
                            seen_init.add(m["type"])

                # Wait past 2.0s silence threshold so server enters deep-idle
                deadline = time.monotonic() + 2.4
                while time.monotonic() < deadline:
                    try:
                        await asyncio.wait_for(ws.recv(), timeout=0.1)
                    except asyncio.TimeoutError:
                        pass

                # During deep-idle, zero binary frames sent and polling is ~5Hz
                calls_before = audio.calls
                await asyncio.sleep(0.55)
                calls_delta = audio.calls - calls_before
                assert 1 <= calls_delta <= 5, f"Expected ~5Hz deep-idle polling, got {calls_delta} calls in 0.55s"
                assert audio.armed is True, "Expected signal wakeup armed during deep-idle"

                got_unexpected_binary = False
                try:
                    msg = await asyncio.wait_for(ws.recv(), timeout=0.1)
                    if isinstance(msg, (bytes, bytearray)):
                        got_unexpected_binary = True
                except asyncio.TimeoutError:
                    pass
                assert not got_unexpected_binary, "Should stop broadcasting audio frames in deep-idle"

                # Instant wakeup when audio signal returns
                t_wake = time.monotonic()
                audio.trigger_audio()
                resumed_frame = await asyncio.wait_for(ws.recv(), timeout=0.12)
                wake_ms = (time.monotonic() - t_wake) * 1000.0
                assert isinstance(resumed_frame, (bytes, bytearray)) and len(resumed_frame) == 64
                assert max(resumed_frame) == 180

                # Explicit occlusion pause stops binary streaming until resumed
                await ws.send(json.dumps({"type": "command", "action": "set_audio_paused", "paused": True}))
                ack_pause = None
                for _ in range(30):
                    raw = await asyncio.wait_for(ws.recv(), timeout=0.5)
                    if isinstance(raw, str):
                        m = json.loads(raw)
                        if m.get("type") == "ack" and m.get("command") == "set_audio_paused":
                            ack_pause = m
                            break
                assert ack_pause and ack_pause.get("ok") is True

                await asyncio.sleep(0.15)
                paused_binary = False
                try:
                    while True:
                        raw = await asyncio.wait_for(ws.recv(), timeout=0.1)
                        if isinstance(raw, (bytes, bytearray)):
                            paused_binary = True
                except asyncio.TimeoutError:
                    pass
                assert not paused_binary, "Audio frames leaked while client paused"

                await ws.send(json.dumps({"type": "command", "action": "set_audio_paused", "paused": False}))
                resumed_after_pause = None
                for _ in range(10):
                    raw = await asyncio.wait_for(ws.recv(), timeout=0.5)
                    if isinstance(raw, (bytes, bytearray)):
                        resumed_after_pause = raw
                        break
                assert resumed_after_pause and len(resumed_after_pause) == 64
                print(f"[PASS] Audio deep-idle (5Hz={calls_delta}/0.55s, wake={wake_ms:.1f}ms) + occlusion pause")
        finally:
            await server.stop()


async def main() -> None:
    test_fft_processor()
    test_lrc_parser()
    await test_lyrics_service()
    await test_artwork_service()
    test_history_store()
    await test_live_probes()
    await test_audio_auto_rebind()
    await test_nonblocking_startup_and_com_apartment()
    await test_artwork_server_upgrade()
    await test_audio_deep_idle_and_pause()
    await test_ws_server_integration()
    print("ALL PHASE 1 TESTS PASSED")


if __name__ == "__main__":
    asyncio.run(main())
