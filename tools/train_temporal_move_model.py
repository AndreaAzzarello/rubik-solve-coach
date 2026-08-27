"""Train and evaluate a browser-compatible temporal move classifier.

The model sees the signed Y/Cr/Cb change across a 4x4 grid before and after a
BLE-labeled turn.  Captures, not individual frames, define the data split.  A
model is copied into the website only when held-out exact and face accuracy
clear explicit minimums; otherwise the report is saved without changing the
production decoder.
"""

from __future__ import annotations

import argparse
import json
import random
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from tools.import_cubed_dataset import crop_focus


CLASSES = ["U", "U'", "R", "R'", "F", "F'", "D", "D'", "L", "L'", "B", "B'"]
CLASS_INDEX = {token: index for index, token in enumerate(CLASSES)}
GRID_ROWS = 4
GRID_COLUMNS = 4
FEATURE_COUNT = GRID_ROWS * GRID_COLUMNS * 11


@dataclass
class DatasetSplit:
    features: np.ndarray
    labels: np.ndarray
    captures: np.ndarray


def appearance_grid(frame: np.ndarray) -> np.ndarray:
    focused = crop_focus(frame)
    ycrcb = cv2.cvtColor(focused, cv2.COLOR_BGR2YCrCb).astype(np.float32)
    height, width = ycrcb.shape[:2]
    blocks: list[np.ndarray] = []
    for row in range(GRID_ROWS):
        for column in range(GRID_COLUMNS):
            y0, y1 = round(row * height / GRID_ROWS), round((row + 1) * height / GRID_ROWS)
            x0, x1 = round(column * width / GRID_COLUMNS), round((column + 1) * width / GRID_COLUMNS)
            blocks.append(np.mean(ycrcb[y0:y1, x0:x1], axis=(0, 1)))
    return np.asarray(blocks, dtype=np.float32)


def temporal_descriptor(before: np.ndarray, after: np.ndarray) -> np.ndarray:
    before_grid = appearance_grid(before)
    after_grid = appearance_grid(after)
    delta = after_grid - before_grid
    features = np.concatenate(
        [
            np.clip(delta[:, 0] / 64.0, -2, 2),
            np.clip(delta[:, 1] / 64.0, -2, 2),
            np.clip(delta[:, 2] / 64.0, -2, 2),
            np.clip(np.abs(delta[:, 0]) / 64.0, 0, 2),
            np.clip((np.abs(delta[:, 1]) + np.abs(delta[:, 2])) / 128.0, 0, 2),
            before_grid[:, 0] / 255.0,
            before_grid[:, 1] / 255.0,
            before_grid[:, 2] / 255.0,
            after_grid[:, 0] / 255.0,
            after_grid[:, 1] / 255.0,
            after_grid[:, 2] / 255.0,
        ]
    )
    return features.astype(np.float32)


def target_frame_indices(capture: dict[str, Any], fps: float, frame_count: int) -> list[tuple[int, int, int, str]]:
    moves = capture["moves"]
    targets: list[tuple[int, int, int, str]] = []
    duration = frame_count / fps
    for index, move in enumerate(moves):
        token = move["move"]
        if token not in CLASS_INDEX:
            continue
        time = float(move["video_time_seconds"])
        previous_time = float(moves[index - 1]["video_time_seconds"]) if index else time - 0.45
        next_time = float(moves[index + 1]["video_time_seconds"]) if index + 1 < len(moves) else time + 0.45
        half_window = min(0.15, max(0.055, min(time - previous_time, next_time - time) * 0.34))
        before_time = time - half_window
        after_time = time + half_window
        if before_time < 0 or after_time >= duration:
            continue
        targets.append(
            (
                max(0, min(frame_count - 1, round(before_time * fps))),
                max(0, min(frame_count - 1, round(after_time * fps))),
                index,
                token,
            )
        )
    return targets


def extract_capture(capture_info: dict[str, Any]) -> tuple[np.ndarray, np.ndarray]:
    video_path = Path(capture_info["video"])
    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise RuntimeError(f"Cannot open {video_path}")
    fps = float(capture.get(cv2.CAP_PROP_FPS))
    frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    targets = target_frame_indices(capture_info, fps, frame_count)
    requested = {frame for target in targets for frame in target[:2]}
    frames: dict[int, np.ndarray] = {}
    frame_index = 0
    while requested:
        ok, frame = capture.read()
        if not ok:
            break
        if frame_index in requested:
            frames[frame_index] = frame
            requested.remove(frame_index)
        frame_index += 1
    capture.release()

    features: list[np.ndarray] = []
    labels: list[int] = []
    for before_index, after_index, _, token in targets:
        before = frames.get(before_index)
        after = frames.get(after_index)
        if before is None or after is None:
            continue
        features.append(temporal_descriptor(before, after))
        labels.append(CLASS_INDEX[token])
    if not features:
        return np.empty((0, FEATURE_COUNT), dtype=np.float32), np.empty((0,), dtype=np.int64)
    return np.stack(features), np.asarray(labels, dtype=np.int64)


def extract_dataset(index: dict[str, Any], cache_path: Path, rebuild: bool) -> dict[str, DatasetSplit]:
    if cache_path.is_file() and not rebuild:
        cached = np.load(cache_path)
        return {
            split: DatasetSplit(cached[f"{split}_x"], cached[f"{split}_y"], cached[f"{split}_capture"])
            for split in ("train", "validation", "test")
        }

    buckets: dict[str, dict[str, list[np.ndarray] | list[str]]] = {
        split: {"x": [], "y": [], "capture": []}
        for split in ("train", "validation", "test")
    }
    for number, capture in enumerate(index["captures"], start=1):
        features, labels = extract_capture(capture)
        split = capture["split"]
        buckets[split]["x"].append(features)  # type: ignore[union-attr]
        buckets[split]["y"].append(labels)  # type: ignore[union-attr]
        buckets[split]["capture"].extend([capture["capture_id"]] * len(labels))  # type: ignore[union-attr]
        print(f"[{number:02d}/{len(index['captures']):02d}] {capture['capture_id'][:8]} · {len(labels)} examples · {split}")

    result: dict[str, DatasetSplit] = {}
    payload: dict[str, np.ndarray] = {}
    for split, values in buckets.items():
        x_parts = values["x"]
        y_parts = values["y"]
        x = np.concatenate(x_parts) if x_parts else np.empty((0, FEATURE_COUNT), dtype=np.float32)  # type: ignore[arg-type]
        y = np.concatenate(y_parts) if y_parts else np.empty((0,), dtype=np.int64)  # type: ignore[arg-type]
        captures = np.asarray(values["capture"], dtype="U32")
        result[split] = DatasetSplit(x, y, captures)
        payload[f"{split}_x"] = x
        payload[f"{split}_y"] = y
        payload[f"{split}_capture"] = captures
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(cache_path, **payload)
    return result


def metric_report(labels: np.ndarray, probabilities: np.ndarray) -> dict[str, Any]:
    predictions = probabilities.argmax(axis=1)
    exact = float(np.mean(predictions == labels)) if len(labels) else 0.0
    predicted_faces = np.asarray([CLASSES[index][0] for index in predictions])
    actual_faces = np.asarray([CLASSES[index][0] for index in labels])
    face = float(np.mean(predicted_faces == actual_faces)) if len(labels) else 0.0
    confidence = probabilities.max(axis=1) if len(labels) else np.asarray([])
    selective: dict[str, dict[str, float | int]] = {}
    for threshold in (0.35, 0.5, 0.65, 0.8):
        accepted = confidence >= threshold
        selective[str(threshold)] = {
            "coverage": round(float(np.mean(accepted)), 4) if len(labels) else 0.0,
            "accuracy": round(float(np.mean(predictions[accepted] == labels[accepted])), 4) if np.any(accepted) else 0.0,
            "accepted": int(np.sum(accepted)),
        }
    per_class = {
        token: {
            "count": int(np.sum(labels == index)),
            "accuracy": round(float(np.mean(predictions[labels == index] == index)), 4) if np.any(labels == index) else 0.0,
        }
        for index, token in enumerate(CLASSES)
    }
    return {
        "examples": len(labels),
        "exact_accuracy": round(exact, 4),
        "face_accuracy": round(face, 4),
        "selective": selective,
        "per_class": per_class,
    }


def train_model(
    splits: dict[str, DatasetSplit],
    epochs: int,
    seed: int,
) -> tuple[Any, np.ndarray, np.ndarray, dict[str, Any]]:
    import torch
    from torch import nn
    from torch.utils.data import DataLoader, TensorDataset

    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    mean = splits["train"].features.mean(axis=0)
    std = splits["train"].features.std(axis=0)
    std[std < 1e-5] = 1.0
    normalized = {
        name: ((split.features - mean) / std).astype(np.float32)
        for name, split in splits.items()
    }
    model = nn.Sequential(
        nn.Linear(FEATURE_COUNT, 128),
        nn.ReLU(),
        nn.Dropout(0.16),
        nn.Linear(128, len(CLASSES)),
    ).to(device)

    counts = np.bincount(splits["train"].labels, minlength=len(CLASSES)).astype(np.float32)
    class_weights = counts.sum() / np.maximum(1, counts) / len(CLASSES)
    loss_function = nn.CrossEntropyLoss(weight=torch.tensor(class_weights, device=device))
    optimizer = torch.optim.AdamW(model.parameters(), lr=0.0018, weight_decay=0.015)
    train_data = TensorDataset(
        torch.from_numpy(normalized["train"]),
        torch.from_numpy(splits["train"].labels),
    )
    loader = DataLoader(train_data, batch_size=128, shuffle=True)
    best_state: dict[str, Any] | None = None
    best_validation = -1.0
    stale = 0

    def probabilities(name: str) -> np.ndarray:
        model.eval()
        with torch.no_grad():
            logits = model(torch.from_numpy(normalized[name]).to(device))
            return torch.softmax(logits, dim=1).cpu().numpy()

    for epoch in range(1, epochs + 1):
        model.train()
        for features, labels in loader:
            features = features.to(device)
            labels = labels.to(device)
            noise = torch.randn_like(features) * 0.025
            optimizer.zero_grad(set_to_none=True)
            loss = loss_function(model(features + noise), labels)
            loss.backward()
            optimizer.step()
        validation_probabilities = probabilities("validation")
        validation_accuracy = float(np.mean(validation_probabilities.argmax(axis=1) == splits["validation"].labels))
        if validation_accuracy > best_validation + 1e-5:
            best_validation = validation_accuracy
            best_state = {key: value.detach().cpu().clone() for key, value in model.state_dict().items()}
            stale = 0
        else:
            stale += 1
        if epoch == 1 or epoch % 10 == 0:
            print(f"epoch {epoch:03d} · validation exact {validation_accuracy:.2%}")
        if stale >= 24:
            break
    if best_state is not None:
        model.load_state_dict(best_state)
    reports = {
        name: metric_report(splits[name].labels, probabilities(name))
        for name in ("train", "validation", "test")
    }
    reports["runtime"] = {
        "device": str(device),
        "cuda": bool(torch.cuda.is_available()),
        "epochs_completed": epoch,
        "best_validation_exact": round(best_validation, 4),
    }
    return model.cpu().eval(), mean, std, reports


def export_model(model: Any, mean: np.ndarray, std: np.ndarray, metrics: dict[str, Any]) -> dict[str, Any]:
    first = model[0]
    second = model[3]
    return {
        "schema_version": 1,
        "name": "temporal-move-v2",
        "classes": CLASSES,
        "feature_layout": "4x4 signed/absolute YCrCb delta + before/after YCrCb appearance",
        "feature_count": FEATURE_COUNT,
        "normalization": {
            "mean": np.round(mean, 7).tolist(),
            "std": np.round(std, 7).tolist(),
        },
        "layers": [
            {
                "activation": "relu",
                "weights": np.round(first.weight.detach().numpy(), 7).tolist(),
                "bias": np.round(first.bias.detach().numpy(), 7).tolist(),
            },
            {
                "activation": "softmax",
                "weights": np.round(second.weight.detach().numpy(), 7).tolist(),
                "bias": np.round(second.bias.detach().numpy(), 7).tolist(),
            },
        ],
        "metrics": metrics,
        "license": "Model trained from cubed-data-v1 (CC-BY-SA-4.0); attribution: Manas / cubed-core",
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--index", type=Path, default=Path("data/private/cubed-index.json"))
    parser.add_argument("--cache", type=Path, default=Path("data/private/cubed-features-v2.npz"))
    parser.add_argument("--output", type=Path, default=Path("models/generated/temporal-move-v2.json"))
    parser.add_argument("--report", type=Path, default=Path("data/private/temporal-move-report-v2.json"))
    parser.add_argument("--publish", type=Path, default=Path("web/public/models/temporal-move-v2.json"))
    parser.add_argument("--epochs", type=int, default=180)
    parser.add_argument("--seed", type=int, default=20260827)
    parser.add_argument("--rebuild-features", action="store_true")
    parser.add_argument("--minimum-exact", type=float, default=0.45)
    parser.add_argument("--minimum-face", type=float, default=0.65)
    args = parser.parse_args()

    index = json.loads(args.index.read_text(encoding="utf-8"))
    splits = extract_dataset(index, args.cache, args.rebuild_features)
    model, mean, std, reports = train_model(splits, args.epochs, args.seed)
    payload = export_model(model, mean, std, reports)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(reports, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    test = reports["test"]
    publishable = test["exact_accuracy"] >= args.minimum_exact and test["face_accuracy"] >= args.minimum_face
    if publishable:
        args.publish.parent.mkdir(parents=True, exist_ok=True)
        args.publish.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(json.dumps({"metrics": reports, "published": publishable}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
