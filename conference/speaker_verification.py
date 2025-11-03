"""
Enterprise-grade Speaker Verification using SpeechBrain ECAPA-TDNN + Silero VAD.

✅ High accuracy & consistency across devices
✅ Multi-clip baseline averaging (up to 5 per user)
✅ Adaptive per-user thresholds (self-normalizing)
✅ Silero VAD for robust speech trimming
✅ Safe normalization & similarity clamping

API:
    enroll_voice(audio_bytes, room, username)
    verify_voice(audio_bytes, room, username)
"""

import os, io, subprocess, tempfile, shutil, logging
from pathlib import Path
from typing import Dict, Iterable, List
import numpy as np
import torch, torchaudio
from scipy.spatial.distance import cosine
from speechbrain.inference import EncoderClassifier
import imageio_ffmpeg

# -----------------------------------------------------------
# Configuration & Globals
# -----------------------------------------------------------
os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"
os.environ["HF_HUB_DISABLE_SYMLINKS"] = "1"

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

_MODEL = None
VOICE_BASELINES: Dict[str, List[np.ndarray]] = {}
USER_STATS: Dict[str, Dict[str, list | float]] = {}

SAMPLE_RATE = 16_000
TARGET_SPEECH_SECONDS = 3.2
MAX_BASELINE_CLIPS = 5

# -----------------------------------------------------------
# Model loader
# -----------------------------------------------------------
def get_model(device: str | None = None):
    global _MODEL
    if _MODEL is None:
        run_device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        save_dir = Path.cwd() / "models" / "spkrec-ecapa-voxceleb"
        save_dir.mkdir(parents=True, exist_ok=True)
        _MODEL = EncoderClassifier.from_hparams(
            source="speechbrain/spkrec-ecapa-voxceleb",
            savedir=str(save_dir),
            run_opts={"device": run_device},
        )
        logger.info("ECAPA-TDNN model loaded on %s", run_device)
    return _MODEL


# -----------------------------------------------------------
# Silero VAD loader
# -----------------------------------------------------------
_SILERO_VAD = None
_GET_SPEECH_TS = None

def get_vad():
    global _SILERO_VAD, _GET_SPEECH_TS
    if _SILERO_VAD is None:
        logger.info("Loading Silero VAD model...")
        _SILERO_VAD, utils = torch.hub.load('snakers4/silero-vad', 'silero_vad', trust_repo=True)
        _GET_SPEECH_TS = utils[0]  # get_speech_timestamps
        logger.info("Silero VAD loaded.")
    return _SILERO_VAD, _GET_SPEECH_TS


# -----------------------------------------------------------
# Audio preprocessing
# -----------------------------------------------------------
def _find_ffmpeg_exe() -> str:
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    return imageio_ffmpeg.get_ffmpeg_exe()


def _silero_crop(waveform: torch.Tensor, sr: int) -> torch.Tensor:
    """Crop to main voiced region using Silero VAD timestamps."""
    model, get_ts = get_vad()
    ts = get_ts(waveform.squeeze(), model, sampling_rate=sr)
    if not ts:
        return waveform
    start = ts[0]["start"]
    end = ts[-1]["end"]
    return waveform[:, start:end]


def audio_bytes_to_tensor(audio_bytes: bytes, sample_rate: int = SAMPLE_RATE):
    """Decode WebM/MP3/WAV → mono 16kHz, crop to voiced 3.2s region."""
    temp_in = temp_out = None
    try:
        ffmpeg = _find_ffmpeg_exe()
        with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as f:
            temp_in = f.name
            f.write(audio_bytes)
            f.flush()
        temp_out = temp_in.rsplit(".", 1)[0] + ".wav"
        cmd = [
            ffmpeg, "-y", "-nostdin", "-loglevel", "error",
            "-i", temp_in, "-ac", "1", "-ar", str(sample_rate),
            "-acodec", "pcm_s16le", temp_out,
        ]
        subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
        waveform, sr = torchaudio.load(temp_out)
        if waveform.numel() == 0:
            raise ValueError("Empty audio after decode.")
        if waveform.size(0) > 1:
            waveform = waveform.mean(dim=0, keepdim=True)

        waveform = waveform - waveform.mean()
        peak = waveform.abs().max()
        if peak > 0:
            waveform = waveform / peak
        waveform = torch.clamp(waveform, -1.0, 1.0)

        waveform = _silero_crop(waveform, sr)

        # Fixed-length center crop
        target = int(TARGET_SPEECH_SECONDS * sr)
        if waveform.shape[1] >= target:
            waveform = waveform[:, :target]
        else:
            pad = target - waveform.shape[1]
            waveform = torch.nn.functional.pad(waveform, (0, pad))

        duration = waveform.shape[1] / sr
        logger.info("Preprocessed: sr=%d, speech_dur=%.2fs", sr, duration)
        return waveform, sr
    finally:
        for p in (temp_in, temp_out):
            if p and os.path.exists(p):
                os.remove(p)


# -----------------------------------------------------------
# Embedding extraction
# -----------------------------------------------------------
def extract_embedding(audio_bytes: bytes) -> np.ndarray:
    waveform, sr = audio_bytes_to_tensor(audio_bytes)
    model = get_model()
    device = next(model.modules()).device
    waveform = waveform.to(device)

    with torch.no_grad():
        emb = model.encode_batch(waveform)
        emb = torch.nn.functional.normalize(emb, p=2, dim=-1).reshape(-1)
    emb_np = emb.cpu().numpy().astype(np.float32)
    emb_np /= np.linalg.norm(emb_np) + 1e-9
    return emb_np


# -----------------------------------------------------------
# Similarity & Threshold
# -----------------------------------------------------------
def compute_similarity(a: np.ndarray, b: np.ndarray) -> float:
    a = a / (np.linalg.norm(a) + 1e-9)
    b = b / (np.linalg.norm(b) + 1e-9)
    return float(np.clip(1.0 - cosine(a, b), 0.0, 1.0))


def _update_baseline_profile(key: str) -> float:
    """Update cached stats about the enrolled baseline clips."""
    samples = VOICE_BASELINES.get(key) or []
    if not samples:
        USER_STATS.pop(key, None)
        return 0.0

    stats = USER_STATS.setdefault(key, {"samples": [], "mean": 0.0})
    if len(samples) > 1:
        pairwise_scores = [
            compute_similarity(samples[i], samples[j])
            for i in range(len(samples))
            for j in range(i + 1, len(samples))
        ]
        baseline_score = float(np.mean(pairwise_scores)) if pairwise_scores else 1.0
    else:
        baseline_score = 1.0

    stats["baseline_mean"] = baseline_score
    return baseline_score


def _derive_threshold(key: str, baseline_score: float | None = None, base_thresh: float = 0.6) -> float:
    """Blend baseline quality and recent verification matches into a working threshold."""
    stats = USER_STATS.get(key)
    threshold = base_thresh

    if baseline_score is None and stats:
        baseline_score = stats.get("baseline_mean")

    if baseline_score:
        threshold = max(threshold, min(0.9, baseline_score * 0.92))

    if stats:
        recent_samples = stats.get("samples") or []
        if recent_samples:
            recent_mean = float(np.mean(recent_samples[-5:]))
            threshold = max(threshold, min(0.9, recent_mean * 0.98))

    return float(np.clip(threshold, 0.5, 0.95))


def get_dynamic_threshold(key: str, base_thresh=0.60):
    """Compute adaptive threshold from baseline quality and recent samples."""
    return _derive_threshold(key, base_thresh=base_thresh)


# -----------------------------------------------------------
# Enrollment & Verification
# -----------------------------------------------------------
def enroll_voice(audio_bytes: bytes, room: str, user: str):
    key = f"{room}_{user}"
    try:
        new_emb = extract_embedding(audio_bytes)
        existing = VOICE_BASELINES.get(key)

        if not existing:
            VOICE_BASELINES[key] = [new_emb]
            msg = "Baseline enrolled (n=1)"
        else:
            if isinstance(existing, np.ndarray):
                existing = [existing]
            existing.append(new_emb)
            if len(existing) > MAX_BASELINE_CLIPS:
                existing = existing[-MAX_BASELINE_CLIPS:]
            VOICE_BASELINES[key] = existing
            msg = f"Baseline updated (n={len(existing)})"

        baseline_quality = _update_baseline_profile(key)
        threshold = _derive_threshold(key, baseline_quality)

        return {
            "success": True,
            "message": msg,
            "user_key": key,
            "threshold": threshold,
            "baseline_quality": baseline_quality,
        }
    except Exception as e:
        logger.exception("Enroll failed: %s", e)
        return {"success": False, "message": f"Enrollment failed: {e}"}


def enroll_voice_batch(audio_iterable: Iterable[bytes], room: str, user: str):
    key = f"{room}_{user}"
    try:
        embeddings = []
        for blob in audio_iterable:
            if not blob:
                continue
            emb = extract_embedding(blob)
            embeddings.append(emb)

        if not embeddings:
            raise ValueError("No valid audio samples provided.")

        USER_STATS.pop(key, None)
        baseline_samples = list(embeddings[-MAX_BASELINE_CLIPS:])
        VOICE_BASELINES[key] = baseline_samples
        baseline_quality = _update_baseline_profile(key)
        threshold = _derive_threshold(key, baseline_quality)
        return {
            "success": True,
            "message": f"Baseline updated (n={len(baseline_samples)})",
            "user_key": key,
            "threshold": threshold,
            "baseline_quality": baseline_quality,
        }
    except Exception as exc:
        logger.exception("Batch enroll failed: %s", exc)
        return {"success": False, "message": f"Enrollment failed: {exc}"}


def verify_voice(audio_bytes: bytes, room: str, user: str):
    key = f"{room}_{user}"
    base_list = VOICE_BASELINES.get(key)
    if not base_list:
        return {"success": False, "message": "No baseline found.", "percentage": 0}

    try:
        verify_emb = extract_embedding(audio_bytes)
        scores = [compute_similarity(base_emb, verify_emb) for base_emb in base_list]
        avg_sim = float(np.mean(scores))
        max_sim = float(np.max(scores))
        blended_sim = float(np.clip(max(avg_sim, max_sim * 0.95), 0.0, 1.0))

        stats = USER_STATS.setdefault(key, {"samples": [], "mean": 0.0})
        baseline_quality = stats.get("baseline_mean")
        if not baseline_quality:
            baseline_quality = _update_baseline_profile(key)
            stats = USER_STATS.setdefault(key, {"samples": [], "mean": 0.0})
        baseline_quality = float(baseline_quality or 0.75)

        # adaptive thresholding
        thresh = get_dynamic_threshold(key)
        relative_score = blended_sim / max(baseline_quality, 1e-6)
        relative_score = float(np.clip(relative_score, 0.0, 1.2))
        pct = round(min(relative_score, 1.0) * 100)

        high_cut = max(thresh * 1.03, baseline_quality * 0.95, 0.78)
        if blended_sim >= high_cut or relative_score >= 0.95:
            status = "high_confidence"
        elif blended_sim >= thresh:
            status = "medium_confidence"
        else:
            status = "suspicious"

        stats["samples"].append(blended_sim)
        if len(stats["samples"]) > 50:
            stats["samples"] = stats["samples"][-50:]
        stats["mean"] = float(np.mean(stats["samples"][-10:]))
        stats["last_score"] = blended_sim
        stats["best_score"] = max_sim
        stats["baseline_mean"] = baseline_quality

        best_relative = max(relative_score, stats.get("best_relative", 0.0))
        stats["best_relative"] = best_relative
        if status == "suspicious" and best_relative >= 0.85:
            status = "medium_confidence"

        return {
            "success": True,
            "similarity": blended_sim,
            "max_similarity": max_sim,
            "average_similarity": avg_sim,
            "relative_similarity": relative_score,
            "baseline_quality": baseline_quality,
            "percentage": pct,
            "status": status,
            "message": f"Voice match: {pct}% ({status})"
        }
    except Exception as e:
        logger.exception("Verify failed: %s", e)
        return {"success": False, "message": f"Verification failed: {e}", "percentage": 0}
