import unittest

import numpy as np

from tools.train_temporal_move_model import (
    FEATURE_COUNT,
    appearance_grid,
    temporal_descriptor,
)


class TemporalMoveModelTests(unittest.TestCase):
    def test_appearance_grid_has_one_ycrcb_triplet_per_cell(self):
        frame = np.zeros((240, 180, 3), dtype=np.uint8)
        self.assertEqual(appearance_grid(frame).shape, (16, 3))

    def test_descriptor_has_zero_delta_for_identical_frames(self):
        frame = np.full((240, 180, 3), 120, dtype=np.uint8)
        descriptor = temporal_descriptor(frame, frame.copy())
        self.assertEqual(descriptor.shape, (FEATURE_COUNT,))
        np.testing.assert_allclose(descriptor[: 16 * 5], 0)
        self.assertTrue(np.all(np.isfinite(descriptor)))

    def test_descriptor_preserves_signed_and_absolute_change(self):
        before = np.zeros((240, 180, 3), dtype=np.uint8)
        after = before.copy()
        after[40:150, 45:135] = (20, 140, 250)
        descriptor = temporal_descriptor(before, after)
        self.assertGreater(float(np.max(np.abs(descriptor))), 0.1)
        self.assertTrue(np.all(np.isfinite(descriptor)))


if __name__ == "__main__":
    unittest.main()
