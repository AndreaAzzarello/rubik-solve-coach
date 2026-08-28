import type { CubeColor, Face } from './cube';

type GridSide = 'top' | 'right' | 'bottom' | 'left';
type Vector = readonly [number, number, number];

export type FaceGridObservation = {
  time: number;
  centerColor: CubeColor;
  colors: Array<CubeColor | null>;
  confidence: number;
  visibleCells: number;
  imageX?: number;
  imageY?: number;
  rightX?: number;
  rightY?: number;
  downX?: number;
  downY?: number;
  orientationTurns?: number;
  orientationConfidence?: number;
};

export type CubeOrientation = {
  front: CubeColor;
  up: CubeColor;
  right: CubeColor;
  down: CubeColor;
  left: CubeColor;
  back: CubeColor;
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

type ObservationGeometry = {
  imageX: number;
  imageY: number;
  rightX: number;
  rightY: number;
  downX: number;
  downY: number;
};

const FACES: Face[] = ['U', 'R', 'F', 'D', 'L', 'B'];
const GRID_SIDES: GridSide[] = ['top', 'right', 'bottom', 'left'];
const ORIENTATION_LOCK_CONFIDENCE = 58;

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

const CUBE_COLOR_VECTOR: Record<CubeColor, Vector> = {
  white: [0, 1, 0],
  red: [1, 0, 0],
  green: [0, 0, 1],
  yellow: [0, -1, 0],
  orange: [-1, 0, 0],
  blue: [0, 0, -1],
};

const FACE_EDGE_NEIGHBORS: Record<Face, Record<GridSide, CubeColor>> = {
  U: { top: 'blue', right: 'red', bottom: 'green', left: 'orange' },
  R: { top: 'white', right: 'blue', bottom: 'yellow', left: 'green' },
  F: { top: 'white', right: 'red', bottom: 'yellow', left: 'orange' },
  D: { top: 'green', right: 'red', bottom: 'blue', left: 'orange' },
  L: { top: 'white', right: 'green', bottom: 'yellow', left: 'blue' },
  B: { top: 'white', right: 'orange', bottom: 'yellow', left: 'red' },
};

const CUBE_COLORS = Object.keys(CANONICAL_COLOR_FACE) as CubeColor[];

const sameVector = (left: Vector, right: Vector) => left.every((value, index) => value === right[index]);
const negateVector = ([x, y, z]: Vector): Vector => [-x, -y, -z];

function crossProduct([ax, ay, az]: Vector, [bx, by, bz]: Vector): Vector {
  return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
}

function colorFromVector(vector: Vector) {
  const entry = (Object.entries(CUBE_COLOR_VECTOR) as Array<[CubeColor, Vector]>)
    .find(([, candidate]) => sameVector(candidate, vector));
  if (!entry) throw new Error('Orientamento colore del cubo non valido');
  return entry[0];
}

function colorsAreAdjacent(left: CubeColor, right: CubeColor) {
  return left !== right && !sameVector(CUBE_COLOR_VECTOR[left], negateVector(CUBE_COLOR_VECTOR[right]));
}

export function cubeOrientationFromFrontAndUp(front: CubeColor, up: CubeColor): CubeOrientation | null {
  const frontVector = CUBE_COLOR_VECTOR[front];
  const upVector = CUBE_COLOR_VECTOR[up];
  if (!colorsAreAdjacent(front, up)) return null;
  const right = colorFromVector(crossProduct(upVector, frontVector));
  return {
    front,
    up,
    right,
    down: colorFromVector(negateVector(upVector)),
    left: colorFromVector(negateVector(CUBE_COLOR_VECTOR[right])),
    back: colorFromVector(negateVector(frontVector)),
  };
}

export const CUBE_ORIENTATIONS: CubeOrientation[] = CUBE_COLORS.flatMap((front) => (
  CUBE_COLORS
    .map((up) => cubeOrientationFromFrontAndUp(front, up))
    .filter((orientation): orientation is CubeOrientation => orientation !== null)
));

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

function rotateSide(side: GridSide, turns: number) {
  return GRID_SIDES[(GRID_SIDES.indexOf(side) + turns) % GRID_SIDES.length];
}

function observationGeometry(observation: FaceGridObservation): ObservationGeometry | null {
  const { imageX, imageY, rightX, rightY, downX, downY } = observation;
  const values = [imageX, imageY, rightX, rightY, downX, downY];
  if (values.some((value) => typeof value !== 'number' || !Number.isFinite(value))) return null;
  return { imageX, imageY, rightX, rightY, downX, downY };
}

function sideVector(geometry: ObservationGeometry, side: GridSide) {
  if (side === 'top') return { x: -geometry.downX, y: -geometry.downY };
  if (side === 'right') return { x: geometry.rightX, y: geometry.rightY };
  if (side === 'bottom') return { x: geometry.downX, y: geometry.downY };
  return { x: -geometry.rightX, y: -geometry.rightY };
}

function sideFromNeighbor(origin: FaceGridObservation, neighbor: FaceGridObservation) {
  const originGeometry = observationGeometry(origin);
  const neighborGeometry = observationGeometry(neighbor);
  if (!originGeometry || !neighborGeometry) return null;
  const vector = {
    x: neighborGeometry.imageX - originGeometry.imageX,
    y: neighborGeometry.imageY - originGeometry.imageY,
  };
  const distance = Math.hypot(vector.x, vector.y);
  if (distance < 2.5) return null;
  const ranked = GRID_SIDES.map((side) => {
    const axis = sideVector(originGeometry, side);
    const axisLength = Math.hypot(axis.x, axis.y);
    if (axisLength < 1.5) return { side, score: -1 };
    return {
      side,
      score: (vector.x * axis.x + vector.y * axis.y) / (distance * axisLength),
    };
  }).sort((left, right) => right.score - left.score);
  const best = ranked[0];
  if (!best || best.score < 0.42) return null;
  return best;
}

function rotationTurnsForNeighbor(face: Face, rawSide: GridSide, neighborColor: CubeColor) {
  for (let turns = 0; turns < 4; turns += 1) {
    if (FACE_EDGE_NEIGHBORS[face][rotateSide(rawSide, turns)] === neighborColor) return turns;
  }
  return null;
}

function frameKey(observation: FaceGridObservation) {
  return `${Math.round(observation.time * 1000)}`;
}

export function normalizeObservationOrientations(observations: FaceGridObservation[]): FaceGridObservation[] {
  const byFrame = new Map<string, FaceGridObservation[]>();
  observations.forEach((observation) => {
    const key = frameKey(observation);
    byFrame.set(key, [...(byFrame.get(key) ?? []), observation]);
  });

  return observations.map((observation) => {
    if (observation.colors.length !== 9 || !observationGeometry(observation)) return observation;
    const face = CANONICAL_COLOR_FACE[observation.centerColor];
    const frameObservations = byFrame.get(frameKey(observation)) ?? [observation];
    const votes = [0, 0, 0, 0];

    frameObservations.forEach((neighbor) => {
      if (neighbor === observation || !colorsAreAdjacent(observation.centerColor, neighbor.centerColor)) return;
      const sideEvidence = sideFromNeighbor(observation, neighbor);
      if (!sideEvidence) return;
      const turns = rotationTurnsForNeighbor(face, sideEvidence.side, neighbor.centerColor);
      if (turns === null) return;
      votes[turns] += sideEvidence.score
        * Math.max(0.42, neighbor.confidence / 100)
        * Math.min(1, neighbor.visibleCells / 6);
    });

    const ranked = votes
      .map((score, turns) => ({ turns, score }))
      .sort((left, right) => right.score - left.score);
    const best = ranked[0];
    const runnerUp = ranked[1];
    if (!best) return observation;
    const margin = best.score - (runnerUp?.score ?? 0);
    if (best.score < 0.35 || margin < 0.12) return observation;

    return {
      ...observation,
      colors: rotateGrid(observation.colors, best.turns),
      orientationTurns: best.turns,
      orientationConfidence: Math.round(Math.min(96, 54 + best.score * 32 + margin * 16)),
    };
  });
}

function observationWeight(observation: FaceGridObservation) {
  const orientationBonus = (observation.orientationConfidence ?? 0) >= ORIENTATION_LOCK_CONFIDENCE ? 1.25 : 1;
  return observation.confidence * observation.visibleCells * orientationBonus;
}

function fuseFaceObservations(observations: FaceGridObservation[]): FaceGridObservation {
  const ordered = [...observations].sort((left, right) => observationWeight(right) - observationWeight(left));
  const base = ordered[0];
  const colors = [...base.colors];
  let confidenceTotal = base.confidence;
  let orientationConfidence = base.orientationConfidence ?? 0;
  let fusedFrames = 1;

  ordered.slice(1).forEach((observation) => {
    const turnsToTry = (observation.orientationConfidence ?? 0) >= ORIENTATION_LOCK_CONFIDENCE ? [0] : [0, 1, 2, 3];
    const alignments = turnsToTry.map((turns) => {
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
      !best
      || best.conflicts > 0
      || best.nonCenterAgreements < 1
      || (runnerUp && best.score - runnerUp.score < 1)
    ) return;
    best.rotated.forEach((color, index) => {
      if (!colors[index] && color) colors[index] = color;
    });
    confidenceTotal += observation.confidence;
    orientationConfidence = Math.max(orientationConfidence, observation.orientationConfidence ?? 0);
    fusedFrames += 1;
  });

  return {
    ...base,
    colors,
    visibleCells: colors.filter(Boolean).length,
    confidence: Math.min(
      97,
      Math.round(
        confidenceTotal / fusedFrames
        + Math.min(8, (fusedFrames - 1) * 2)
        + Math.min(3, orientationConfidence / 35),
      ),
    ),
    orientationConfidence: orientationConfidence || undefined,
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
  const orientedObservations = normalizeObservationOrientations(observations);
  const observationsByFace = new Map<Face, FaceGridObservation[]>();
  orientedObservations.forEach((observation) => {
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

  const choices = observedFaces.map((face) => {
    const observation = bestByFace.get(face)!;
    return {
      face,
      rotations: (observation.orientationConfidence ?? 0) >= ORIENTATION_LOCK_CONFIDENCE
        ? [observation.colors]
        : [0, 1, 2, 3].map((turns) => rotateGrid(observation.colors, turns)),
    };
  });
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
  const orientationSupport = [...bestByFace.values()].filter((observation) => (
    (observation.orientationConfidence ?? 0) >= ORIENTATION_LOCK_CONFIDENCE
  )).length;
  const baseConfidence = Math.round(Math.min(
    96,
    bestObserved / 48 * 72
      + observedFaces.length / 6 * 18
      + (completeFacelets ? 6 : 0)
      + Math.min(4, orientationSupport),
  ));

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
