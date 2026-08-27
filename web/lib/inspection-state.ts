import type { CubeColor, Face } from './cube';

export type FaceGridObservation = {
  time: number;
  centerColor: CubeColor;
  colors: Array<CubeColor | null>;
  confidence: number;
  visibleCells: number;
};

export type PartialFacelets = Record<Face, Array<CubeColor | null>>;

export type InspectionReconstruction = {
  status: 'insufficient' | 'partial' | 'complete' | 'invalid';
  observedFaces: Face[];
  observedFacelets: number;
  inferredFacelets: number;
  resolvedCorners: number;
  resolvedEdges: number;
  candidateCount: number;
  truncated: boolean;
  confidence: number;
  facelets: PartialFacelets;
  completeFacelets: Record<Face, CubeColor[]> | null;
  message: string;
};

type PieceDefinition = {
  name: string;
  faces: Face[];
  indices: number[];
  colors: CubeColor[];
};

type AssignmentCandidate = {
  facelets: PartialFacelets;
  permutation: number[];
  parity: 0 | 1;
};

const FACES: Face[] = ['U', 'R', 'F', 'D', 'L', 'B'];

export const CANONICAL_FACE_COLOR: Record<Face, CubeColor> = {
  U: 'white',
  R: 'red',
  F: 'green',
  D: 'yellow',
  L: 'orange',
  B: 'blue',
};

export const CANONICAL_COLOR_FACE: Record<CubeColor, Face> = {
  white: 'U',
  red: 'R',
  green: 'F',
  yellow: 'D',
  orange: 'L',
  blue: 'B',
};

const CORNERS: PieceDefinition[] = [
  { name: 'URF', faces: ['U', 'R', 'F'], indices: [8, 0, 2], colors: ['white', 'red', 'green'] },
  { name: 'UFL', faces: ['U', 'F', 'L'], indices: [6, 0, 2], colors: ['white', 'green', 'orange'] },
  { name: 'ULB', faces: ['U', 'L', 'B'], indices: [0, 0, 2], colors: ['white', 'orange', 'blue'] },
  { name: 'UBR', faces: ['U', 'B', 'R'], indices: [2, 0, 2], colors: ['white', 'blue', 'red'] },
  { name: 'DFR', faces: ['D', 'F', 'R'], indices: [2, 8, 6], colors: ['yellow', 'green', 'red'] },
  { name: 'DLF', faces: ['D', 'L', 'F'], indices: [0, 8, 6], colors: ['yellow', 'orange', 'green'] },
  { name: 'DBL', faces: ['D', 'B', 'L'], indices: [6, 8, 6], colors: ['yellow', 'blue', 'orange'] },
  { name: 'DRB', faces: ['D', 'R', 'B'], indices: [8, 8, 6], colors: ['yellow', 'red', 'blue'] },
];

const EDGES: PieceDefinition[] = [
  { name: 'UR', faces: ['U', 'R'], indices: [5, 1], colors: ['white', 'red'] },
  { name: 'UF', faces: ['U', 'F'], indices: [7, 1], colors: ['white', 'green'] },
  { name: 'UL', faces: ['U', 'L'], indices: [3, 1], colors: ['white', 'orange'] },
  { name: 'UB', faces: ['U', 'B'], indices: [1, 1], colors: ['white', 'blue'] },
  { name: 'DR', faces: ['D', 'R'], indices: [5, 7], colors: ['yellow', 'red'] },
  { name: 'DF', faces: ['D', 'F'], indices: [1, 7], colors: ['yellow', 'green'] },
  { name: 'DL', faces: ['D', 'L'], indices: [3, 7], colors: ['yellow', 'orange'] },
  { name: 'DB', faces: ['D', 'B'], indices: [7, 7], colors: ['yellow', 'blue'] },
  { name: 'FR', faces: ['F', 'R'], indices: [5, 3], colors: ['green', 'red'] },
  { name: 'FL', faces: ['F', 'L'], indices: [3, 5], colors: ['green', 'orange'] },
  { name: 'BL', faces: ['B', 'L'], indices: [5, 3], colors: ['blue', 'orange'] },
  { name: 'BR', faces: ['B', 'R'], indices: [3, 5], colors: ['blue', 'red'] },
];

function emptyFacelets(): PartialFacelets {
  return {
    U: Array<CubeColor | null>(9).fill(null),
    R: Array<CubeColor | null>(9).fill(null),
    F: Array<CubeColor | null>(9).fill(null),
    D: Array<CubeColor | null>(9).fill(null),
    L: Array<CubeColor | null>(9).fill(null),
    B: Array<CubeColor | null>(9).fill(null),
  };
}

function cloneFacelets(facelets: PartialFacelets): PartialFacelets {
  return Object.fromEntries(FACES.map((face) => [face, [...facelets[face]]])) as PartialFacelets;
}

function withCanonicalCenters(facelets = emptyFacelets()) {
  FACES.forEach((face) => { facelets[face][4] = CANONICAL_FACE_COLOR[face]; });
  return facelets;
}

function rotateGrid(colors: Array<CubeColor | null>, turns: number) {
  let result = [...colors];
  for (let turn = 0; turn < turns; turn += 1) {
    const rotated = Array<CubeColor | null>(9).fill(null);
    for (let row = 0; row < 3; row += 1) {
      for (let column = 0; column < 3; column += 1) {
        rotated[column * 3 + (2 - row)] = result[row * 3 + column];
      }
    }
    result = rotated;
  }
  return result;
}

function fuseFaceObservations(observations: FaceGridObservation[]): FaceGridObservation {
  const ordered = [...observations].sort((left, right) => (
    right.confidence * right.visibleCells - left.confidence * left.visibleCells
  ));
  const base = ordered[0];
  const colors = [...base.colors];
  let confidenceTotal = base.confidence;
  let fusedFrames = 1;

  ordered.slice(1).forEach((observation) => {
    const alignments = [0, 1, 2, 3].map((turns) => {
      const rotated = rotateGrid(observation.colors, turns);
      let agreements = 0;
      let nonCenterAgreements = 0;
      let conflicts = 0;
      let additions = 0;
      rotated.forEach((color, index) => {
        if (!color) return;
        if (!colors[index]) additions += 1;
        else if (colors[index] === color) {
          agreements += 1;
          if (index !== 4) nonCenterAgreements += 1;
        } else conflicts += 1;
      });
      return {
        rotated,
        agreements,
        nonCenterAgreements,
        conflicts,
        additions,
        score: agreements * 5 + additions * 0.35 - conflicts * 9,
      };
    }).sort((left, right) => right.score - left.score);
    const best = alignments[0];
    const runnerUp = alignments[1];
    // The centre matches in every rotation. Require at least one additional
    // sticker and a unique alignment before merging another view of the face.
    if (
      best.conflicts > 0
      || best.nonCenterAgreements < 1
      || best.score - runnerUp.score < 1
    ) return;
    best.rotated.forEach((color, index) => {
      if (!colors[index] && color) colors[index] = color;
    });
    confidenceTotal += observation.confidence;
    fusedFrames += 1;
  });

  return {
    ...base,
    colors,
    visibleCells: colors.filter(Boolean).length,
    confidence: Math.min(97, Math.round(confidenceTotal / fusedFrames + Math.min(8, (fusedFrames - 1) * 2))),
  };
}

function permutationParity(permutation: number[]): 0 | 1 {
  let inversions = 0;
  for (let left = 0; left < permutation.length; left += 1) {
    for (let right = left + 1; right < permutation.length; right += 1) {
      if (permutation[left] > permutation[right]) inversions += 1;
    }
  }
  return inversions % 2 as 0 | 1;
}

function orientedAssignments(position: PieceDefinition, piece: PieceDefinition) {
  return piece.colors.map((_, orientation) => {
    const stickers = position.faces.map((face, slot) => ({
      face,
      index: position.indices[slot],
      color: piece.colors[(slot - orientation + piece.colors.length) % piece.colors.length],
    }));
    return { orientation, stickers };
  });
}

function enumeratePieceAssignments(
  positions: PieceDefinition[],
  pieces: PieceDefinition[],
  partial: PartialFacelets,
  limit: number,
) {
  const options = positions.map((position) => pieces.flatMap((piece, pieceIndex) => (
    orientedAssignments(position, piece)
      .filter((assignment) => assignment.stickers.every(({ face, index, color }) => (
        partial[face][index] === null || partial[face][index] === color
      )))
      .map((assignment) => ({ ...assignment, pieceIndex }))
  )));
  if (options.some((positionOptions) => !positionOptions.length)) {
    return { candidates: [] as AssignmentCandidate[], truncated: false, localOptions: options };
  }

  const order = positions.map((_, index) => index).sort((left, right) => options[left].length - options[right].length);
  const candidates: AssignmentCandidate[] = [];
  const usedPieces = new Set<number>();
  const permutation = Array<number>(positions.length).fill(-1);
  const selected: Array<(typeof options)[number][number] | null> = Array(positions.length).fill(null);
  let truncated = false;

  function visit(depth: number, orientationSum: number) {
    if (candidates.length >= limit) {
      truncated = true;
      return;
    }
    if (depth === order.length) {
      if (orientationSum % positions[0].faces.length !== 0) return;
      const facelets = cloneFacelets(partial);
      selected.forEach((assignment) => assignment?.stickers.forEach(({ face, index, color }) => {
        facelets[face][index] = color;
      }));
      candidates.push({ facelets, permutation: [...permutation], parity: permutationParity(permutation) });
      return;
    }
    const positionIndex = order[depth];
    for (const option of options[positionIndex]) {
      if (usedPieces.has(option.pieceIndex)) continue;
      usedPieces.add(option.pieceIndex);
      permutation[positionIndex] = option.pieceIndex;
      selected[positionIndex] = option;
      visit(depth + 1, orientationSum + option.orientation);
      selected[positionIndex] = null;
      permutation[positionIndex] = -1;
      usedPieces.delete(option.pieceIndex);
      if (truncated) return;
    }
  }

  visit(0, 0);
  return { candidates, truncated, localOptions: options };
}

function mergeFacelets(left: PartialFacelets, right: PartialFacelets) {
  const result = cloneFacelets(left);
  FACES.forEach((face) => right[face].forEach((color, index) => {
    if (color !== null) result[face][index] = color;
  }));
  return result;
}

function completePartialFacelets(partial: PartialFacelets, limit = 96) {
  const corners = enumeratePieceAssignments(CORNERS, CORNERS, partial, 768);
  const edges = enumeratePieceAssignments(EDGES, EDGES, partial, 768);
  const complete: PartialFacelets[] = [];
  let truncated = corners.truncated || edges.truncated;
  for (const corner of corners.candidates) {
    for (const edge of edges.candidates) {
      if (corner.parity !== edge.parity) continue;
      complete.push(mergeFacelets(corner.facelets, edge.facelets));
      if (complete.length >= limit) {
        truncated = true;
        break;
      }
    }
    if (complete.length >= limit) break;
  }
  return {
    complete,
    truncated,
    cornerOptions: corners.localOptions,
    edgeOptions: edges.localOptions,
  };
}

function colorCountValid(facelets: PartialFacelets) {
  const counts = new Map<CubeColor, number>();
  FACES.forEach((face) => facelets[face].forEach((color) => {
    if (color) counts.set(color, (counts.get(color) ?? 0) + 1);
  }));
  return [...counts.values()].every((count) => count <= 9);
}

function faceletKey(facelets: PartialFacelets) {
  return FACES.flatMap((face) => facelets[face].map((color) => color?.[0] ?? '_')).join('');
}

function consensusFacelets(candidates: PartialFacelets[], observed: PartialFacelets) {
  const consensus = cloneFacelets(observed);
  if (!candidates.length) return consensus;
  FACES.forEach((face) => {
    for (let index = 0; index < 9; index += 1) {
      if (consensus[face][index]) continue;
      const first = candidates[0][face][index];
      if (first && candidates.every((candidate) => candidate[face][index] === first)) {
        consensus[face][index] = first;
      }
    }
  });
  return consensus;
}

function asComplete(facelets: PartialFacelets): Record<Face, CubeColor[]> | null {
  if (FACES.some((face) => facelets[face].some((color) => color === null))) return null;
  return Object.fromEntries(FACES.map((face) => [face, facelets[face] as CubeColor[]])) as Record<Face, CubeColor[]>;
}

export function reconstructInspectionState(observations: FaceGridObservation[]): InspectionReconstruction {
  const observationsByFace = new Map<Face, FaceGridObservation[]>();
  observations.forEach((observation) => {
    if (observation.colors.length !== 9 || observation.visibleCells < 5) return;
    const face = CANONICAL_COLOR_FACE[observation.centerColor];
    observationsByFace.set(face, [...(observationsByFace.get(face) ?? []), observation]);
  });
  const bestByFace = new Map<Face, FaceGridObservation>();
  observationsByFace.forEach((faceObservations, face) => {
    bestByFace.set(face, fuseFaceObservations(faceObservations));
  });

  const observedFaces = [...bestByFace.keys()];
  if (!observedFaces.length) {
    const facelets = withCanonicalCenters();
    return {
      status: 'insufficient', observedFaces: [], observedFacelets: 0, inferredFacelets: 0,
      resolvedCorners: 0, resolvedEdges: 0, candidateCount: 0, truncated: false,
      confidence: 0, facelets, completeFacelets: null,
      message: 'Nessuna griglia 3×3 abbastanza stabile è stata letta durante l’ispezione.',
    };
  }

  const choices = observedFaces.map((face) => ({
    face,
    rotations: [0, 1, 2, 3].map((turns) => rotateGrid(bestByFace.get(face)!.colors, turns)),
  }));
  const validStates = new Map<string, PartialFacelets>();
  let sawTruncation = false;
  let bestPartial = withCanonicalCenters();
  let bestObserved = 0;
  const maximumRotationCombinations = 4096;
  let rotationCombinations = 0;

  function tryRotations(depth: number, partial: PartialFacelets) {
    if (rotationCombinations >= maximumRotationCombinations || validStates.size >= 96) {
      sawTruncation = true;
      return;
    }
    if (depth === choices.length) {
      rotationCombinations += 1;
      if (!colorCountValid(partial)) return;
      const observedCount = FACES.reduce((total, face) => total + partial[face].filter(Boolean).length, 0) - 6;
      if (observedCount > bestObserved) {
        bestObserved = observedCount;
        bestPartial = cloneFacelets(partial);
      }
      // With very little visual evidence the exact search space is enormous.
      // Keep the observations, but do not manufacture a unique completion.
      if (observedCount < 18) return;
      const completion = completePartialFacelets(partial);
      sawTruncation ||= completion.truncated;
      completion.complete.forEach((candidate) => validStates.set(faceletKey(candidate), candidate));
      return;
    }
    const choice = choices[depth];
    for (const grid of choice.rotations) {
      const next = cloneFacelets(partial);
      let conflict = false;
      grid.forEach((color, index) => {
        if (!color) return;
        const existing = next[choice.face][index];
        if (existing && existing !== color) conflict = true;
        next[choice.face][index] = color;
      });
      if (!conflict) tryRotations(depth + 1, next);
      if (sawTruncation && validStates.size >= 96) break;
    }
  }

  tryRotations(0, withCanonicalCenters());
  const candidates = [...validStates.values()];
  const consensus = consensusFacelets(candidates, bestPartial);
  const completeFacelets = candidates.length === 1 && !sawTruncation ? asComplete(candidates[0]) : null;
  const inferredFacelets = FACES.reduce((total, face) => total + consensus[face].filter(Boolean).length, 0) - 6 - bestObserved;
  const cubieResolution = (definitions: PieceDefinition[]) => definitions.filter((position) => {
    const signatures = new Set(candidates.map((candidate) => position.faces.map((face, slot) => (
      candidate[face][position.indices[slot]]
    )).join('-')));
    return signatures.size === 1 && candidates.length > 0;
  }).length;
  const resolvedCorners = cubieResolution(CORNERS);
  const resolvedEdges = cubieResolution(EDGES);
  const baseConfidence = Math.round(Math.min(96, bestObserved / 48 * 72 + observedFaces.length / 6 * 18 + (completeFacelets ? 6 : 0)));

  if (bestObserved >= 18 && !candidates.length && !sawTruncation) {
    return {
      status: 'invalid', observedFaces, observedFacelets: bestObserved, inferredFacelets: 0,
      resolvedCorners: 0, resolvedEdges: 0, candidateCount: 0, truncated: false,
      confidence: Math.min(55, baseConfidence), facelets: bestPartial, completeFacelets: null,
      message: 'Le caselle osservate non formano uno stato fisicamente possibile: serve una nuova lettura dei fotogrammi sfocati o coperti.',
    };
  }
  if (completeFacelets) {
    return {
      status: 'complete', observedFaces, observedFacelets: bestObserved, inferredFacelets,
      resolvedCorners, resolvedEdges, candidateCount: 1, truncated: false,
      confidence: baseConfidence, facelets: candidates[0], completeFacelets,
      message: 'Stato completo e fisicamente valido nella convenzione bianco sopra, verde frontale.',
    };
  }
  return {
    status: bestObserved >= 8 ? 'partial' : 'insufficient', observedFaces,
    observedFacelets: bestObserved, inferredFacelets: sawTruncation ? 0 : Math.max(0, inferredFacelets),
    resolvedCorners, resolvedEdges, candidateCount: candidates.length, truncated: sawTruncation,
    confidence: baseConfidence, facelets: sawTruncation ? bestPartial : consensus, completeFacelets: null,
    message: sawTruncation
      ? 'La lettura è compatibile con molti stati: servono altre facce o caselle più nitide.'
      : 'Le caselle viste sono conservate; quelle mancanti vengono dedotte solo quando i vincoli dei pezzi le rendono uniche.',
  };
}

export function faceletsToSolverString(facelets: Record<Face, CubeColor[]>) {
  return FACES.flatMap((face) => facelets[face].map((color) => CANONICAL_COLOR_FACE[color])).join('');
}
