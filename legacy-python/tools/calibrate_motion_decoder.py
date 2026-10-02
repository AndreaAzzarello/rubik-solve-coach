"""Measure the browser motion-decoder profile on local calibration videos.

Raw videos are never copied. The optional JSON output contains only timing
statistics and detected peaks, so it can safely live under data/private/.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np


@dataclass
class Sample:
    time: float
    difference: float
    coverage: float
    center_bias: float


def median(values: list[float]) -> float:
    return float(np.median(values)) if values else 0.0


def crop_cube_focus(frame: np.ndarray) -> np.ndarray:
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


def signature(frame: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    blue, green, red = cv2.split(frame.astype(np.float32))
    luma = red * 0.299 + green * 0.587 + blue * 0.114
    chroma_blue = np.clip(128 + (blue - luma) * 0.565, 0, 255)
    chroma_red = np.clip(128 + (red - luma) * 0.713, 0, 255)
    return luma, chroma_blue, chroma_red


def measure(previous: tuple[np.ndarray, ...], current: tuple[np.ndarray, ...]) -> tuple[float, float, float]:
    previous_luma, previous_blue, previous_red = previous
    current_luma, current_blue, current_red = current
    exposure_shift = float(np.mean(current_luma - previous_luma))
    luma_delta = np.abs((current_luma - previous_luma) - exposure_shift)
    chroma_delta = (np.abs(current_blue - previous_blue) + np.abs(current_red - previous_red)) / 2
    pixel_difference = np.minimum(64, luma_delta * 0.58 + chroma_delta * 0.42)

    height, width = pixel_difference.shape
    x = (np.arange(width) + 0.5) / width
    y = (np.arange(height) + 0.5) / height
    center = (x[None, :] >= 0.14) & (x[None, :] <= 0.86) & (y[:, None] >= 0.12) & (y[:, None] <= 0.88)
    weights = np.where(center, 1.35, 0.48)
    center_mean = float(np.average(pixel_difference[center], weights=weights[center]))
    outer_mean = float(np.average(pixel_difference[~center], weights=weights[~center]))
    coverage = float(np.sum(weights[pixel_difference >= 9.5]) / np.sum(weights))
    center_bias = center_mean / max(0.6, outer_mean)
    score = center_mean * 0.74 + outer_mean * 0.12 + coverage * 12
    return score, coverage, center_bias


def detect(samples: list[Sample], sample_interval: float) -> tuple[float, list[dict[str, float | str]]]:
    if len(samples) < 3:
        return 0.0, []
    raw = [sample.difference for sample in samples]
    smoothed = [
        raw[max(0, index - 1)] * 0.22 + raw[index] * 0.56 + raw[min(len(raw) - 1, index + 1)] * 0.22
        for index in range(len(raw))
    ]
    ordered = sorted(smoothed[1:])
    quiet = ordered[: max(3, int(np.ceil(len(ordered) * 0.58)))]
    baseline = median(quiet)
    deviation = median([abs(value - baseline) for value in quiet])
    noise_threshold = baseline + max(1.35, deviation * 4.2)
    activity_ceiling = ordered[int((len(ordered) - 1) * 0.72)]
    threshold = max(2.6, min(noise_threshold, activity_ceiling))
    radius = max(1, round(0.1 / sample_interval))
    minimum_gap = max(0.14, sample_interval * 1.65)
    candidates: list[int] = []

    for index in range(1, len(samples) - 1):
        start = max(0, index - radius)
        end = min(len(samples), index + radius + 1)
        if smoothed[index] >= threshold and smoothed[index] >= max(smoothed[start:end]):
            candidates.append(index)

    candidates.sort(key=lambda index: smoothed[index], reverse=True)
    selected: list[int] = []
    for index in candidates:
        if all(abs(samples[index].time - samples[other].time) >= minimum_gap for other in selected):
            selected.append(index)
    selected.sort()

    events = []
    for index in selected[:240]:
        sample = samples[index]
        global_motion = sample.coverage >= 0.52
        events.append(
            {
                "time": round(sample.time, 3),
                "score": round(smoothed[index], 3),
                "coverage": round(sample.coverage, 3),
                "center_bias": round(sample.center_bias, 3),
                "kind": "global-motion" if global_motion else "face-turn",
            }
        )
    return threshold, events


def analyze(path: Path) -> dict[str, object]:
    capture = cv2.VideoCapture(str(path))
    if not capture.isOpened():
        raise RuntimeError(f"Cannot open {path}")
    fps = float(capture.get(cv2.CAP_PROP_FPS))
    frames = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    duration = frames / fps
    interval = max(0.06, duration / 1050)
    every_frames = max(1, round(interval * fps))
    samples: list[Sample] = []
    previous: tuple[np.ndarray, ...] | None = None
    frame_index = 0

    while True:
        ok, frame = capture.read()
        if not ok:
            break
        if frame_index % every_frames == 0:
            current = signature(crop_cube_focus(frame))
            if previous is None:
                score, coverage, center_bias = 0.0, 0.0, 1.0
            else:
                score, coverage, center_bias = measure(previous, current)
            samples.append(Sample(frame_index / fps, score, coverage, center_bias))
            previous = current
        frame_index += 1
    capture.release()

    actual_interval = every_frames / fps
    threshold, events = detect(samples, actual_interval)
    differences = np.array([sample.difference for sample in samples[1:]], dtype=np.float32)
    return {
        "file": path.name,
        "duration_seconds": round(duration, 3),
        "fps": round(fps, 3),
        "sample_interval": round(actual_interval, 4),
        "threshold": round(threshold, 3),
        "difference_percentiles": {
            str(percentile): round(float(np.percentile(differences, percentile)), 3)
            for percentile in (5, 10, 20, 35, 50, 75, 90, 95, 99)
        },
        "event_count": len(events),
        "global_motion_count": sum(event["kind"] == "global-motion" for event in events),
        "events": events,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("videos", nargs="+", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    results = [analyze(path) for path in args.videos]
    payload = json.dumps(results, ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(payload + "\n", encoding="utf-8")
        summary = [
            {
                "file": result["file"],
                "event_count": result["event_count"],
                "global_motion_count": result["global_motion_count"],
                "threshold": result["threshold"],
            }
            for result in results
        ]
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    else:
        print(payload)


if __name__ == "__main__":
    main()
