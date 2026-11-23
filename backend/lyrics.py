"""Synced lyrics fetcher (lrclib.net), LRC parser, and local JSON cache."""

from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path
import re
import time
from typing import Any

import httpx

from .config import (
    LRCLIB_BASE_URL,
    LRCLIB_USER_AGENT,
    LYRICS_CACHE_PATH,
    LYRICS_NOT_FOUND_TTL_SECONDS,
)

logger = logging.getLogger(__name__)

_OFFSET_RE = re.compile(r"^\s*\[offset\s*:\s*([+-]?\d+)\s*\]\s*$", re.IGNORECASE)
_TIME_TAG_RE = re.compile(r"\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]")
_META_TAG_RE = re.compile(r"^\s*\[[a-zA-Z]{1,10}\s*:[^\]]*\]\s*$")
_WORD_SYNC_TAG_RE = re.compile(r"<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>")

_TITLE_NOISE_RE = re.compile(
    r"\s*(?:\([^)]*\b(?:official(?:\s+(?:music|lyric)?\s*(?:video|audio))?|lyrics?|lyric\s+video|audio|music\s+video|visualizer|hd|4k|hq|remaster(?:ed)?)\b[^)]*\)|"
    r"\[[^\]]*\b(?:official(?:\s+(?:music|lyric)?\s*(?:video|audio))?|lyrics?|lyric\s+video|audio|music\s+video|visualizer|hd|4k|hq|remaster(?:ed)?)\b[^\]]*\])",
    re.IGNORECASE,
)
_TITLE_TRAILING_NOISE_RE = re.compile(
    r"\s*(?:[-–—|]\s*(?:official(?:\s+(?:music|lyric)?\s*(?:video|audio))?|lyrics?(?:\s+video)?|audio|music\s+video|visualizer))+\s*$",
    re.IGNORECASE,
)
_ARTIST_TOPIC_RE = re.compile(r"\s*[-–—]\s*Topic$", re.IGNORECASE)


def parse_lrc(lrc_text: str | None) -> list[dict[str, Any]]:
    """Parse standard or enhanced LRC text into sorted [{time, text}] dicts."""
    if not lrc_text:
        return []

    offset_sec = 0.0
    parsed: list[dict[str, Any]] = []

    for raw_line in lrc_text.splitlines():
        line = raw_line.strip()
        if not line:
            continue

        offset_match = _OFFSET_RE.match(line)
        if offset_match:
            offset_sec = int(offset_match.group(1)) / 1000.0
            continue

        tags = list(_TIME_TAG_RE.finditer(line))
        if not tags:
            if _META_TAG_RE.match(line):
                continue
            continue

        text = _TIME_TAG_RE.sub("", line)
        text = _WORD_SYNC_TAG_RE.sub("", text)
        text = re.sub(r"\s+", " ", text).strip()
        if not text:
            continue

        for m in tags:
            minutes = int(m.group(1))
            seconds = int(m.group(2))
            frac_str = m.group(3)
            frac = 0.0
            if frac_str:
                frac = int(frac_str) / (10 ** len(frac_str))
            timestamp = max(0.0, minutes * 60.0 + seconds + frac - offset_sec)
            parsed.append({"time": round(timestamp, 3), "text": text})

    parsed.sort(key=lambda item: item["time"])
    return parsed


def clean_title(title: str) -> str:
    """Strip YouTube/browser noise suffixes while preserving real version tags."""
    raw = (title or "").strip()
    cleaned = _TITLE_NOISE_RE.sub("", raw)
    cleaned = _TITLE_TRAILING_NOISE_RE.sub("", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned or raw


def clean_artist(artist: str) -> str:
    """Strip YouTube auto-generated '- Topic' suffix from artist names."""
    raw = (artist or "").strip()
    cleaned = _ARTIST_TOPIC_RE.sub("", raw)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned or raw


_clean_title = clean_title
_clean_artist = clean_artist


class LyricsService:
    """Fetches synced lyrics from lrclib.net with persistent local caching."""

    def __init__(
        self,
        cache_path: Path = LYRICS_CACHE_PATH,
        base_url: str = LRCLIB_BASE_URL,
        not_found_ttl: int = LYRICS_NOT_FOUND_TTL_SECONDS,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self.cache_path = Path(cache_path)
        self.base_url = base_url.rstrip("/")
        self.not_found_ttl = int(not_found_ttl)
        self._owns_client = client is None
        self._client = client
        self._cache: dict[str, dict[str, Any]] = self._load_cache()
        self._inflight: dict[str, asyncio.Task[dict[str, Any]]] = {}

    def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                timeout=8.0,
                headers={"User-Agent": LRCLIB_USER_AGENT},
            )
        return self._client

    def _load_cache(self) -> dict[str, dict[str, Any]]:
        if not self.cache_path.exists():
            return {}
        try:
            with self.cache_path.open("r", encoding="utf-8") as fh:
                data = json.load(fh)
            if isinstance(data, dict):
                return data
        except Exception as exc:
            logger.warning("Failed loading lyrics cache (%s): %s", self.cache_path, exc)
        return {}

    def _save_cache(self) -> None:
        self.cache_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = self.cache_path.with_suffix(".json.tmp")
        with tmp_path.open("w", encoding="utf-8") as fh:
            json.dump(self._cache, fh, ensure_ascii=False, indent=2)
        os.replace(tmp_path, self.cache_path)

    @staticmethod
    def _make_cache_key(title: str, artist: str, duration: float) -> str:
        norm_artist = re.sub(r"\s+", " ", (artist or "").strip().lower())
        norm_title = re.sub(r"\s+", " ", (title or "").strip().lower())
        dur_int = int(round(duration)) if duration and duration > 0 else 0
        return f"{norm_artist}::{norm_title}::{dur_int}"

    def _format_response(
        self,
        track_id: str,
        entry: dict[str, Any],
        cached: bool,
    ) -> dict[str, Any]:
        return {
            "track_id": track_id,
            "status": entry.get("status", "not_found"),
            "cached": cached,
            "instrumental": bool(entry.get("instrumental", False)),
            "lines": list(entry.get("lines") or []),
            "plain": entry.get("plain"),
        }

    def _pick_search_match(
        self, candidates: list[dict[str, Any]], duration: float
    ) -> dict[str, Any] | None:
        if not candidates:
            return None

        def _dur_diff(item: dict[str, Any]) -> float:
            d = item.get("duration")
            if duration > 0 and isinstance(d, (int, float)):
                return abs(float(d) - duration)
            return 9999.0

        synced = [c for c in candidates if c.get("syncedLyrics")]
        if synced:
            if duration > 0:
                close_synced = [c for c in synced if _dur_diff(c) <= 5.0]
                if close_synced:
                    close_synced.sort(key=_dur_diff)
                    return close_synced[0]
            return synced[0]

        if duration > 0:
            candidates_sorted = sorted(candidates, key=_dur_diff)
            return candidates_sorted[0]
        return candidates[0]

    def _record_to_entry(self, record: dict[str, Any] | None) -> dict[str, Any]:
        now = int(time.time())
        if not record:
            return {
                "status": "not_found",
                "instrumental": False,
                "lines": [],
                "plain": None,
                "fetched_at": now,
            }

        instrumental = bool(record.get("instrumental", False))
        synced_raw = record.get("syncedLyrics")
        plain_raw = record.get("plainLyrics")
        lines = parse_lrc(synced_raw)

        if lines:
            status = "synced"
        elif instrumental:
            status = "instrumental"
        elif plain_raw and str(plain_raw).strip():
            status = "plain"
        else:
            status = "not_found"

        return {
            "status": status,
            "instrumental": instrumental,
            "lines": lines,
            "plain": str(plain_raw).strip() if plain_raw else None,
            "fetched_at": now,
        }

    async def _fetch_from_lrclib(
        self, title: str, artist: str, album: str, duration: float
    ) -> dict[str, Any]:
        client = self._get_client()
        cleaned_title = clean_title(title)
        cleaned_artist = clean_artist(artist)

        params: dict[str, Any] = {
            "track_name": cleaned_title,
            "artist_name": cleaned_artist,
        }
        if album:
            params["album_name"] = album
        if duration and duration > 0:
            params["duration"] = int(round(duration))

        resp = await client.get(f"{self.base_url}/get", params=params)
        if resp.status_code == 200:
            return self._record_to_entry(resp.json())
        if resp.status_code != 404:
            resp.raise_for_status()

        if album:
            params_no_album = {k: v for k, v in params.items() if k != "album_name"}
            resp_no_album = await client.get(
                f"{self.base_url}/get", params=params_no_album
            )
            if resp_no_album.status_code == 200:
                return self._record_to_entry(resp_no_album.json())
            if resp_no_album.status_code != 404:
                resp_no_album.raise_for_status()

        search_params: dict[str, Any] = {"track_name": cleaned_title}
        if cleaned_artist:
            search_params["artist_name"] = cleaned_artist

        search_resp = await client.get(f"{self.base_url}/search", params=search_params)
        if search_resp.status_code == 200:
            results = search_resp.json()
            if isinstance(results, list):
                picked = self._pick_search_match(results, duration)
                return self._record_to_entry(picked)
        elif search_resp.status_code != 404:
            search_resp.raise_for_status()

        return self._record_to_entry(None)

    async def get_lyrics(
        self,
        track_id: str,
        title: str,
        artist: str,
        album: str = "",
        duration: float = 0.0,
        force_refresh: bool = False,
    ) -> dict[str, Any]:
        """Return cached or freshly fetched lyrics for the specified track."""
        cleaned_title = clean_title(title)
        cleaned_artist = clean_artist(artist)
        if not cleaned_title:
            return {
                "track_id": track_id,
                "status": "not_found",
                "cached": False,
                "instrumental": False,
                "lines": [],
                "plain": None,
            }

        cache_key = self._make_cache_key(cleaned_title, cleaned_artist, duration)
        if not force_refresh and cache_key in self._cache:
            cached_entry = self._cache[cache_key]
            age = int(time.time()) - int(cached_entry.get("fetched_at", 0))
            if cached_entry.get("status") != "not_found" or age < self.not_found_ttl:
                return self._format_response(track_id, cached_entry, cached=True)

        if not force_refresh and cache_key in self._inflight:
            entry = await self._inflight[cache_key]
            return self._format_response(track_id, entry, cached=False)

        async def _run_fetch() -> dict[str, Any]:
            try:
                entry = await self._fetch_from_lrclib(
                    cleaned_title, cleaned_artist, album, duration
                )
                self._cache[cache_key] = entry
                self._save_cache()
                return self._format_response(track_id, entry, cached=False)
            except Exception as exc:
                logger.warning("LRCLIB lookup failed for %r - %r: %s", artist, title, exc)
                return {
                    "track_id": track_id,
                    "status": "error",
                    "cached": False,
                    "instrumental": False,
                    "lines": [],
                    "plain": None,
                }

        task = asyncio.create_task(_run_fetch())
        self._inflight[cache_key] = task
        try:
            return await task
        finally:
            if self._inflight.get(cache_key) is task:
                self._inflight.pop(cache_key, None)

    async def close(self) -> None:
        """Close the internal httpx AsyncClient if owned by this instance."""
        if self._owns_client and self._client is not None:
            await self._client.aclose()
            self._client = None
