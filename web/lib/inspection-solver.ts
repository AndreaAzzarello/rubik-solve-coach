import { CubeState, invertMoves, movesToString, parseAlgorithm } from './cube';
import { faceletsToSolverString } from './inspection-state';
import type { CubeColor, Face } from './cube';

let solverInitialization: Promise<typeof import('cubejs')> | null = null;

function loadSolver() {
  if (!solverInitialization) {
    solverInitialization = import('cubejs').then(async (module) => {
      // Yield once before the pruning tables are built so the interface can
      // paint the "ricostruzione" state instead of appearing frozen.
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      module.default.initSolver();
      return module;
    });
  }
  return solverInitialization;
}

export type InspectionScramble = {
  solution: string;
  scramble: string;
  verified: boolean;
};

export async function createScrambleFromInspection(
  facelets: Record<Face, CubeColor[]>,
): Promise<InspectionScramble> {
  const solverString = faceletsToSolverString(facelets);
  const solvedString = 'U'.repeat(9) + 'R'.repeat(9) + 'F'.repeat(9) + 'D'.repeat(9) + 'L'.repeat(9) + 'B'.repeat(9);
  if (solverString === solvedString) return { solution: '', scramble: '', verified: true };
  const Cube = (await loadSolver()).default;
  const solution = Cube.fromString(solverString).solve();
  const scramble = solution.trim()
    ? movesToString(invertMoves(parseAlgorithm(solution)))
    : '';
  const replayed = CubeState.solved().applyMoves(parseAlgorithm(scramble));
  return {
    solution,
    scramble,
    verified: replayed.faceletString() === solverString,
  };
}
