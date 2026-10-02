"""Scramble reconstruction utilities."""

from __future__ import annotations

from collections.abc import Iterable

from .notation import Move, invert_algorithm


def reconstructed_scramble(solution: str | Iterable[Move]) -> str:
    """Return the exact inverse of a complete solution sequence."""

    return invert_algorithm(solution)

