"""Download, validate and index the licensed cubed-data-v1 corpus.

The raw corpus stays under ``data/raw`` and is ignored by Git.  The generated
index contains only paths, verified move labels, timestamps and alignment
diagnostics.  It is safe to regenerate and intentionally keeps capture-level
train/validation/test splits to avoid frame leakage between the same solve.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

import cv2
import numpy as np


REPO_ID = "cubed-core/cubed-data-v1"
REQUIRED_LICENSE = "CC-BY-SA-4.0"
METADATA_PATTERNS = ["*.json", "*.md", "SHA256SUMS", "LICENSES/*", "schemas/*"]


def sha256_file(path: Path, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(chunk_size):
            digest.update(chunk)
    return digest.hexdigest()


def download(root: Path, full: bool) -> None:
    # Importato qui, e non a livello di modulo, cosi le altre funzioni di
    # questo file (usate anche dai test) non richiedono huggingface_hub, che
    # e' elencato solo in requirements-ml.txt e serve solo per il download.
    from huggingface_hub import snapshot_download

    patterns = None if full else METADATA_PATTERNS
    snapshot_download(
        REPO_ID,
        repo_type="dataset",
        local_dir=root,
        allow_patterns=patterns,
        max_workers=8,
    )


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def artifact_by_role(capture: dict[str, Any], role: str) -> dict[str, Any]:
    matches = [artifact for artifact in capture["artifacts"] if artifact["role"] == role]
    if len(matches) != 1:
        raise ValueError(f"{capture['capture_id']}: expected one {role}, found {len(matches)}")
    return matches[0]


def optional_artifact_by_role(capture: dict[str, Any], role: str) -> dict[str, Any] | None:
    matches = [artifact for artifact in capture["artifacts"] if artifact["role"] == role]
    if len(matches) > 1:
        raise ValueError(f"{capture['capture_id']}: expected at most one {role}, found {len(matches)}")
    return matches[0] if matches else None


def validate_artifact(root: Path, artifact: dict[str, Any], verify_hash: bool) -> Path:
    if artifact.get("public_license") != REQUIRED_LICENSE:
        raise ValueError(f"Unsupported license for {artifact['path']}: {artifact.get('public_license')}")
    path = root / artifact["path"]
    if not path.is_file():
        raise FileNotFoundError(path)
    if path.stat().st_size != artifact["bytes"]:
        raise ValueError(f"Size mismatch: {path}")
    if verify_hash and sha256_file(path) != artifact["sha256"]:
        raise ValueError(f"SHA-256 mismatch: {path}")
    return path


def crop_focus(frame: np.ndarray) -> np.ndarray:
    height, width = frame.shape[:2]
    portrait = height >= width
    source_width = round(width * (0.88 if portrait else 0.74))
    source_height = round(height * (0.68 if portrait else 0.86))
    source_x = round((width - source_width) / 2)
    source_y = round(height * 0.08) if portrait else round((height - source_height) / 2)
    source_y = max(0, min(height - source_height, source_y))
    crop = frame[source_y : source_y + source_height, source_x : source_x + source_width]
    size = (96, 128) if portrait else (128, 96)
    return cv2.resize(crop, size, interpolation=cv2.INTER_AREA)


def motion_signal(video_path: Path, target_fps: float = 30.0) -> tuple[np.ndarray, np.ndarray, float]:
    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise RuntimeError(f"Cannot open {video_path}")
    fps = float(capture.get(cv2.CAP_PROP_FPS))
    frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    every = max(1, round(fps / target_fps))
    times: list[float] = []
    values: list[float] = []
    previous: np.ndarray | None = None
    frame_index = 0
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        if frame_index % every == 0:
            focused = crop_focus(frame)
            gray = cv2.cvtColor(focused, cv2.COLOR_BGR2GRAY)
            if previous is None:
                values.append(0.0)
            else:
                delta = cv2.absdiff(previous, gray).astype(np.float32)
                center = delta[round(delta.shape[0] * 0.18) : round(delta.shape[0] * 0.86),
                               round(delta.shape[1] * 0.14) : round(delta.shape[1] * 0.86)]
                values.append(float(np.mean(center) * 0.82 + np.mean(delta) * 0.18))
            times.append(frame_index / fps)
            previous = gray
        frame_index += 1
    capture.release()
    if len(values) < 3:
        raise RuntimeError(f"Too few readable frames in {video_path}")
    signal = np.asarray(values, dtype=np.float32)
    signal = np.convolve(signal, np.ones(3, dtype=np.float32) / 3, mode="same")
    return np.asarray(times, dtype=np.float32), signal, frame_count / fps


def alignment_score(
    offset: float,
    move_times: np.ndarray,
    frame_times: np.ndarray,
    signal: np.ndarray,
) -> tuple[float, float]:
    indices = np.searchsorted(frame_times, move_times + offset)
    radius = max(1, round(0.11 / max(1e-3, float(np.median(np.diff(frame_times))))))
    peaks: list[float] = []
    in_range = 0
    for index in indices:
        if index < 0 or index >= len(signal):
            continue
        start = max(0, index - radius)
        end = min(len(signal), index + radius + 1)
        peaks.append(float(np.max(signal[start:end])))
        in_range += 1
    coverage = in_range / max(1, len(move_times))
    if coverage < 0.68 or not peaks:
        return -1e9, coverage
    baseline = float(np.median(signal))
    scale = max(0.5, float(np.percentile(signal, 90)) - baseline)
    normalized = (float(np.mean(peaks)) - baseline) / scale
    return normalized * (0.6 + coverage * 0.4), coverage


def estimate_video_offset(video_path: Path, moves: list[dict[str, Any]]) -> dict[str, float]:
    frame_times, signal, duration = motion_signal(video_path)
    move_times = np.asarray([move["t_ms"] / 1000 for move in moves], dtype=np.float32)
    solve_duration = float(move_times[-1]) if len(move_times) else 0.0
    maximum_offset = min(12.0, max(2.0, duration - solve_duration + 3.0))
    offsets = np.arange(-0.5, maximum_offset + 0.0001, 1 / 60, dtype=np.float32)
    ranked = [
        (alignment_score(float(offset), move_times, frame_times, signal), float(offset))
        for offset in offsets
    ]
    ranked.sort(reverse=True)
    (score, coverage), offset = ranked[0]
    runner_up = next((item for item in ranked[1:] if abs(item[1] - offset) >= 0.3), ranked[1])
    margin = max(0.0, score - runner_up[0][0])
    confidence = round(min(0.99, max(0.0, 0.48 + margin * 0.28 + coverage * 0.32)), 4)
    return {
        "source": "motion-alignment",
        "offset_seconds": round(offset, 6),
        "score": round(score, 5),
        "coverage": round(coverage, 5),
        "confidence": confidence,
        "duration_seconds": round(duration, 6),
    }


def teacher_timeline(
    root: Path,
    capture: dict[str, Any],
    session_moves: list[dict[str, Any]],
    verify_hash: bool,
) -> tuple[list[float], dict[str, float | str]] | None:
    """Return the authoritative frame timeline when the corpus provides one."""
    artifact = optional_artifact_by_role(capture, "teacher_truth")
    if artifact is None:
        return None
    truth_path = validate_artifact(root, artifact, verify_hash)
    truth = load_json(truth_path)
    truth_moves = truth.get("moves", [])
    clip = truth.get("clip", truth.get("video", {}))
    fps = float(clip.get("fps", 0))
    if fps <= 0 or len(truth_moves) != len(session_moves):
        raise ValueError(f"{capture['capture_id']}: invalid teacher timeline")
    if [move.get("move") for move in truth_moves] != [move.get("move") for move in session_moves]:
        raise ValueError(f"{capture['capture_id']}: teacher and BLE move streams differ")
    video_times = [float(move["frame"]) / fps for move in truth_moves]
    offsets = [
        video_time - float(move["t_ms"]) / 1000
        for video_time, move in zip(video_times, session_moves, strict=True)
    ]
    duration = float(clip.get("frame_count", 0)) / fps
    return video_times, {
        "source": "teacher-frame-index",
        "offset_seconds": round(float(np.median(offsets)), 6),
        "score": 1.0,
        "coverage": 1.0,
        "confidence": 1.0,
        "duration_seconds": round(duration, 6),
    }


def assign_splits(capture_ids: list[str]) -> dict[str, str]:
    ordered = sorted(capture_ids, key=lambda value: hashlib.sha256(value.encode()).hexdigest())
    train_end = round(len(ordered) * 0.72)
    validation_end = train_end + round(len(ordered) * 0.14)
    return {
        capture_id: "train" if index < train_end else "validation" if index < validation_end else "test"
        for index, capture_id in enumerate(ordered)
    }


def build_index(
    root: Path,
    verify_hash: bool,
    max_captures: int | None = None,
    reuse_index: dict[str, Any] | None = None,
) -> dict[str, Any]:
    manifest = load_json(root / "dataset" / "manifest.json")
    captures = manifest["captures"][:max_captures] if max_captures else manifest["captures"]
    splits = assign_splits([capture["capture_id"] for capture in captures])
    reusable = {
        capture["capture_id"]: capture
        for capture in (reuse_index or {}).get("captures", [])
    }
    indexed: list[dict[str, Any]] = []
    for number, capture in enumerate(captures, start=1):
        capture_id = capture["capture_id"]
        video_artifact = artifact_by_role(capture, "video")
        session_artifact = artifact_by_role(capture, "ble_session")
        video_path = validate_artifact(root, video_artifact, verify_hash)
        session_path = validate_artifact(root, session_artifact, verify_hash)
        session = load_json(session_path)
        teacher = teacher_timeline(root, capture, session["moves"], verify_hash)
        if teacher is None:
            previous = reusable.get(capture_id)
            same_stream = previous is not None and [move["move"] for move in previous.get("moves", [])] == [
                move["move"] for move in session["moves"]
            ]
            same_video = previous is not None and previous.get("video_sha256") == video_artifact["sha256"]
            if same_stream and same_video:
                alignment = previous["alignment"]
            else:
                alignment = estimate_video_offset(video_path, session["moves"])
            video_times = [
                move["t_ms"] / 1000 + alignment["offset_seconds"]
                for move in session["moves"]
            ]
        else:
            video_times, alignment = teacher
        moves = [
            {
                "index": index,
                "move": move["move"],
                "session_time_seconds": round(move["t_ms"] / 1000, 6),
                "video_time_seconds": round(video_times[index], 6),
                "quat": move.get("quat"),
            }
            for index, move in enumerate(session["moves"])
        ]
        indexed.append({
            "capture_id": capture_id,
            "split": splits[capture_id],
            "video": str(video_path.resolve()),
            "video_sha256": video_artifact["sha256"],
            "license": video_artifact["public_license"],
            "attribution": video_artifact["attribution"],
            "alignment": alignment,
            "moves": moves,
        })
        print(
            f"[{number:02d}/{len(captures):02d}] {capture_id[:8]} "
            f"{len(moves)} moves · offset {alignment['offset_seconds']:.3f}s · "
            f"confidence {alignment['confidence']:.0%}"
        )
    return {
        "schema_version": 1,
        "source": REPO_ID,
        "license": REQUIRED_LICENSE,
        "capture_count": len(indexed),
        "move_count": sum(len(capture["moves"]) for capture in indexed),
        "splits": {
            name: sum(capture["split"] == name for capture in indexed)
            for name in ("train", "validation", "test")
        },
        "captures": indexed,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path("data/raw/cubed-data-v1"))
    parser.add_argument("--output", type=Path, default=Path("data/private/cubed-index.json"))
    parser.add_argument("--download", choices=("none", "metadata", "full"), default="none")
    parser.add_argument("--skip-hash", action="store_true")
    parser.add_argument("--max-captures", type=int)
    parser.add_argument("--reuse-alignments-from", type=Path)
    args = parser.parse_args()

    if args.download != "none":
        download(args.root, full=args.download == "full")
    reuse_index = (
        load_json(args.reuse_alignments_from)
        if args.reuse_alignments_from and args.reuse_alignments_from.is_file()
        else None
    )
    payload = build_index(
        args.root,
        verify_hash=not args.skip_hash,
        max_captures=args.max_captures,
        reuse_index=reuse_index,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: payload[key] for key in ("capture_count", "move_count", "splits")}, indent=2))


if __name__ == "__main__":
    main()