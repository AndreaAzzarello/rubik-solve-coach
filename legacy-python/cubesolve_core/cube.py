"""Sticker-level 3x3 cube model using integer 3D coordinates."""

from __future__ import annotations

from collections import Counter
from collections.abc import Iterable, Iterator, Mapping
from dataclasses import dataclass

from .notation import Move, parse_algorithm


Vector = tuple[int, int, int]
StickerKey = tuple[Vector, Vector]

FACE_NORMALS: dict[str, Vector] = {
    "U": (0, 1, 0),
    "R": (1, 0, 0),
    "F": (0, 0, 1),
    "D": (0, -1, 0),
    "L": (-1, 0, 0),
    "B": (0, 0, -1),
}
DEFAULT_COLORS: dict[str, str] = {
    "U": "white",
    "R": "red",
    "F": "green",
    "D": "yellow",
    "L": "orange",
    "B": "blue",
}


@dataclass(frozen=True, slots=True)
class _MoveSpec:
    axis: int
    layers: frozenset[int]
    positive_axis_turn: int


_MOVE_SPECS: dict[str, _MoveSpec] = {
    "U": _MoveSpec(1, frozenset({1}), -1),
    "D": _MoveSpec(1, frozenset({-1}), 1),
    "R": _MoveSpec(0, frozenset({1}), -1),
    "L": _MoveSpec(0, frozenset({-1}), 1),
    "F": _MoveSpec(2, frozenset({1}), -1),
    "B": _MoveSpec(2, frozenset({-1}), 1),
    "M": _MoveSpec(0, frozenset({0}), 1),
    "E": _MoveSpec(1, frozenset({0}), 1),
    "S": _MoveSpec(2, frozenset({0}), -1),
    "x": _MoveSpec(0, frozenset({-1, 0, 1}), -1),
    "y": _MoveSpec(1, frozenset({-1, 0, 1}), -1),
    "z": _MoveSpec(2, frozenset({-1, 0, 1}), -1),
    "Uw": _MoveSpec(1, frozenset({0, 1}), -1),
    "Dw": _MoveSpec(1, frozenset({-1, 0}), 1),
    "Rw": _MoveSpec(0, frozenset({0, 1}), -1),
    "Lw": _MoveSpec(0, frozenset({-1, 0}), 1),
    "Fw": _MoveSpec(2, frozenset({0, 1}), -1),
    "Bw": _MoveSpec(2, frozenset({-1, 0}), 1),
}


def _rotate_positive_quarter(vector: Vector, axis: int) -> Vector:
    x, y, z = vector
    if axis == 0:
        return (x, -z, y)
    if axis == 1:
        return (z, y, -x)
    if axis == 2:
        return (-y, x, z)
    raise ValueError(f"Invalid axis: {axis}")


def _rotate_vector(vector: Vector, axis: int, quarter_turns: int) -> Vector:
    result = vector
    for _ in range(quarter_turns % 4):
        result = _rotate_positive_quarter(result, axis)
    return result


def _facelet_position(face: str, row: int, column: int) -> Vector:
    if not 0 <= row <= 2 or not 0 <= column <= 2:
        raise ValueError("row and column must be between 0 and 2")
    if face == "U":
        return (column - 1, 1, row - 1)
    if face == "D":
        return (column - 1, -1, 1 - row)
    if face == "F":
        return (column - 1, 1 - row, 1)
    if face == "B":
        return (1 - column, 1 - row, -1)
    if face == "R":
        return (1, 1 - row, 1 - column)
    if face == "L":
        return (-1, 1 - row, column - 1)
    raise ValueError(f"Unknown face: {face}")


class CubeState:
    """A legal cube state produced by applying moves to a solved cube."""

    def __init__(self, stickers: Mapping[StickerKey, str]) -> None:
        self._stickers = dict(stickers)
        if len(self._stickers) != 54:
            raise ValueError("A 3x3 cube must contain exactly 54 stickers")
        self._validate_color_counts()

    @classmethod
    def solved(cls, colors: Mapping[str, str] | None = None) -> "CubeState":
        color_scheme = dict(DEFAULT_COLORS if colors is None else colors)
        if set(color_scheme) != set(FACE_NORMALS):
            raise ValueError("Color scheme must define U, R, F, D, L, and B")
        if len(set(color_scheme.values())) != 6:
            raise ValueError("Each center must use a distinct color")

        stickers: dict[StickerKey, str] = {}
        for face, normal in FACE_NORMALS.items():
            for row in range(3):
                for column in range(3):
                    position = _facelet_position(face, row, column)
                    stickers[(position, normal)] = color_scheme[face]
        return cls(stickers)

    def copy(self) -> "CubeState":
        return CubeState(self._stickers)

    def _validate_color_counts(self) -> None:
        counts = Counter(self._stickers.values())
        if len(counts) != 6 or set(counts.values()) != {9}:
            raise ValueError("A cube must contain exactly nine stickers of each color")

    @property
    def stickers(self) -> Mapping[StickerKey, str]:
        return self._stickers.copy()

    @property
    def cubie_positions(self) -> frozenset[Vector]:
        return frozenset(position for position, _ in self._stickers)

    def stickers_at(self, position: Vector) -> Iterator[tuple[Vector, str]]:
        for (sticker_position, normal), color in self._stickers.items():
            if sticker_position == position:
                yield normal, color

    def center_colors(self) -> dict[Vector, str]:
        return {
            normal: self._stickers[(normal, normal)]
            for normal in FACE_NORMALS.values()
        }

    def apply_move(self, move: str | Move) -> "CubeState":
        parsed = Move.parse(move) if isinstance(move, str) else move
        spec = _MOVE_SPECS[parsed.base]
        turns = spec.positive_axis_turn * parsed.turns
        rotated: dict[StickerKey, str] = {}

        for (position, normal), color in self._stickers.items():
            if position[spec.axis] in spec.layers:
                new_position = _rotate_vector(position, spec.axis, turns)
                new_normal = _rotate_vector(normal, spec.axis, turns)
                rotated[(new_position, new_normal)] = color
            else:
                rotated[(position, normal)] = color

        if len(rotated) != 54:
            raise RuntimeError("Move produced an invalid sticker mapping")
        self._stickers = rotated
        return self

    def apply_algorithm(self, algorithm: str | Iterable[Move]) -> "CubeState":
        for move in parse_algorithm(algorithm):
            self.apply_move(move)
        return self

    def after(self, algorithm: str | Iterable[Move]) -> "CubeState":
        return self.copy().apply_algorithm(algorithm)

    def is_solved(self) -> bool:
        centers = self.center_colors()
        return all(
            color == centers[normal]
            for (_, normal), color in self._stickers.items()
        )

    def is_exactly_solved(self, colors: Mapping[str, str] | None = None) -> bool:
        return self == CubeState.solved(colors)

    def facelets(self, face: str) -> tuple[str, ...]:
        normal = FACE_NORMALS[face]
        return tuple(
            self._stickers[(_facelet_position(face, row, column), normal)]
            for row in range(3)
            for column in range(3)
        )

    def facelet_string(self, color_symbols: Mapping[str, str] | None = None) -> str:
        if color_symbols is None:
            center_to_face = {
                self._stickers[(normal, normal)]: face
                for face, normal in FACE_NORMALS.items()
            }
        else:
            center_to_face = dict(color_symbols)
        return "".join(
            center_to_face[color]
            for face in "URFDLB"
            for color in self.facelets(face)
        )

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, CubeState):
            return NotImplemented
        return self._stickers == other._stickers

    def __repr__(self) -> str:
        return f"CubeState(facelets={self.facelet_string()!r})"

