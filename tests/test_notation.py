import unittest

from cubesolve_core import Move, invert_algorithm, parse_algorithm


class NotationTests(unittest.TestCase):
    def test_parser_normalizes_wide_moves_and_suffixes(self) -> None:
        self.assertEqual(str(Move.parse("r")), "Rw")
        self.assertEqual(str(Move.parse("U2'")), "U2")
        self.assertEqual(str(Move.parse("F’")), "F'")

    def test_supported_move_families(self) -> None:
        algorithm = "U D L R F B M E S x y z Uw Dw Lw Rw Fw Bw"
        self.assertEqual(len(parse_algorithm(algorithm)), 18)

    def test_invalid_move_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            Move.parse("R3")

    def test_algorithm_is_inverted_in_reverse_order(self) -> None:
        self.assertEqual(invert_algorithm("R U R' U'"), "U R U' R'")


if __name__ == "__main__":
    unittest.main()

