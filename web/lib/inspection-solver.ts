import { CubeState, invertMoves, movesToString, parseAlgorithm } from './cube.ts';
import { faceletsToSolverString } from './inspection-state.ts';
import type { CubeColor, Face } from './cube.ts';

let solverInitialization: Promise<typeof import('cubejs')> | null = null;

const SEARCH_SETUPS = [
  '',
  'U', "U'", 'U2',
  'R', "R'", 'R2',
  'F', "F'", 'F2',
  'D', "D'", 'D2',
  'L', "L'", 'L2',
  'B', "B'", 'B2',
];

function loadSolver() {
  if (!solverInitialization) {
    solverInitialization = import('cubejs').then(async (module) => {
      // Yield once before the pruning tables are built so the interface can
      // paint the "ricostruzione" state instead of appearing frozen.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      module.default.initSolver();
      return module;
    });
  }
  return solverInitialization;
}

export type InspectionScramble = {
  solution: string;
  scramble: string;
  moveCount: number;
  candidatesTested: number;
  verified: boolean;
};

function compactMoves(moves: ReturnType<typeof parseAlgorithm>) {
  const compacted: ReturnType<typeof parseAlgorithm> = [];
  moves.forEach((move) => {
    const previous = compacted.at(-1);
    if (!previous || previous.base !== move.base) {
      compacted.push(move);
      return;
    }
    compacted.pop();
    const previousTurns = previous.turns === -1 ? 3 : previous.turns;
    const currentTurns = move.turns === -1 ? 3 : move.turns;
    const combined = (previousTurns + currentTurns) % 4;
    if (combined === 1) compacted.push({ base: move.base, turns: 1, token: move.base });
    if (combined === 2) compacted.push({ base: move.base, turns: 2, token: `${move.base}2` });
    if (combined === 3) compacted.push({ base: move.base, turns: -1, token: `${move.base}'` });
  });
  return compacted;
}

export async function createScrambleFromInspection(
  facelets: Record<Face, CubeColor[]>,
): Promise<InspectionScramble> {
  const solverString = faceletsToSolverString(facelets);
  const solvedString = 'U'.repeat(9) + 'R'.repeat(9) + 'F'.repeat(9) + 'D'.repeat(9) + 'L'.repeat(9) + 'B'.repeat(9);
  if (solverString === solvedString) return {
    solution: '', scramble: '', moveCount: 0, candidatesTested: 1, verified: true,
  };
  const Cube = (await loadSolver()).default;
  const candidates = new Map<string, ReturnType<typeof parseAlgorithm>>();

  for (let index = 0; index < SEARCH_SETUPS.length; index += 1) {
    const setup = SEARCH_SETUPS[index];
    const cube = Cube.fromString(solverString);
    if (setup) cube.move(setup);
    const tail = cube.solve();
    const moves = compactMoves(parseAlgorithm([setup, tail].filter(Boolean).join(' ')));
    const solution = movesToString(moves);
    if (CubeState.fromFacelets(facelets).applyMoves(moves).isSolved()) {
      candidates.set(solution, moves);
    }
    if (index % 3 === 2) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  const ranked = [...candidates.entries()].sort((left, right) => (
    left[1].length - right[1].length || left[0].localeCompare(right[0])
  ));
  if (!ranked.length) throw new Error('Nessuna soluzione verificabile trovata per lo stato osservato.');
  const [solution, solutionMoves] = ranked[0];
  const scramble = movesToString(invertMoves(solutionMoves));
  const replayed = CubeState.solved().applyMoves(parseAlgorithm(scramble));
  return {
    solution,
    scramble,
    moveCount: solutionMoves.length,
    candidatesTested: candidates.size,
    verified: replayed.faceletString() === solverString,
  };
}
