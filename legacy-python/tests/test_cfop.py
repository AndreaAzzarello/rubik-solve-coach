import unittest

from cubesolve_core import (
    CfopPhase,
    CubeState,
    analyze_cfop_sequence,
    cfop_status,
    classify_cfop_phase,
    reconstructed_scramble,
)


class CfopTests(unittest.TestCase):
    def test_solved_cube_completes_every_milestone(self) -> None:
        cube = CubeState.solved()
        status = cfop_status(cube, "yellow")
        self.assertTrue(status.cross_solved)
        self.assertTrue(status.f2l_solved)
        self.assertTrue(status.oll_solved)
        self.assertTrue(status.cube_solved)
        self.assertEqual(classify_cfop_phase(cube, "yellow"), CfopPhase.COMPLETE)

    def test_single_last_layer_turn_is_pll_phase(self) -> None:
        cube = CubeState.solved().apply_algorithm("U")
        self.assertEqual(classify_cfop_phase(cube, "yellow"), CfopPhase.PLL)

    def test_sune_applied_to_solved_cube_creates_oll_phase(self) -> None:
        cube = CubeState.solved().apply_algorithm("R U R' U R U2 R'")
        self.assertEqual(classify_cfop_phase(cube, "yellow"), CfopPhase.OLL)

    def test_sexy_move_preserves_cross_but_breaks_f2l(self) -> None:
        cube = CubeState.solved().apply_algorithm("R U R' U'")
        self.assertEqual(classify_cfop_phase(cube, "yellow"), CfopPhase.F2L)

    def test_cross_color_follows_cube_rotation(self) -> None:
        cube = CubeState.solved().apply_algorithm("x2")
        status = cfop_status(cube, "white")
        self.assertEqual(status.cross_face_normal, (0, -1, 0))
        self.assertTrue(status.cross_solved)

    def test_unknown_cross_color_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            cfop_status(CubeState.solved(), "purple")

    def test_timeline_classifies_every_move_and_reaches_complete(self) -> None:
        solution = "R U R' U'"
        initial = CubeState.solved().apply_algorithm(reconstructed_scramble(solution))
        timeline = analyze_cfop_sequence(initial, solution, "yellow")

        self.assertEqual(len(timeline), 4)
        self.assertEqual([step.index for step in timeline], [1, 2, 3, 4])
        self.assertEqual(str(timeline[0].move), "R")
        self.assertEqual(timeline[-1].phase_after, CfopPhase.COMPLETE)
        self.assertTrue(timeline[-1].status_after.cube_solved)
        self.assertFalse(initial.is_solved())


if __name__ == "__main__":
    unittest.main()
