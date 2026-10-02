"""Parsing and inversion for standard 3x3 move notation."""

from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Iterable


_MOVE_PATTERN = re.compile(
    r"^(?P<base>[URFDLB]w|[URFDLBMESxyzurfdlb])(?P<suffix>2'?|'2|')?$"
)
_LOWERCASE_WIDE_MOVES = {
    "u": "Uw",
    "r": "Rw",
    "f": "Fw",
    "d": "Dw",
    "l": "Lw",
    "b": "Bw",
}


@dataclass(frozen=True, slots=True)
class Move:
    """A normalized move and its number of clockwise quarter turns."""

    base: str
    turns: int = 1

    def __post_init__(self) -> None:
        if self.base not in {
            "U",
            "R",
            "F",
            "D",
            "L",
            "B",
            "M",
            "E",
            "S",
            "x",
            "y",
            "z",
            "Uw",
            "Rw",
            "Fw",
            "Dw",
            "Lw",
            "Bw",
        }:
            raise ValueError(f"Unsupported move: {self.base}")
        if self.turns not in {-1, 1, 2}:
            raise ValueError("turns must be -1, 1, or 2")

    @classmethod
    def parse(cls, token: str) -> "Move":
        normalized = token.strip().replace("’", "'")
        match = _MOVE_PATTERN.fullmatch(normalized)
        if match is None:
            raise ValueError(f"Invalid move token: {token!r}")

        base = _LOWERCASE_WIDE_MOVES.get(match.group("base"), match.group("base"))
        suffix = match.group("suffix") or ""
        if "2" in suffix:
            turns = 2
        elif suffix == "'":
            turns = -1
        else:
            turns = 1
        return cls(base=base, turns=turns)

    def inverse(self) -> "Move":
        return self if self.turns == 2 else Move(self.base, -self.turns)

    def __str__(self) -> str:
        if self.turns == -1:
            return f"{self.base}'"
        if self.turns == 2:
            return f"{self.base}2"
        return self.base


def parse_algorithm(algorithm: str | Iterable[Move]) -> list[Move]:
    if not isinstance(algorithm, str):
        return list(algorithm)
    if not algorithm.strip():
        return []
    return [Move.parse(token) for token in algorithm.split()]


def invert_algorithm(algorithm: str | Iterable[Move]) -> str:
    moves = parse_algorithm(algorithm)
    return " ".join(str(move.inverse()) for move in reversed(moves))

