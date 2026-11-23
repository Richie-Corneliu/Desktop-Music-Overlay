"""Persistent recently played and pinned tracks history store."""

from __future__ import annotations

from datetime import datetime, timezone
import json
import logging
import os
from pathlib import Path
from typing import Any

from .config import HISTORY_MAX_RECENT, HISTORY_PATH, MAX_HISTORY_THUMB_BYTES

logger = logging.getLogger(__name__)


def _safe_thumbnail(thumb: str | None) -> str | None:
    if not thumb or not isinstance(thumb, str):
        return None
    if len(thumb.encode("utf-8")) > MAX_HISTORY_THUMB_BYTES:
        return None
    return thumb


class HistoryStore:
    """Stores recently played and pinned tracks in a local JSON file."""

    def __init__(
        self,
        history_path: Path = HISTORY_PATH,
        max_recent: int = HISTORY_MAX_RECENT,
    ) -> None:
        self.history_path = Path(history_path)
        self.max_recent = int(max_recent)
        self._data: dict[str, list[dict[str, Any]]] = self._load()
        self._last_recorded_id: str | None = (
            self._data["recent"][0]["track_id"] if self._data["recent"] else None
        )

    def _load(self) -> dict[str, list[dict[str, Any]]]:
        default: dict[str, list[dict[str, Any]]] = {"recent": [], "pinned": []}
        if not self.history_path.exists():
            return default
        try:
            with self.history_path.open("r", encoding="utf-8") as fh:
                raw = json.load(fh)
            if isinstance(raw, dict):
                recent = raw.get("recent")
                pinned = raw.get("pinned")
                return {
                    "recent": list(recent) if isinstance(recent, list) else [],
                    "pinned": list(pinned) if isinstance(pinned, list) else [],
                }
        except Exception as exc:
            logger.warning("Failed loading history file (%s): %s", self.history_path, exc)
        return default

    def _save(self) -> None:
        self.history_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = self.history_path.with_suffix(".json.tmp")
        with tmp_path.open("w", encoding="utf-8") as fh:
            json.dump(self._data, fh, ensure_ascii=False, indent=2)
        os.replace(tmp_path, self.history_path)

    def _pinned_ids(self) -> set[str]:
        return {item["track_id"] for item in self._data["pinned"] if "track_id" in item}

    def _sync_pinned_flags(self) -> None:
        pinned_ids = self._pinned_ids()
        for item in self._data["recent"]:
            item["pinned"] = item.get("track_id") in pinned_ids
        for item in self._data["pinned"]:
            item["pinned"] = True

    def _find_track(self, track_id: str) -> dict[str, Any] | None:
        for lst in (self._data["recent"], self._data["pinned"]):
            for item in lst:
                if item.get("track_id") == track_id:
                    return item
        return None

    def record_play(self, media: dict[str, Any] | None) -> bool:
        """Record a track play if it differs from the most recently recorded track."""
        if not media:
            return False
        track_id = media.get("track_id")
        title = str(media.get("title") or "").strip()
        if not track_id or not title:
            return False
        if track_id == self._last_recorded_id:
            return False

        now_iso = datetime.now(timezone.utc).isoformat()
        safe_thumb = _safe_thumbnail(media.get("thumbnail"))
        existing = next(
            (i for i, item in enumerate(self._data["recent"]) if item.get("track_id") == track_id),
            None,
        )

        if existing is not None:
            entry = self._data["recent"].pop(existing)
            entry["title"] = title
            entry["artist"] = str(media.get("artist") or "")
            entry["album"] = str(media.get("album") or "")
            entry["duration"] = float(media.get("duration") or 0.0)
            if safe_thumb is not None:
                entry["thumbnail"] = safe_thumb
            entry["played_at"] = now_iso
            entry["play_count"] = int(entry.get("play_count", 1)) + 1
        else:
            entry = {
                "track_id": track_id,
                "title": title,
                "artist": str(media.get("artist") or ""),
                "album": str(media.get("album") or ""),
                "duration": float(media.get("duration") or 0.0),
                "thumbnail": safe_thumb,
                "played_at": now_iso,
                "play_count": 1,
                "pinned": track_id in self._pinned_ids(),
            }

        self._data["recent"].insert(0, entry)
        del self._data["recent"][self.max_recent :]

        for pinned_item in self._data["pinned"]:
            if pinned_item.get("track_id") == track_id:
                pinned_item["title"] = entry["title"]
                pinned_item["artist"] = entry["artist"]
                pinned_item["album"] = entry["album"]
                pinned_item["duration"] = entry["duration"]
                if safe_thumb is not None:
                    pinned_item["thumbnail"] = safe_thumb
                pinned_item["played_at"] = now_iso
                pinned_item["play_count"] = entry["play_count"]

        self._sync_pinned_flags()
        self._last_recorded_id = track_id
        self._save()
        return True

    def pin_track(
        self, track_id: str, fallback_media: dict[str, Any] | None = None
    ) -> bool:
        """Pin a track by ID (using fallback_media if not yet in recent)."""
        if not track_id:
            return False
        if track_id in self._pinned_ids():
            return True

        source = self._find_track(track_id)
        if source is None and fallback_media and fallback_media.get("track_id") == track_id:
            source = {
                "track_id": track_id,
                "title": str(fallback_media.get("title") or ""),
                "artist": str(fallback_media.get("artist") or ""),
                "album": str(fallback_media.get("album") or ""),
                "duration": float(fallback_media.get("duration") or 0.0),
                "thumbnail": _safe_thumbnail(fallback_media.get("thumbnail")),
                "played_at": datetime.now(timezone.utc).isoformat(),
                "play_count": 1,
            }

        if source is None:
            return False

        pinned_entry = dict(source)
        pinned_entry["pinned"] = True
        self._data["pinned"].insert(0, pinned_entry)
        self._sync_pinned_flags()
        self._save()
        return True

    def unpin_track(self, track_id: str) -> bool:
        """Remove a track from pinned tracks."""
        if not track_id:
            return False
        before = len(self._data["pinned"])
        self._data["pinned"] = [
            item for item in self._data["pinned"] if item.get("track_id") != track_id
        ]
        if len(self._data["pinned"]) == before:
            return False
        self._sync_pinned_flags()
        self._save()
        return True

    def toggle_pin(
        self, track_id: str, fallback_media: dict[str, Any] | None = None
    ) -> tuple[bool, bool]:
        """Toggle pin status for track_id, returning (ok, is_now_pinned)."""
        if track_id in self._pinned_ids():
            return self.unpin_track(track_id), False
        ok = self.pin_track(track_id, fallback_media=fallback_media)
        return ok, ok

    def get_payload(self) -> dict[str, list[dict[str, Any]]]:
        """Return a shallow copy of recent and pinned lists."""
        return {
            "recent": [dict(item) for item in self._data["recent"]],
            "pinned": [dict(item) for item in self._data["pinned"]],
        }
