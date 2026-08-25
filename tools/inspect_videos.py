"""Inspect local solve videos without copying or modifying the source files."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np


def video_metadata(path: Path) -> dict[str, object]:
    capture = cv2.VideoCapture(str(path))
    if not capture.isOpened():
        raise RuntimeError(f"Cannot open video: {path}")

    frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = float(capture.get(cv2.CAP_PROP_FPS))
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    duration_seconds = frame_count / fps if fps > 0 else 0.0
    capture.release()

    return {
        "file_name": path.name,
        "file_size_bytes": path.stat().st_size,
        "frame_count": frame_count,
        "fps": round(fps, 3),
        "width": width,
        "height": height,
        "duration_seconds": round(duration_seconds, 3),
    }


def sample_frames(path: Path, count: int) -> list[tuple[float, np.ndarray]]:
    capture = cv2.VideoCapture(str(path))
    if not capture.isOpened():
        raise RuntimeError(f"Cannot open video: {path}")

    frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = float(capture.get(cv2.CAP_PROP_FPS))
    if frame_count <= 0 or fps <= 0:
        capture.release()
        raise RuntimeError(f"Invalid video metadata: {path}")

    indices = np.linspace(0, frame_count - 1, num=count, dtype=int)
    samples: list[tuple[float, np.ndarray]] = []
    for frame_index in indices:
        capture.set(cv2.CAP_PROP_POS_FRAMES, int(frame_index))
        ok, frame = capture.read()
        if not ok:
            continue
        samples.append((float(frame_index) / fps, frame))

    capture.release()
    return samples


def make_contact_sheet(
    samples: list[tuple[float, np.ndarray]], columns: int = 4, cell_width: int = 480
) -> np.ndarray:
    if not samples:
        raise ValueError("No frames available for contact sheet")

    first_frame = samples[0][1]
    aspect_ratio = first_frame.shape[0] / first_frame.shape[1]
    image_height = max(1, int(cell_width * aspect_ratio))
    label_height = 38
    cell_height = image_height + label_height
    rows = (len(samples) + columns - 1) // columns

    sheet = np.full(
        (rows * cell_height, columns * cell_width, 3), 245, dtype=np.uint8
    )
    for index, (timestamp, frame) in enumerate(samples):
        row, column = divmod(index, columns)
        resized = cv2.resize(frame, (cell_width, image_height))
        y = row * cell_height
        x = column * cell_width
        sheet[y : y + image_height, x : x + cell_width] = resized
        cv2.putText(
            sheet,
            f"{timestamp:.2f} s",
            (x + 12, y + image_height + 27),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.7,
            (30, 30, 30),
            2,
            cv2.LINE_AA,
        )

    return sheet


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("videos", nargs="+", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--samples", type=int, default=12)
    args = parser.parse_args()

    args.output.mkdir(parents=True, exist_ok=True)
    manifest: list[dict[str, object]] = []

    for video_path in args.videos:
        path = video_path.resolve(strict=True)
        metadata = video_metadata(path)
        samples = sample_frames(path, args.samples)
        sheet = make_contact_sheet(samples)
        sheet_path = args.output / f"{path.stem}-contact-sheet.jpg"
        if not cv2.imwrite(str(sheet_path), sheet):
            raise RuntimeError(f"Cannot write image: {sheet_path}")

        metadata["contact_sheet"] = sheet_path.name
        metadata["sample_timestamps_seconds"] = [
            round(timestamp, 3) for timestamp, _ in samples
        ]
        manifest.append(metadata)

    manifest_path = args.output / "manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    print(json.dumps(manifest, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()

