"""High-resolution album artwork fetcher (Deezer + iTunes fallback) with local cache."""

from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import os
from pathlib import Path
import re
import time
from typing import Any

import httpx

try:
    from PIL import Image, ImageOps
except ImportError:  # pragma: no cover - optional fallback if Pillow absent
    Image = None  # type: ignore[assignment]
    ImageOps = None  # type: ignore[assignment]

from .config import (
    ARTWORK_CACHE_MAX_ENTRIES,
    ARTWORK_CACHE_PATH,
    ARTWORK_MAX_IMAGE_BYTES,
    ARTWORK_NOT_FOUND_TTL_SECONDS,
    DEEZER_SEARCH_URL,
    ITUNES_SEARCH_URL,
    LRCLIB_USER_AGENT,
)
from .lyrics import clean_artist, clean_title

logger = logging.getLogger(__name__)

_ITUNES_SIZE_RE = re.compile(r"/\d+x\d+bb([.-])", re.IGNORECASE)
_PRIMARY_ARTIST_SPLIT_RE = re.compile(r"\s*(?:,|&|\bfeat\.?\b|\bft\.?\b|\bx\b)\s*", re.IGNORECASE)
_NON_ALNUM_RE = re.compile(r"[^a-z0-9\s]+")

ARTWORK_MAX_DIMENSION = 512
ARTWORK_WEBP_QUALITY = 88
ARTWORK_JPEG_QUALITY = 90


def _resize_cover_bytes(raw: bytes, fallback_mime: str) -> tuple[bytes, str, bool]:
    """Resize cover artwork to max 512x512 and encode as high-quality WebP/JPEG."""
    if Image is None:
        return raw, fallback_mime, False
    try:
        with Image.open(io.BytesIO(raw)) as opened:
            img = ImageOps.exif_transpose(opened) if ImageOps is not None else opened
            try:
                width, height = img.size
                was_resized = max(width, height) > ARTWORK_MAX_DIMENSION
                if was_resized:
                    resample = (
                        Image.Resampling.LANCZOS
                        if hasattr(Image, "Resampling")
                        else Image.LANCZOS
                    )
                    img.thumbnail((ARTWORK_MAX_DIMENSION, ARTWORK_MAX_DIMENSION), resample)

                has_alpha = img.mode in ("RGBA", "LA") or (
                    img.mode == "P" and "transparency" in img.info
                )
                target = img.convert("RGBA" if has_alpha else "RGB")
                try:
                    out = io.BytesIO()
                    try:
                        target.save(
                            out,
                            format="WEBP",
                            quality=ARTWORK_WEBP_QUALITY,
                            method=4,
                        )
                        encoded_bytes = out.getvalue()
                        out_mime = "image/webp"
                    except Exception:
                        out = io.BytesIO()
                        rgb = target.convert("RGB")
                        try:
                            rgb.save(
                                out,
                                format="JPEG",
                                quality=ARTWORK_JPEG_QUALITY,
                                optimize=True,
                            )
                        finally:
                            if rgb is not target:
                                rgb.close()
                        encoded_bytes = out.getvalue()
                        out_mime = "image/jpeg"
                finally:
                    if target is not img:
                        target.close()

                if not was_resized and len(encoded_bytes) >= len(raw):
                    return raw, fallback_mime, True
                return encoded_bytes, out_mime, True
            finally:
                if img is not opened:
                    img.close()
    except Exception:
        return raw, fallback_mime, False


def _norm_cmp(text: str | None) -> str:
    lowered = (text or "").strip().lower()
    stripped = _NON_ALNUM_RE.sub(" ", lowered)
    return re.sub(r"\s+", " ", stripped).strip()


def upgrade_itunes_artwork_url(url: str) -> str:
    """Convert iTunes 100x100 thumbnail URL into 1200x1200bb resolution URL."""
    upgraded, count = _ITUNES_SIZE_RE.subn(r"/1200x1200bb\1", url)
    if count > 0:
        return upgraded
    return url.replace("100x100bb", "1200x1200bb")


def _guess_image_mime(data: bytes, header_ct: str | None) -> str:
    ct = (header_ct or "").split(";", 1)[0].strip().lower()
    if ct.startswith("image/"):
        return ct
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return "image/jpeg"


def _score_candidate(
    cand_title: str | None,
    cand_artist: str | None,
    target_title: str,
    target_artist: str,
) -> int:
    nt = _norm_cmp(cand_title)
    na = _norm_cmp(cand_artist)
    tt = _norm_cmp(target_title)
    ta = _norm_cmp(target_artist)
    score = 0

    if tt and nt:
        if nt == tt:
            score += 6
        elif tt in nt or nt in tt:
            score += 3
    if ta and na:
        if na == ta:
            score += 5
        elif ta in na or na in ta:
            score += 3
    return score


class ArtworkService:
    """Fetches 1000px-1200px album art via Deezer/iTunes with local JSON caching."""

    def __init__(
        self,
        cache_path: Path = ARTWORK_CACHE_PATH,
        deezer_url: str = DEEZER_SEARCH_URL,
        itunes_url: str = ITUNES_SEARCH_URL,
        not_found_ttl: int = ARTWORK_NOT_FOUND_TTL_SECONDS,
        max_entries: int = ARTWORK_CACHE_MAX_ENTRIES,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self.cache_path = Path(cache_path)
        self.deezer_url = deezer_url
        self.itunes_url = itunes_url
        self.not_found_ttl = int(not_found_ttl)
        self.max_entries = max(10, int(max_entries))
        self._owns_client = client is None
        self._client = client
        self._cache: dict[str, dict[str, Any]] = self._load_cache()
        self._inflight: dict[str, asyncio.Task[str | None]] = {}

    def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                timeout=8.0,
                follow_redirects=True,
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
            logger.warning("Failed loading artwork cache (%s): %s", self.cache_path, exc)
        return {}

    def _save_cache(self) -> None:
        while len(self._cache) > self.max_entries:
            oldest_key = min(
                self._cache,
                key=lambda k: int(self._cache[k].get("fetched_at", 0)),
            )
            self._cache.pop(oldest_key, None)

        self.cache_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = self.cache_path.with_suffix(".json.tmp")
        with tmp_path.open("w", encoding="utf-8") as fh:
            json.dump(self._cache, fh, ensure_ascii=False, indent=2)
        os.replace(tmp_path, self.cache_path)

    @staticmethod
    def _make_cache_key(title: str, artist: str) -> str:
        norm_artist = re.sub(r"\s+", " ", (artist or "").strip().lower())
        norm_title = re.sub(r"\s+", " ", (title or "").strip().lower())
        return f"{norm_artist}::{norm_title}"

    async def _search_deezer(self, title: str, artist: str) -> str | None:
        client = self._get_client()
        queries: list[str] = []
        if artist:
            queries.append(f'artist:"{artist}" track:"{title}"')
            primary_artist = _PRIMARY_ARTIST_SPLIT_RE.split(artist)[0].strip()
            if primary_artist and primary_artist != artist:
                queries.append(f'artist:"{primary_artist}" track:"{title}"')
            queries.append(f"{artist} {title}")
        else:
            queries.append(f'track:"{title}"')

        best_url: str | None = None
        best_score = -1

        for query in queries:
            try:
                resp = await client.get(self.deezer_url, params={"q": query, "limit": 5})
                if resp.status_code != 200:
                    continue
                payload = resp.json()
                items = payload.get("data") if isinstance(payload, dict) else None
                if not isinstance(items, list) or not items:
                    continue

                for item in items:
                    if not isinstance(item, dict):
                        continue
                    album = item.get("album") or {}
                    cover_url = album.get("cover_xl") or album.get("cover_big")
                    if not cover_url or not isinstance(cover_url, str):
                        continue
                    cand_title = item.get("title")
                    cand_artist = (item.get("artist") or {}).get("name")
                    score = _score_candidate(cand_title, cand_artist, title, artist)
                    if album.get("cover_xl"):
                        score += 1
                    if score > best_score:
                        best_score = score
                        best_url = cover_url

                if best_url and best_score >= 4:
                    return best_url
            except Exception as exc:
                logger.debug("Deezer search failed for %r: %s", query, exc)

        return best_url

    async def _search_itunes(self, title: str, artist: str) -> str | None:
        client = self._get_client()
        term = f"{artist} {title}".strip() if artist else title
        try:
            resp = await client.get(
                self.itunes_url,
                params={"term": term, "media": "music", "entity": "song", "limit": 5},
            )
            if resp.status_code != 200:
                return None
            payload = resp.json()
            items = payload.get("results") if isinstance(payload, dict) else None
            if not isinstance(items, list) or not items:
                return None

            best_url: str | None = None
            best_score = -1
            for item in items:
                if not isinstance(item, dict):
                    continue
                raw_url = item.get("artworkUrl100")
                if not raw_url or not isinstance(raw_url, str):
                    continue
                score = _score_candidate(
                    item.get("trackName"),
                    item.get("artistName"),
                    title,
                    artist,
                )
                if score > best_score:
                    best_score = score
                    best_url = upgrade_itunes_artwork_url(raw_url)
            return best_url
        except Exception as exc:
            logger.debug("iTunes search failed for %r: %s", term, exc)
            return None

    async def _download_data_uri(self, image_url: str) -> str | None:
        if not image_url or not image_url.startswith(("http://", "https://")):
            return None
        client = self._get_client()
        try:
            resp = await client.get(image_url)
            if resp.status_code != 200:
                return None
            raw = resp.content
            if not raw or len(raw) < 32 or len(raw) > ARTWORK_MAX_IMAGE_BYTES:
                return None
            ct = (resp.headers.get("content-type") or "").split(";", 1)[0].strip().lower()
            if ct and not ct.startswith("image/") and ct != "application/octet-stream":
                return None
            mime = _guess_image_mime(raw, ct)
            processed, out_mime, _ = await asyncio.to_thread(_resize_cover_bytes, raw, mime)
            encoded = base64.b64encode(processed).decode("ascii")
            return f"data:{out_mime};base64,{encoded}"
        except Exception as exc:
            logger.debug("Failed downloading HD artwork %s: %s", image_url, exc)
            return None

    async def _optimize_cached_data_uri(self, data_uri: str) -> str | None:
        header, sep, b64_payload = data_uri.partition(",")
        if not sep or ";base64" not in header:
            return None
        try:
            raw = base64.b64decode(b64_payload, validate=False)
        except Exception:
            return None
        mime = header[5:].split(";", 1)[0] or "image/jpeg"
        processed, out_mime, ok = await asyncio.to_thread(_resize_cover_bytes, raw, mime)
        if not ok or len(processed) >= len(raw):
            return None
        encoded = base64.b64encode(processed).decode("ascii")
        return f"data:{out_mime};base64,{encoded}"

    async def get_hd_artwork(self, title: str, artist: str) -> str | None:
        """Return a cached or freshly fetched HD cover data URI, or None."""
        cleaned_title = clean_title(title)
        cleaned_artist = clean_artist(artist)
        if not cleaned_title:
            return None

        cache_key = self._make_cache_key(cleaned_title, cleaned_artist)
        cached = self._cache.get(cache_key)
        if isinstance(cached, dict):
            status = cached.get("status")
            data_uri = cached.get("data_uri")
            if status == "found" and isinstance(data_uri, str) and data_uri.startswith("data:image/"):
                if not cached.get("optimized") and len(data_uri) > 100_000:
                    shrunk = await self._optimize_cached_data_uri(data_uri)
                    if shrunk and len(shrunk) < len(data_uri):
                        cached["data_uri"] = shrunk
                        data_uri = shrunk
                    cached["optimized"] = True
                    self._save_cache()
                cached["fetched_at"] = int(time.time())
                return data_uri
            age = int(time.time()) - int(cached.get("fetched_at", 0))
            if status == "not_found" and age < self.not_found_ttl:
                return None

        inflight = self._inflight.get(cache_key)
        if inflight is not None:
            return await inflight

        async def _run_fetch() -> str | None:
            now = int(time.time())
            try:
                source: str | None = None
                image_url = await self._search_deezer(cleaned_title, cleaned_artist)
                if image_url:
                    source = "deezer"
                else:
                    image_url = await self._search_itunes(cleaned_title, cleaned_artist)
                    if image_url:
                        source = "itunes"

                data_uri = await self._download_data_uri(image_url) if image_url else None
                if data_uri:
                    self._cache[cache_key] = {
                        "status": "found",
                        "source": source,
                        "image_url": image_url,
                        "data_uri": data_uri,
                        "optimized": True,
                        "fetched_at": now,
                    }
                    self._save_cache()
                    logger.info(
                        "Fetched HD artwork (%s) for %r - %r (%d KB)",
                        source,
                        cleaned_artist,
                        cleaned_title,
                        len(data_uri) // 1024,
                    )
                    return data_uri

                self._cache[cache_key] = {
                    "status": "not_found",
                    "source": None,
                    "image_url": None,
                    "data_uri": None,
                    "fetched_at": now,
                }
                self._save_cache()
                return None
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning(
                    "HD artwork lookup failed for %r - %r: %s",
                    cleaned_artist,
                    cleaned_title,
                    exc,
                )
                return None

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
