"""Interactive and timed CLI WebSocket test client for ws://localhost:8765."""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import sys
import time
from typing import Any

from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed


def _active_lyric(lines: list[dict[str, Any]], position: float) -> str:
    if not lines:
        return ""
    current = ""
    for line in lines:
        if float(line.get("time", 0.0)) <= position:
            current = str(line.get("text", ""))
        else:
            break
    return current


def _render_bars(bins: list[float], stride: int = 4) -> str:
    blocks = " ▁▂▃▄▅▆▇█"
    sampled = bins[::stride]
    chars = []
    for val in sampled:
        idx = min(len(blocks) - 1, max(0, int(round(float(val) * (len(blocks) - 1)))))
        chars.append(blocks[idx])
    return "".join(chars)


async def run_client(url: str, duration: float | None, command: str | None) -> None:
    state: dict[str, Any] | None = None
    lyrics: dict[str, Any] = {}
    audio_count = 0
    window_start = time.monotonic()
    last_print = window_start
    last_lyric_line = ""

    async with connect(url) as ws:
        print(f"Connected to {url}")
        if command:
            await ws.send(json.dumps({"type": "command", "action": command}))

        stop_event = asyncio.Event()

        async def _receiver() -> None:
            nonlocal state, lyrics, audio_count, window_start, last_print, last_lyric_line
            try:
                async for raw in ws:
                    msg = json.loads(raw)
                    mtype = msg.get("type")

                    if mtype == "state":
                        state = msg.get("media")
                        if state:
                            thumb = state.get("thumbnail") or ""
                            thumb_kb = len(thumb.encode("utf-8")) / 1024.0
                            print(
                                f"[STATE] {state.get('artist')} - {state.get('title')} "
                                f"| {state.get('playback_status')} "
                                f"{state.get('position', 0.0):.1f}/{state.get('duration', 0.0):.1f}s "
                                f"| thumb={thumb_kb:.1f}KB"
                            )
                        else:
                            print("[STATE] No active media")

                    elif mtype == "position":
                        if state is not None:
                            state["position"] = msg.get("position", 0.0)
                            state["playback_status"] = msg.get(
                                "playback_status", state.get("playback_status")
                            )
                        if lyrics.get("lines") and state is not None:
                            line = _active_lyric(
                                lyrics["lines"], float(state.get("position", 0.0))
                            )
                            if line and line != last_lyric_line:
                                last_lyric_line = line
                                print(f"[LYRIC] {line}")

                    elif mtype == "lyrics":
                        lyrics = msg
                        lines = msg.get("lines") or []
                        print(
                            f"[LYRICS] status={msg.get('status')} "
                            f"cached={msg.get('cached')} lines={len(lines)}"
                        )

                    elif mtype == "history":
                        recent = msg.get("recent") or []
                        pinned = msg.get("pinned") or []
                        print(
                            f"[HISTORY] recent={len(recent)} pinned={len(pinned)}"
                        )

                    elif mtype == "ack":
                        print(
                            f"[ACK] command={msg.get('command')} "
                            f"ok={msg.get('ok')} detail={msg.get('detail')}"
                        )

                    elif mtype == "audio":
                        audio_count += 1
                        now = time.monotonic()
                        if now - last_print >= 1.0:
                            dt = now - window_start
                            hz = audio_count / max(0.01, dt)
                            bins = msg.get("bins") or []
                            eq = _render_bars(bins)
                            print(
                                f"[AUDIO] {hz:5.1f} Hz | bins={len(bins)} "
                                f"energy={msg.get('energy', 0.0):.3f} "
                                f"peak={msg.get('peak', 0.0):.3f} |{eq}|"
                            )
                            audio_count = 0
                            window_start = now
                            last_print = now

                    if stop_event.is_set():
                        break
            except ConnectionClosed:
                print("Connection closed by server")
                stop_event.set()

        async def _stdin_loop() -> None:
            valid = {
                "play",
                "pause",
                "play_pause",
                "next",
                "prev",
                "refresh_lyrics",
                "pin",
                "toggle_pin",
                "get_state",
            }
            print("Commands: play | pause | play_pause | next | prev | refresh_lyrics | pin | quit")
            while not stop_event.is_set():
                line = await asyncio.to_thread(sys.stdin.readline)
                if not line:
                    stop_event.set()
                    break
                cmd = line.strip()
                if not cmd:
                    continue
                if cmd in ("quit", "exit", "q"):
                    stop_event.set()
                    await ws.close()
                    break
                action = "toggle_pin" if cmd == "pin" else cmd
                if action not in valid:
                    print(f"Unknown command: {cmd}")
                    continue
                await ws.send(json.dumps({"type": "command", "action": action}))

        recv_task = asyncio.create_task(_receiver())
        input_task: asyncio.Task[None] | None = None

        if duration is not None:
            await asyncio.sleep(max(0.1, duration))
            stop_event.set()
            await ws.close()
        else:
            input_task = asyncio.create_task(_stdin_loop())
            await stop_event.wait()

        recv_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await recv_task
        if input_task is not None:
            input_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await input_task


def main() -> None:
    parser = argparse.ArgumentParser(description="Test client for Music Overlay WS backend")
    parser.add_argument("--url", default="ws://127.0.0.1:8765", help="WebSocket URL")
    parser.add_argument("--duration", type=float, default=None, help="Auto-exit after N seconds")
    parser.add_argument("--command", default=None, help="Send one command right after connect")
    args = parser.parse_args()

    try:
        asyncio.run(run_client(args.url, args.duration, args.command))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
