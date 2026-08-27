import tempfile
import unittest
from pathlib import Path

import numpy as np

from tools.import_cubed_dataset import alignment_score, assign_splits, sha256_file, teacher_timeline


class CubedDatasetTests(unittest.TestCase):
    def test_capture_splits_are_deterministic_and_disjoint(self):
        capture_ids = [f"capture-{index}" for index in range(35)]
        first = assign_splits(capture_ids)
        second = assign_splits(list(reversed(capture_ids)))
        self.assertEqual(first, second)
        self.assertEqual(set(first), set(capture_ids))
        self.assertEqual({"train", "validation", "test"}, set(first.values()))

    def test_alignment_score_prefers_motion_at_labeled_times(self):
        frame_times = np.arange(0, 8, 0.05, dtype=np.float32)
        signal = np.ones_like(frame_times)
        moves = np.asarray([1.0, 2.0, 3.0, 4.0], dtype=np.float32)
        for target in moves + 1.25:
            signal[np.argmin(np.abs(frame_times - target))] = 20
        correct, coverage = alignment_score(1.25, moves, frame_times, signal)
        wrong, _ = alignment_score(0.0, moves, frame_times, signal)
        self.assertEqual(coverage, 1.0)
        self.assertGreater(correct, wrong)

    def test_sha256_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sample.bin"
            path.write_bytes(b"cube")
            self.assertEqual(
                sha256_file(path),
                "4f3c4172a4fe308cebc840da665171f534849b1fca101eaf635d68fb453393db",
            )

    def test_teacher_timeline_uses_exact_video_frames(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            truth_path = root / "capture" / "truth.json"
            truth_path.parent.mkdir(parents=True)
            truth_path.write_text(
                '{"video":{"fps":100,"frame_count":500},"moves":['
                '{"frame":120,"move":"R"},{"frame":175,"move":"U2"}]}',
                encoding="utf-8",
            )
            capture = {
                "capture_id": "sample",
                "artifacts": [{
                    "role": "teacher_truth",
                    "path": "capture/truth.json",
                    "bytes": truth_path.stat().st_size,
                    "sha256": sha256_file(truth_path),
                    "public_license": "CC-BY-SA-4.0",
                }],
            }
            session_moves = [
                {"t_ms": 31000, "move": "R"},
                {"t_ms": 31550, "move": "U2"},
            ]
            result = teacher_timeline(root, capture, session_moves, verify_hash=True)
            self.assertIsNotNone(result)
            video_times, diagnostics = result
            self.assertEqual(video_times, [1.2, 1.75])
            self.assertEqual(diagnostics["source"], "teacher-frame-index")
            self.assertEqual(diagnostics["confidence"], 1.0)


if __name__ == "__main__":
    unittest.main()
