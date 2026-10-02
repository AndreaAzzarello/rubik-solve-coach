"""State-based CFOP milestone detection."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from collections.abc import Iterable

from .cube import CubeState, Vector
from .notation import Move, parse_algorithm


class CfopPhase(StrEnum):
    CROSS = "cross"
    F2L = "f2l"
    OLL = "oll"
    PLL = "pll"
    COMPLETE = "complete"


@dataclass(frozen=True, slots=True)
class CfopStatus:
    cross_color: str
    cross_face_normal: Vector
    cross_solved: bool
    f2l_solved: bool
    oll_solved: bool
    cube_solved: bool


@dataclass(frozen=True, slots=True)
class CfopStep:
    index: int
    move: Move
    phase_before: CfopPhase
    phase_after: CfopPhase
    status_after: CfopStatus


def _axis_and_sign(normal: Vector) -> tuple[int, int]:
    for axis, value in enumerate(normal):
        if value:
            return axis, value
    raise ValueError("A face normal must contain one non-zero coordinate")


def _position_is_solved(
    cube: CubeState, position: Vector, centers: dict[Vector, str]
) -> bool:
    return all(color == centers[normal] for normal, color in cube.stickers_at(position))


def _cross_face(cube: CubeState, cross_color: str) -> Vector:
    matches = [
        normal for normal, color in cube.center_colors().items() if color == cross_color
    ]
    if len(matches) != 1:
        raise ValueError(f"Cross color is not a cube center: {cross_color!r}")
    return matches[0]


def cfop_status(cube: CubeState, cross_color: str) -> CfopStatus:
    centers = cube.center_colors()
    cross_normal = _cross_face(cube, cross_color)
    axis, cross_side = _axis_and_sign(cross_normal)
    last_side = -cross_side

    cross_edges = [
        position
        for position in cube.cubie_positions
        if position[axis] == cross_side
        and sum(coordinate != 0 for coordinate in position) == 2
    ]
    cross_solved = len(cross_edges) == 4 and all(
        _position_is_solved(cube, position, centers) for position in cross_edges
    )

    f2l_positions = [
        position
        for position in cube.cubie_positions
        if position[axis] != last_side
    ]
    f2l_solved = all(
        _position_is_solved(cube, position, centers) for position in f2l_positions
    )

    last_normal = tuple(-coordinate for coordinate in cross_normal)
    last_color = centers[last_normal]
    oll_solved = all(
        color == last_color
        for (position, normal), color in cube.stickers.items()
        if normal == last_normal and position[axis] == last_side
    )

    return CfopStatus(
        cross_color=cross_color,
        cross_face_normal=cross_normal,
        cross_solved=cross_solved,
        f2l_solved=f2l_solved,
        oll_solved=oll_solved,
        cube_solved=cube.is_solved(),
    )


def classify_cfop_phase(cube: CubeState, cross_color: str) -> CfopPhase:
    status = cfop_status(cube, cross_color)
    if status.cube_solved:
        return CfopPhase.COMPLETE
    if status.f2l_solved and status.oll_solved:
        return CfopPhase.PLL
    if status.f2l_solved:
        return CfopPhase.OLL
    if status.cross_solved:
        return CfopPhase.F2L
    return CfopPhase.CROSS


def analyze_cfop_sequence(
    initial_state: CubeState,
    algorithm: str | Iterable[Move],
    cross_color: str,
) -> list[CfopStep]:
    """Classify the state before and after every move without mutating input."""

    cube = initial_state.copy()
    timeline: list[CfopStep] = []
    for index, move in enumerate(parse_algorithm(algorithm), start=1):
        phase_before = classify_cfop_phase(cube, cross_color)
        cube.apply_move(move)
        timeline.append(
            CfopStep(
                index=index,
                move=move,
                phase_before=phase_before,
                phase_after=classify_cfop_phase(cube, cross_color),
                status_after=cfop_status(cube, cross_color),
            )
        )
    return timeline
