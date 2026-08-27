"""Train a small, user-specific visual move classifier from local videos.

The recordings follow the fixed sequences documented in docs/test-videos.md.
Raw frames never leave the machine.  The exported JSON contains only normalized
motion descriptors and can therefore be bundled with the browser prototype.

This is intentionally a calibration model, not a claim of a camera-independent
Rubik's Cube recognizer.  The report includes a slow-to-fast validation score so
the UI can cap its confidence when a class is not yet reliable.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np


BASE = "U U' U' U U2 U2 R R' R' R R2 R2 F F' F' F F2 F2 D D' D' D D2 D2 L L' L' L L2 L2 B B' B' B B2 B2".split()
WIDE = "Uw Uw' Uw' Uw Uw2 Uw2 Rw Rw' Rw' Rw Rw2 Rw2 Fw Fw' Fw' Fw Fw2 Fw2 Dw Dw' Dw' Dw Dw2 Dw2 Lw Lw' Lw' Lw Lw2 Lw2 Bw Bw' Bw' Bw Bw2 Bw2".split()
SLICE = "M M' M' M M2 M2 E E' E' E E2 E2 S S' S' S S2 S2".split()
ROTATIONS = "x x' x' x x2 x2 y y' y' y y2 y2 z z' z' z z2 z2".split()
TRIGGERS = "R U R' U' U R U' R' R' U' R U U' R' U R L' U' L U U' L' U L R' F R F' F R' F' R F R U R' U' F' F U R U' R' F'".split()


@dataclass(frozen=True)
class Recording:
    group: str
    slow: str
    fast: str
    tokens: list[str]


RECORDINGS = [
    Recording("base", "IMG_6010.MOV", "IMG_6021.MOV", BASE),
    Recording("wide", "IMG_6011.MOV", "IMG_6022.MOV", WIDE),
    Recording("slice", "IMG_6013.MOV", "IMG_6023.MOV", SLICE),
    Recording("rotations", "IMG_6015.MOV", "IMG_6025.MOV", ROTATIONS),
    Recording("triggers", "IMG_6017.MOV", "IMG_6032.MOV", TRIGGERS),
]


def crop_focus(frame: np.ndarray) -> np.ndarray:
    height, width = frame.shape[:2]
    # Matches the portrait crop used by the browser decoder, then keeps the
    # central interaction region at a compact and deterministic resolution.
    source_width = round(width * 0.88)
    source_height = round(height * 0.68)
    source_x = round((width - source_width) / 2)
    source_y = max(0, min(height - source_height, round(height * 0.08)))
    crop = frame[source_y : source_y + source_height, source_x : source_x + source_width]
    return cv2.resize(crop, (96, 128), interpolation=cv2.INTER_AREA)


def grid_means(channel: np.ndarray, rows: int = 4, columns: int = 4) -> list[float]:
    height, width = channel.shape[:2]
    values: list[float] = []
    for row in range(rows):
        for column in range(columns):
            y0, y1 = round(row * height / rows), round((row + 1) * height / rows)
            x0, x1 = round(column * width / columns), round((column + 1) * width / columns)
            values.append(float(np.mean(channel[y0:y1, x0:x1])))
    return values


def descriptor(before: np.ndarray, after: np.ndarray) -> list[float]:
    before_gray = cv2.cvtColor(before, cv2.COLOR_BGR2GRAY)
    after_gray = cv2.cvtColor(after, cv2.COLOR_BGR2GRAY)
    flow = cv2.calcOpticalFlowFarneback(before_gray, after_gray, None, 0.5, 3, 15, 3, 5, 1.1, 0)
    delta = cv2.absdiff(before, after).astype(np.float32).mean(axis=2) / 255.0
    magnitude = np.linalg.norm(flow, axis=2)
    scale = max(0.35, float(np.percentile(magnitude, 90)))
    flow_x = np.clip(flow[..., 0] / scale, -2, 2)
    flow_y = np.clip(flow[..., 1] / scale, -2, 2)
    magnitude = np.clip(magnitude / scale, 0, 2)
    features = grid_means(delta) + grid_means(flow_x) + grid_means(flow_y) + grid_means(magnitude)
    array = np.asarray(features, dtype=np.float32)
    norm = float(np.linalg.norm(array))
    if norm > 1e-6:
        array /= norm
    return [round(float(value), 6) for value in array]


def read_samples(path: Path, samples_per_second: float = 18.0) -> tuple[float, list[float], list[np.ndarray], list[float]]:
    capture = cv2.VideoCapture(str(path))
    if not capture.isOpened():
        raise RuntimeError(f"Cannot open {path}")
    fps = float(capture.get(cv2.CAP_PROP_FPS))
    frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    duration = frame_count / fps
    every = max(1, round(fps / samples_per_second))
    times: list[float] = []
    frames: list[np.ndarray] = []
    index = 0
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        if index % every == 0:
            times.append(index / fps)
            frames.append(crop_focus(frame))
        index += 1
    capture.release()
    signal = [0.0]
    for previous, current in zip(frames, frames[1:]):
        gray_previous = cv2.cvtColor(previous, cv2.COLOR_BGR2GRAY)
        gray_current = cv2.cvtColor(current, cv2.COLOR_BGR2GRAY)
        delta = cv2.absdiff(gray_previous, gray_current).astype(np.float32)
        # The center carries most cube/sticker evidence while the outer band is
        # still useful for finger preparation and whole-cube rotations.
        center = delta[28:105, 14:82]
        signal.append(float(np.mean(center) * 0.82 + np.mean(delta) * 0.18))
    return duration, times, frames, signal


def locate_uniform_moves(times: list[float], signal: list[float], count: int, fast: bool) -> list[int]:
    """Align known ordered labels while allowing recording lead-in/out.

    We search several possible active ranges and select one peak per monotonic
    bin.  Slow recordings use wide bins; fast recordings use narrower local
    maxima and are validation-only.
    """
    values = np.asarray(signal, dtype=np.float32)
    smoothed = np.convolve(values, np.ones(3, dtype=np.float32) / 3, mode="same")
    duration = times[-1]
    best_score = -1.0
    best_indices: list[int] = []
    starts = np.linspace(0.0, min(duration * 0.12, 5.0), 13)
    endings = np.linspace(max(duration * 0.84, duration - 10.0), duration, 17)
    for start in starts:
        for end in endings:
            if end <= start:
                continue
            step = (end - start) / count
            if step < (0.16 if fast else 0.7):
                continue
            selected: list[int] = []
            score = 0.0
            for move_index in range(count):
                center = start + (move_index + 0.5) * step
                radius = step * (0.48 if fast else 0.56)
                candidates = [index for index, time in enumerate(times) if center - radius <= time <= center + radius]
                if not candidates:
                    selected = []
                    break
                peak = max(candidates, key=lambda index: smoothed[index])
                if selected and peak <= selected[-1]:
                    selected = []
                    break
                selected.append(peak)
                score += float(smoothed[peak])
                score -= abs(times[peak] - center) / max(step, 0.1) * float(np.median(smoothed)) * 0.08
            if selected and score > best_score:
                best_score = score
                best_indices = selected
    return best_indices


def extract(path: Path, tokens: list[str], fast: bool) -> list[dict[str, object]]:
    duration, times, frames, signal = read_samples(path)
    peaks = locate_uniform_moves(times, signal, len(tokens), fast)
    if len(peaks) != len(tokens):
        raise RuntimeError(f"Alignment failed for {path.name}: {len(peaks)}/{len(tokens)}")
    examples: list[dict[str, object]] = []
    # Slow clips contain a deliberate pause around each turn: compare the two
    # stable cube states, not two blurred frames inside the same motion.  Fast
    # clips need a much tighter window to avoid absorbing adjacent moves.
    offset = 2 if fast else 12
    for token, peak in zip(tokens, peaks):
        before = frames[max(0, peak - offset)]
        after = frames[min(len(frames) - 1, peak + offset)]
        examples.append({
            "move": token,
            "time": round(times[peak], 3),
            "features": descriptor(before, after),
        })
    print(f"{path.name}: {len(examples)} labels, {times[peaks[0]]:.2f}s–{times[peaks[-1]]:.2f}s / {duration:.2f}s")
    return examples


def distance(left: list[float], right: list[float]) -> float:
    return float(np.linalg.norm(np.asarray(left, dtype=np.float32) - np.asarray(right, dtype=np.float32)))


def predict(examples: list[dict[str, object]], features: list[float], neighbors: int = 5) -> tuple[str, float, list[str]]:
    ranked = sorted(examples, key=lambda item: distance(item["features"], features))[:neighbors]
    votes: dict[str, float] = {}
    for rank, item in enumerate(ranked):
        weight = 1.0 / max(0.05, distance(item["features"], features)) / (1 + rank * 0.08)
        votes[str(item["move"])] = votes.get(str(item["move"]), 0.0) + weight
    ordered = sorted(votes, key=votes.get, reverse=True)
    total = sum(votes.values())
    confidence = votes[ordered[0]] / max(total, 1e-6)
    return ordered[0], confidence, ordered[:3]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--slow-dir", type=Path, required=True)
    parser.add_argument("--fast-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    training: list[dict[str, object]] = []
    validation: list[dict[str, object]] = []
    for recording in RECORDINGS:
        slow_examples = extract(args.slow_dir / recording.slow, recording.tokens, fast=False)
        fast_examples = extract(args.fast_dir / recording.fast, recording.tokens, fast=True)
        training.extend({**example, "group": recording.group, "speed": "slow"} for example in slow_examples)
        validation.extend({**example, "group": recording.group, "speed": "fast"} for example in fast_examples)

    correct = 0
    base_correct = 0
    suffix_correct = 0
    reports: list[dict[str, object]] = []
    for example in validation:
        prediction, confidence, alternatives = predict(training, example["features"])
        actual = str(example["move"])
        correct += prediction == actual
        base_correct += prediction.rstrip("'2") == actual.rstrip("'2")
        suffix_correct += prediction[len(prediction.rstrip("'2")) :] == actual[len(actual.rstrip("'2")) :]
        reports.append({
            "actual": actual,
            "prediction": prediction,
            "confidence": round(confidence, 4),
            "alternatives": alternatives,
            "group": example["group"],
        })

    count = max(1, len(validation))
    metrics = {
        "exact_accuracy": round(correct / count, 4),
        "face_accuracy": round(base_correct / count, 4),
        "suffix_accuracy": round(suffix_correct / count, 4),
        "validation_examples": len(validation),
    }
    payload = {
        "version": 1,
        "feature_layout": "4x4 delta + 4x4 flow-x + 4x4 flow-y + 4x4 flow-magnitude, L2 normalized",
        "training_examples": training,
        "metrics": metrics,
        "validation": reports,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(json.dumps(metrics, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
