import unittest

from cubesolve_core import CubeState, reconstructed_scramble


class CubeStateTests(unittest.TestCase):
    def test_every_move_followed_by_its_inverse_is_identity(self) -> None:
        for move in "U D L R F B M E S x y z Uw Dw Lw Rw Fw Bw".split():
            with self.subTest(move=move):
                cube = CubeState.solved().apply_algorithm(f"{move} {move}'")
                self.assertTrue(cube.is_exactly_solved())

    def test_four_quarter_turns_are_identity(self) -> None:
        for move in "U D L R F B M E S x y z Uw Dw Lw Rw Fw Bw".split():
            with self.subTest(move=move):
                cube = CubeState.solved().apply_algorithm(" ".join([move] * 4))
                self.assertTrue(cube.is_exactly_solved())

    def test_cube_rotations_preserve_solved_state(self) -> None:
        cube = CubeState.solved().apply_algorithm("x y z x2 y' z2")
        self.assertTrue(cube.is_solved())
        self.assertFalse(cube.is_exactly_solved())

    def test_reconstructed_scramble_recreates_solution_start(self) -> None:
        solution = "R U R' U' F2 D L2 B' U2"
        scramble = reconstructed_scramble(solution)
        cube = CubeState.solved().apply_algorithm(scramble)
        self.assertFalse(cube.is_solved())
        cube.apply_algorithm(solution)
        self.assertTrue(cube.is_solved())

    def test_facelet_string_contains_54_stickers(self) -> None:
        signature = CubeState.solved().facelet_string()
        self.assertEqual(len(signature), 54)
        self.assertEqual(signature, "U" * 9 + "R" * 9 + "F" * 9 + "D" * 9 + "L" * 9 + "B" * 9)

    def test_front_clockwise_turn_uses_standard_color_cycle(self) -> None:
        cube = CubeState.solved().apply_algorithm("F")
        self.assertEqual(cube.facelets("U")[6:9], ("orange",) * 3)
        self.assertEqual(cube.facelets("R")[0::3], ("white",) * 3)
        self.assertEqual(cube.facelets("D")[0:3], ("red",) * 3)
        self.assertEqual(cube.facelets("L")[2::3], ("yellow",) * 3)

    def test_wide_and_rotation_moves_match_slice_definitions(self) -> None:
        equivalent_algorithms = [
            ("Rw", "R M'"),
            ("Lw", "L M"),
            ("Uw", "U E'"),
            ("Dw", "D E"),
            ("Fw", "F S"),
            ("Bw", "B S'"),
            ("x", "R M' L'"),
            ("y", "U E' D'"),
            ("z", "F S B'"),
        ]
        for move, expansion in equivalent_algorithms:
            with self.subTest(move=move):
                self.assertEqual(
                    CubeState.solved().apply_algorithm(move),
                    CubeState.solved().apply_algorithm(expansion),
                )


if __name__ == "__main__":
    unittest.main()
