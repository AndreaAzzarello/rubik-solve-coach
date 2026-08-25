"""Analyze an already transcribed solution and emit a JSON timeline."""

from __future__ import annotations

import argparse
import json

from cubesolve_core import (
    CubeState,
    analyze_cfop_sequence,
    parse_algorithm,
    reconstructed_scramble,
)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--solution", required=True)
    parser.add_argument("--scramble")
    parser.add_argument("--cross-color", default="yellow")
    args = parser.parse_args()

    reconstructed = reconstructed_scramble(args.solution)
    scramble = args.scramble if args.scramble is not None else reconstructed
    initial = CubeState.solved().apply_algorithm(scramble)
    timeline = analyze_cfop_sequence(initial, args.solution, args.cross_color)
    final_state_solved = (
        timeline[-1].status_after.cube_solved if timeline else initial.is_solved()
    )

    result = {
        "cross_color": args.cross_color,
        "solution": " ".join(str(move) for move in parse_algorithm(args.solution)),
        "move_count": len(timeline),
        "scramble_used": scramble,
        "reconstructed_scramble": reconstructed,
        "final_state_solved": final_state_solved,
        "timeline": [
            {
                "index": step.index,
                "move": str(step.move),
                "phase_before": step.phase_before.value,
                "phase_after": step.phase_after.value,
                "cross_solved": step.status_after.cross_solved,
                "f2l_solved": step.status_after.f2l_solved,
                "oll_solved": step.status_after.oll_solved,
                "cube_solved": step.status_after.cube_solved,
            }
            for step in timeline
        ],
    }
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
