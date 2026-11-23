"""Real-time WASAPI loopback audio capture and 64-bin NumPy FFT processor."""

from __future__ import annotations

import ctypes
from ctypes import wintypes
import logging
import sys
import threading
import time
from typing import Any, Callable

import numpy as np
import pyaudiowpatch as pyaudio

from .config import FFT_BINS, FFT_MAX_FREQ, FFT_MIN_FREQ, FFT_SIZE

logger = logging.getLogger(__name__)


class _GUID(ctypes.Structure):
    _fields_ = [
        ("Data1", wintypes.DWORD),
        ("Data2", wintypes.WORD),
        ("Data3", wintypes.WORD),
        ("Data4", ctypes.c_ubyte * 8),
    ]


_COM_READY = False
if sys.platform == "win32":
    try:
        _ole32 = ctypes.windll.ole32
        _ole32.CoInitializeEx.argtypes = [ctypes.c_void_p, wintypes.DWORD]
        _ole32.CoInitializeEx.restype = ctypes.c_long
        _ole32.CoUninitialize.argtypes = []
        _ole32.CoUninitialize.restype = None
        _ole32.CLSIDFromString.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(_GUID)]
        _ole32.CLSIDFromString.restype = ctypes.c_long
        _ole32.CoCreateInstance.argtypes = [
            ctypes.POINTER(_GUID),
            ctypes.c_void_p,
            wintypes.DWORD,
            ctypes.POINTER(_GUID),
            ctypes.POINTER(ctypes.c_void_p),
        ]
        _ole32.CoCreateInstance.restype = ctypes.c_long
        _ole32.CoTaskMemFree.argtypes = [ctypes.c_void_p]
        _ole32.CoTaskMemFree.restype = None

        _CLSID_MMDeviceEnumerator = _GUID()
        _IID_IMMDeviceEnumerator = _GUID()
        if (
            _ole32.CLSIDFromString(
                "{BCDE0395-E52F-467C-8E3D-C4579291692E}",
                ctypes.byref(_CLSID_MMDeviceEnumerator),
            )
            == 0
            and _ole32.CLSIDFromString(
                "{A95664D2-9614-4F35-A746-DE8DB63617E6}",
                ctypes.byref(_IID_IMMDeviceEnumerator),
            )
            == 0
        ):
            _COM_READY = True
    except Exception:
        _COM_READY = False


def get_default_render_endpoint_id() -> str | None:
    """Return the active Windows default audio render endpoint ID, or None."""
    if not _COM_READY:
        return None

    co_init_hr = _ole32.CoInitializeEx(None, 0)
    should_uninit = co_init_hr in (0, 1)
    p_enum = ctypes.c_void_p()
    p_dev = ctypes.c_void_p()
    pwstr = wintypes.LPWSTR()

    try:
        hr = _ole32.CoCreateInstance(
            ctypes.byref(_CLSID_MMDeviceEnumerator),
            None,
            23,
            ctypes.byref(_IID_IMMDeviceEnumerator),
            ctypes.byref(p_enum),
        )
        if hr != 0 or not p_enum.value:
            return None

        vt_enum = ctypes.cast(
            ctypes.cast(p_enum, ctypes.POINTER(ctypes.c_void_p)).contents,
            ctypes.POINTER(ctypes.c_void_p),
        )
        get_default_endpoint = ctypes.WINFUNCTYPE(
            ctypes.c_long,
            ctypes.c_void_p,
            ctypes.c_int,
            ctypes.c_int,
            ctypes.POINTER(ctypes.c_void_p),
        )(vt_enum[4])

        # Try eConsole (0), fall back to eMultimedia (1)
        hr = get_default_endpoint(p_enum, 0, 0, ctypes.byref(p_dev))
        if hr != 0 or not p_dev.value:
            hr = get_default_endpoint(p_enum, 0, 1, ctypes.byref(p_dev))
            if hr != 0 or not p_dev.value:
                return None

        vt_dev = ctypes.cast(
            ctypes.cast(p_dev, ctypes.POINTER(ctypes.c_void_p)).contents,
            ctypes.POINTER(ctypes.c_void_p),
        )
        get_id = ctypes.WINFUNCTYPE(
            ctypes.c_long,
            ctypes.c_void_p,
            ctypes.POINTER(wintypes.LPWSTR),
        )(vt_dev[5])

        hr = get_id(p_dev, ctypes.byref(pwstr))
        if hr != 0 or not pwstr.value:
            return None
        return str(pwstr.value)
    except Exception:
        return None
    finally:
        if pwstr.value:
            try:
                _ole32.CoTaskMemFree(pwstr)
            except Exception:
                pass
        if p_dev.value:
            try:
                vt_dev = ctypes.cast(
                    ctypes.cast(p_dev, ctypes.POINTER(ctypes.c_void_p)).contents,
                    ctypes.POINTER(ctypes.c_void_p),
                )
                release_dev = ctypes.WINFUNCTYPE(ctypes.c_ulong, ctypes.c_void_p)(vt_dev[2])
                release_dev(p_dev)
            except Exception:
                pass
        if p_enum.value:
            try:
                vt_enum = ctypes.cast(
                    ctypes.cast(p_enum, ctypes.POINTER(ctypes.c_void_p)).contents,
                    ctypes.POINTER(ctypes.c_void_p),
                )
                release_enum = ctypes.WINFUNCTYPE(ctypes.c_ulong, ctypes.c_void_p)(vt_enum[2])
                release_enum(p_enum)
            except Exception:
                pass
        if should_uninit:
            try:
                _ole32.CoUninitialize()
            except Exception:
                pass


class FFTProcessor:
    """Transforms mono PCM frames into 64 smoothed, normalized [0.0..1.0] frequency bins."""

    def __init__(
        self,
        sample_rate: int = 48000,
        fft_size: int = FFT_SIZE,
        num_bins: int = FFT_BINS,
        min_freq: float = FFT_MIN_FREQ,
        max_freq: float = FFT_MAX_FREQ,
        attack: float = 0.78,
        decay: float = 0.28,
    ) -> None:
        self.sample_rate = max(8000, int(sample_rate))
        self.fft_size = int(fft_size)
        self.num_bins = int(num_bins)
        self.attack = float(attack)
        self.decay = float(decay)

        self._window = np.hanning(self.fft_size).astype(np.float32)
        self._window_norm = 2.0 / float(np.sum(self._window))

        nyquist = self.sample_rate * 0.5 - 1.0
        hi_freq = min(float(max_freq), max(float(min_freq) * 2.0, nyquist))
        freqs = np.fft.rfftfreq(self.fft_size, 1.0 / self.sample_rate)
        edges = np.geomspace(float(min_freq), hi_freq, self.num_bins + 1)

        self._band_slices: list[tuple[int, int]] = []
        max_fft_idx = len(freqs) - 1
        for idx in range(self.num_bins):
            lo = int(np.searchsorted(freqs, edges[idx], side="left"))
            hi = int(np.searchsorted(freqs, edges[idx + 1], side="left"))
            lo = min(max(1, lo), max_fft_idx)
            hi = min(max(lo + 1, hi), len(freqs))
            self._band_slices.append((lo, hi))

        self._tilt_db = np.interp(
            np.linspace(0.0, 1.0, self.num_bins),
            [0.0, 0.25, 1.0],
            [2.0, 0.0, 10.0],
        ).astype(np.float32)
        self._smoothed = np.zeros(self.num_bins, dtype=np.float32)
        self._noise_floor_db = -54.0
        self._peak_db = -18.0

    def _compute_smoothed(
        self, mono_samples: np.ndarray | None
    ) -> tuple[float, float, bool]:
        """Update smoothed 64-bin state and return (energy, peak, active)."""
        active = False
        target = np.zeros(self.num_bins, dtype=np.float32)

        if mono_samples is not None and len(mono_samples) >= self.fft_size:
            frame = np.asarray(mono_samples[-self.fft_size :], dtype=np.float32)
            rms = float(np.sqrt(np.mean(frame * frame)))
            if rms >= 1e-5:
                active = True
                centered = frame - float(np.mean(frame))
                spectrum = np.abs(np.fft.rfft(centered * self._window)) * self._window_norm

                band_mag = np.empty(self.num_bins, dtype=np.float32)
                for i, (lo, hi) in enumerate(self._band_slices):
                    seg = spectrum[lo:hi]
                    band_mag[i] = float(np.sqrt(np.mean(seg * seg)))

                band_db = 20.0 * np.log10(band_mag + 1e-9) + self._tilt_db
                frame_max_db = float(np.max(band_db))
                if frame_max_db > self._peak_db:
                    self._peak_db += 0.35 * (frame_max_db - self._peak_db)
                else:
                    self._peak_db += 0.008 * (frame_max_db - self._peak_db)
                self._peak_db = max(-18.0, self._peak_db)

                span = max(12.0, self._peak_db - self._noise_floor_db)
                norm = np.clip((band_db - self._noise_floor_db) / span, 0.0, 1.0)

                padded = np.pad(norm, 1, mode="edge")
                target = 0.08 * padded[:-2] + 0.84 * padded[1:-1] + 0.08 * padded[2:]

        rising = target > self._smoothed
        alpha = np.where(rising, self.attack, self.decay).astype(np.float32)
        self._smoothed = self._smoothed + alpha * (target - self._smoothed)
        self._smoothed = np.clip(self._smoothed, 0.0, 1.0)
        self._smoothed[self._smoothed < 0.002] = 0.0

        energy = float(np.mean(self._smoothed))
        peak = float(np.max(self._smoothed))
        return energy, peak, active

    def process(
        self, mono_samples: np.ndarray | None
    ) -> tuple[list[float], float, float, bool]:
        """Process mono samples and return (64_bins, energy, peak, active)."""
        energy, peak, active = self._compute_smoothed(mono_samples)
        bins = [round(float(x), 3) for x in self._smoothed]
        return bins, round(energy, 3), round(peak, 3), active

    def process_quantized(
        self, mono_samples: np.ndarray | None
    ) -> tuple[bytes, float, float, bool]:
        """Process mono samples and return (64_uint8_bytes, energy, peak, active)."""
        energy, peak, active = self._compute_smoothed(mono_samples)
        frame_bytes = (
            np.rint(self._smoothed * 255.0).clip(0.0, 255.0).astype(np.uint8).tobytes()
        )
        return frame_bytes, energy, peak, active


class AudioLoopbackCapture:
    """Captures Windows system audio via WASAPI Loopback and runs FFTProcessor."""

    def __init__(
        self,
        fft_size: int = FFT_SIZE,
        num_bins: int = FFT_BINS,
        min_freq: float = FFT_MIN_FREQ,
        max_freq: float = FFT_MAX_FREQ,
    ) -> None:
        self.fft_size = int(fft_size)
        self.num_bins = int(num_bins)
        self.min_freq = float(min_freq)
        self.max_freq = float(max_freq)

        self._lock = threading.Lock()
        self._lifecycle_lock = threading.RLock()
        self._ring = np.zeros(self.fft_size, dtype=np.float32)
        self._write_idx = 0
        self._last_audio_ts = 0.0
        self._last_signal_ts = 0.0
        self._last_start_attempt = 0.0
        self._signal_callback: Callable[[], None] | None = None
        self._signal_notify_armed = False

        self._pa: pyaudio.PyAudio | None = None
        self._stream: Any = None
        self._channels = 2
        self._sample_rate = 48000
        self._sample_dtype: Any = np.float32
        self._sample_scale = 1.0
        self.device_name: str | None = None
        self._bound_endpoint_id: str | None = None
        self.processor = FFTProcessor(
            sample_rate=self._sample_rate,
            fft_size=self.fft_size,
            num_bins=self.num_bins,
            min_freq=self.min_freq,
            max_freq=self.max_freq,
        )

    @staticmethod
    def _find_default_loopback_on(pa: pyaudio.PyAudio) -> dict[str, Any] | None:
        if hasattr(pa, "get_default_wasapi_loopback"):
            try:
                dev = pa.get_default_wasapi_loopback()
                if dev:
                    return dict(dev)
            except Exception as exc:
                logger.debug("get_default_wasapi_loopback failed: %s", exc)

        try:
            wasapi_info = pa.get_host_api_info_by_type(pyaudio.paWASAPI)
            default_out = pa.get_device_info_by_index(wasapi_info["defaultOutputDevice"])
            if not default_out.get("isLoopbackDevice", False):
                for lb in pa.get_loopback_device_info_generator():
                    if default_out["name"] in lb["name"]:
                        return dict(lb)
            return dict(default_out)
        except Exception as exc:
            logger.debug("Fallback WASAPI loopback lookup failed: %s", exc)
            return None

    @classmethod
    def get_default_loopback_device(cls) -> dict[str, Any] | None:
        """Probe and return the default Windows WASAPI loopback device info."""
        with pyaudio.PyAudio() as pa:
            return cls._find_default_loopback_on(pa)

    def set_signal_callback(self, callback: Callable[[], None] | None) -> None:
        """Register an optional callback fired when audio returns while idle-armed."""
        self._signal_callback = callback

    def arm_signal_wakeup(self, armed: bool = True) -> None:
        """Enable or disable one-shot callback notification on next non-silent buffer."""
        self._signal_notify_armed = bool(armed)

    def _stream_callback(
        self,
        in_data: bytes | None,
        frame_count: int,
        time_info: dict[str, Any],
        status_flags: int,
    ) -> tuple[None, int]:
        if in_data:
            samples = np.frombuffer(in_data, dtype=self._sample_dtype)
            if self._channels > 1:
                usable = (len(samples) // self._channels) * self._channels
                if usable > 0:
                    mono = samples[:usable].reshape(-1, self._channels).mean(axis=1)
                else:
                    mono = np.empty(0, dtype=np.float32)
            else:
                mono = samples

            if len(mono) > 0:
                if mono.dtype == np.float32 and self._sample_scale == 1.0:
                    mono_f32 = mono.ravel()
                else:
                    mono_f32 = (mono.astype(np.float32) * self._sample_scale).ravel()

                has_signal = False
                if float(np.max(np.abs(mono_f32))) >= 1e-5:
                    rms = float(np.sqrt(np.mean(mono_f32 * mono_f32)))
                    has_signal = rms >= 1e-5

                now_mono = time.monotonic()
                if len(mono_f32) >= self.fft_size:
                    with self._lock:
                        self._ring[:] = mono_f32[-self.fft_size :]
                        self._write_idx = 0
                        self._last_audio_ts = now_mono
                        if has_signal:
                            self._last_signal_ts = now_mono
                else:
                    n = len(mono_f32)
                    with self._lock:
                        end = self._write_idx + n
                        if end <= self.fft_size:
                            self._ring[self._write_idx : end] = mono_f32
                        else:
                            first = self.fft_size - self._write_idx
                            self._ring[self._write_idx :] = mono_f32[:first]
                            self._ring[: n - first] = mono_f32[first:]
                        self._write_idx = end % self.fft_size
                        self._last_audio_ts = now_mono
                        if has_signal:
                            self._last_signal_ts = now_mono

                if has_signal and self._signal_notify_armed:
                    self._signal_notify_armed = False
                    cb = self._signal_callback
                    if cb is not None:
                        try:
                            cb()
                        except Exception:
                            pass

        return (None, pyaudio.paContinue)

    def is_running(self) -> bool:
        """Return True when the WASAPI loopback callback stream is active."""
        stream = self._stream
        if stream is None:
            return False
        try:
            return bool(stream.is_active())
        except Exception:
            return False

    def start(self) -> bool:
        """Open and start the WASAPI loopback callback stream."""
        with self._lifecycle_lock:
            self._last_start_attempt = time.monotonic()
            if self.is_running():
                return True
            if self._stream is not None or self._pa is not None:
                self.stop()

            try:
                self._pa = pyaudio.PyAudio()
                dev = self._find_default_loopback_on(self._pa)
                if not dev:
                    logger.warning("No WASAPI loopback audio device found")
                    self.stop()
                    return False

                self.device_name = str(dev.get("name", "Unknown Loopback"))
                self._channels = max(1, int(dev.get("maxInputChannels", 2)))
                self._sample_rate = max(8000, int(dev.get("defaultSampleRate", 48000)))

                if self._sample_rate != self.processor.sample_rate:
                    self.processor = FFTProcessor(
                        sample_rate=self._sample_rate,
                        fft_size=self.fft_size,
                        num_bins=self.num_bins,
                        min_freq=self.min_freq,
                        max_freq=self.max_freq,
                    )

                formats = [
                    (pyaudio.paFloat32, np.float32, 1.0),
                    (pyaudio.paInt16, np.int16, 1.0 / 32768.0),
                ]
                frames_per_buffer = max(512, min(1024, self._sample_rate // 50))
                last_err: Exception | None = None

                for pa_fmt, np_dtype, scale in formats:
                    try:
                        self._sample_dtype = np_dtype
                        self._sample_scale = scale
                        self._stream = self._pa.open(
                            format=pa_fmt,
                            channels=self._channels,
                            rate=self._sample_rate,
                            input=True,
                            input_device_index=int(dev["index"]),
                            frames_per_buffer=frames_per_buffer,
                            stream_callback=self._stream_callback,
                        )
                        self._stream.start_stream()
                        self._bound_endpoint_id = get_default_render_endpoint_id()
                        logger.info(
                            "WASAPI loopback started: %s (%d Hz, %d ch)",
                            self.device_name,
                            self._sample_rate,
                            self._channels,
                        )
                        return True
                    except Exception as exc:
                        last_err = exc
                        self._stream = None

                logger.warning("Failed opening WASAPI loopback stream: %s", last_err)
                self.stop()
                return False
            except Exception as exc:
                logger.warning("Failed initializing PyAudio WASAPI loopback: %s", exc)
                self.stop()
                return False

    def stop(self) -> None:
        """Stop and clean up the PyAudio stream and instance."""
        with self._lifecycle_lock:
            if self._stream is not None:
                try:
                    if self._stream.is_active():
                        self._stream.stop_stream()
                except Exception:
                    pass
                try:
                    self._stream.close()
                except Exception:
                    pass
                self._stream = None

            if self._pa is not None:
                try:
                    self._pa.terminate()
                except Exception:
                    pass
                self._pa = None

    def check_and_rebind(self) -> bool:
        """Rebind WASAPI loopback if stopped or if Windows default render endpoint changed."""
        with self._lifecycle_lock:
            current_id = get_default_render_endpoint_id()
            if not self.is_running():
                return self.start()

            if current_id is not None and current_id != self._bound_endpoint_id:
                logger.info(
                    "Default audio output changed (%s -> %s); rebinding WASAPI loopback",
                    self._bound_endpoint_id,
                    current_id,
                )
                self.stop()
                with self._lock:
                    self._ring.fill(0.0)
                    self._write_idx = 0
                    self._last_audio_ts = 0.0
                    self._last_signal_ts = 0.0
                return self.start()
            return False

    def _snapshot_samples(self) -> np.ndarray | None:
        now = time.monotonic()
        if now - self._last_audio_ts > 0.12:
            return None
        with self._lock:
            idx = self._write_idx
            if idx == 0:
                return self._ring.copy()
            return np.concatenate((self._ring[idx:], self._ring[:idx]))

    def get_frame(self) -> dict[str, Any]:
        """Return latest smoothed 64-bin FFT payload, decaying cleanly on silence."""
        bins, energy, peak, active = self.processor.process(self._snapshot_samples())
        return {
            "bins": bins,
            "energy": energy,
            "peak": peak,
            "active": active,
        }

    def get_binary_frame(self) -> tuple[bytes, float, float, bool]:
        """Return latest smoothed 64-byte quantized FFT payload and activity stats."""
        return self.processor.process_quantized(self._snapshot_samples())
