import {
  CANONICAL_COLOR_FACE,
  CANONICAL_FACE_COLOR,
  CUBE_FACES,
  type CubeColor,
  type Face,
} from './cube.ts';
import { validateCubeColorDistribution, type RgbSample } from './color-calibration.ts';
import { DBG, dbg } from './dbg-metrics.ts'; // DBG

export { CANONICAL_COLOR_FACE, CANONICAL_FACE_COLOR } from './cube.ts';

type GridSide = 'top' | 'right' | 'bottom' | 'left';
type Vector = readonly [number, number, number];

export type FaceGridObservation = {
  time: number;
  /** Identifica una singola inquadratura/crop per usare solo geometrie confrontabili. */
  frameId?: string;
  /** Raggruppa i crop ricavati dallo stesso fotogramma e non li conta come prove indipendenti. */
  captureId?: string;
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
  cellConfidences?: number[];
  bundleSize?: number;
  sourceFrames?: number;
  cellSupport?: number[];
  syntheticFusion?: boolean;
  /** Campioni RGB grezzi usati per ricalibrare i colori sui sei centri del video. */
  rawColors?: Array<RgbSample | null>;
  /** Come è stata ricavata la griglia: dalla silhouette del cubo o da coppie di sticker vicini. */
  gridSource?: 'silhouette' | 'pairs';
  /** Vertici della silhouette esagonale, quando la griglia viene da lì. */
  silhouette?: Array<{ x: number; y: number }>;
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
  faceCoverage: Record<Face, {
    observedCells: number;
    inferredCells: number;
    evidenceFrames: number;
    confidence: number;
    status: 'missing' | 'partial' | 'complete';
  }>;
  completeFacelets: Record<Face, CubeColor[]> | null;
  message: string;
  faceReference: Partial<Record<Face, {
    time: number;
    sourceFrames: number;
    frameId?: string;
    imageX?: number;
    imageY?: number;
    rightX?: number;
    rightY?: number;
    downX?: number;
    downY?: number;
    gridSource?: 'silhouette' | 'pairs';
    silhouette?: Array<{ x: number; y: number }>;
  }>>;
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

type PieceOption = {
  pieceIndex: number;
  stickers: Array<{ face: Face; index: number; color: CubeColor }>;
};

type ForcedPieceInference = {
  facelets: PartialFacelets;
  invalid: boolean;
  inferredFacelets: number;
  resolvedCorners: number;
  resolvedEdges: number;
};

type ObservationGeometry = {
  imageX: number;
  imageY: number;
  rightX: number;
  rightY: number;
  downX: number;
  downY: number;
};

const FACES = CUBE_FACES;
const GRID_SIDES: GridSide[] = ['top', 'right', 'bottom', 'left'];
const ORIENTATION_LOCK_CONFIDENCE = 58;

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

export const CUBIE_COLOR_SCHEMA = {
  corners: CORNERS.map(({ name, colors }) => ({ name, colors })),
  edges: EDGES.map(({ name, colors }) => ({ name, colors })),
};

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
  if (
    !Number.isFinite(imageX) || !Number.isFinite(imageY)
    || !Number.isFinite(rightX) || !Number.isFinite(rightY)
    || !Number.isFinite(downX) || !Number.isFinite(downY)
    || imageX === undefined || imageY === undefined
    || rightX === undefined || rightY === undefined
    || downX === undefined || downY === undefined
  ) return null;
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
  return observation.frameId ?? `${Math.round(observation.time * 1000)}`;
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
    // Più ipotesi con lo stesso centro indicano che la geometria del singolo
    // crop è ambigua (frequente sui cubi stickerless). Non blocchiamo qui
    // l'orientamento: sarà il consenso tra fotogrammi a scegliere l'ipotesi.
    if (frameObservations.some((candidate) => (
      candidate !== observation && candidate.centerColor === observation.centerColor
    ))) return observation;
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
      cellConfidences: rotateNumbers(observation.cellConfidences, best.turns),
      orientationTurns: best.turns,
      orientationConfidence: Math.round(Math.min(96, 54 + best.score * 32 + margin * 16)),
    };
  });
}

function observationWeight(observation: FaceGridObservation) {
  const orientationBonus = (observation.orientationConfidence ?? 0) >= ORIENTATION_LOCK_CONFIDENCE ? 1.25 : 1;
  return observation.confidence * observation.visibleCells * orientationBonus;
}

function rotateNumbers(values: number[] | undefined, turns: number) {
  if (!values?.length) return [];
  let result = [...values];
  for (let turn = 0; turn < turns; turn += 1) {
    const rotated = Array<number>(9).fill(0);
    for (let row = 0; row < 3; row += 1) {
      for (let column = 0; column < 3; column += 1) {
        rotated[column * 3 + (2 - row)] = result[row * 3 + column] ?? 0;
      }
    }
    result = rotated;
  }
  return result;
}

function stickerWeight(observation: FaceGridObservation, index: number, rotatedConfidence?: number[]) {
  const cellConfidence = rotatedConfidence?.[index]
    ?? observation.cellConfidences?.[index]
    ?? observation.confidence;
  const multiFaceBonus = 1 + Math.min(0.2, Math.max(0, (observation.bundleSize ?? 1) - 1) * 0.1);
  return Math.max(0.08, Math.min(1, cellConfidence / 100))
    * Math.max(0.35, Math.min(1, observation.confidence / 100))
    * multiFaceBonus;
}

function rotationInvariantPattern(colors: Array<CubeColor | null>) {
  return [0, 1, 2, 3]
    .map((turns) => rotateGrid(colors, turns).map((color) => color?.[0] ?? '_').join(''))
    .sort()[0];
}

function colorLayoutQuality(colors: Array<CubeColor | null>) {
  const visible = colors.filter((color): color is CubeColor => color !== null);
  const distinct = new Set(visible).size;
  if (visible.length === 9 && distinct === 1) return 1;
  if (distinct >= 4) return 1;
  if (distinct === 3) return 0.82;
  if (distinct === 2) return 0.32;
  return 0.18;
}

export function fuseFaceObservationCandidates(
  observations: FaceGridObservation[],
  limit = 4,
): FaceGridObservation[] {
  const ordered = [...observations].sort((left, right) => observationWeight(right) - observationWeight(left));
  type Aligned = {
    observation: FaceGridObservation;
    colors: Array<CubeColor | null>;
    confidences: number[];
    agreement: number;
    conflict: number;
  };
  type FusedCandidate = {
    seed: FaceGridObservation;
    colors: Array<CubeColor | null>;
    cellConfidences: number[];
    cellSupport: number[];
    aligned: Aligned[];
    score: number;
    confidence: number;
  };

  const seedsByPattern = new Map<string, { seed: FaceGridObservation; sources: Set<string> }>();
  ordered.forEach((observation) => {
    const key = rotationInvariantPattern(observation.colors);
    const source = observation.captureId ?? observation.frameId ?? observation.time.toFixed(4);
    const existing = seedsByPattern.get(key);
    if (existing) existing.sources.add(source);
    else seedsByPattern.set(key, { seed: observation, sources: new Set([source]) });
  });
  const seedPool = [...seedsByPattern.values()]
    .sort((left, right) => (
      right.sources.size * 24 + observationWeight(right.seed)
      - (left.sources.size * 24 + observationWeight(left.seed))
    ))
    .slice(0, 72)
    .map(({ seed }) => seed);

  const candidates: FusedCandidate[] = seedPool.map((seed) => {
    const seedCapture = seed.captureId ?? seed.frameId ?? seed.time.toFixed(4);
    const aligned: Aligned[] = [{
      observation: seed,
      colors: [...seed.colors],
      confidences: seed.cellConfidences?.length === 9
        ? [...seed.cellConfidences]
        : seed.colors.map((color) => color ? seed.confidence : 0),
      agreement: 0,
      conflict: 0,
    }];

    const bestByCapture = new Map<string, Aligned & { score: number }>();
    ordered.forEach((observation) => {
      if (observation === seed) return;
      // Una faccia resta coerente per una breve posa. Letture lontane nel
      // tempo appartengono spesso a pose diverse o alle mani sullo sfondo.
      if (Math.abs(observation.time - seed.time) > 0.82) return;
      const turnsToTry = (observation.orientationConfidence ?? 0) >= ORIENTATION_LOCK_CONFIDENCE
        ? [0]
        : [0, 1, 2, 3];
      const rotations = turnsToTry.map((turns) => {
        const colors = rotateGrid(observation.colors, turns);
        const confidences = rotateNumbers(observation.cellConfidences, turns);
        let agreement = 0;
        let conflict = 0;
        let overlap = 0;
        let nonCenterOverlap = 0;
        let matches = 0;
        let mismatches = 0;
        colors.forEach((color, index) => {
          const reference = seed.colors[index];
          if (!color || !reference || index === 4) return;
          overlap += 1;
          nonCenterOverlap += 1;
          const weight = stickerWeight(observation, index, confidences)
            + stickerWeight(seed, index) * 0.6;
          if (color === reference) {
            agreement += weight;
            matches += 1;
          } else {
            conflict += weight;
            mismatches += 1;
          }
        });
        return {
          colors,
          confidences,
          agreement,
          conflict,
          overlap,
          nonCenterOverlap,
          matches,
          mismatches,
          score: agreement * 2.6 - conflict * 5.2 + overlap * 0.08,
        };
      }).sort((left, right) => right.score - left.score);
      const best = rotations[0];
      const runnerUp = rotations[1];
      const uniqueAlignment = !runnerUp || best.score - runnerUp.score >= 0.42;
      const coherent = best.matches >= 3
        && best.mismatches <= 1
        && best.agreement >= Math.max(0.9, best.conflict * 3.2);
      if (best.nonCenterOverlap < 3 || !uniqueAlignment || !coherent) { if (DBG) dbg.fusionAlign.rejIncoherent += 1; return; } // DBG
      const capture = observation.captureId ?? observation.frameId ?? observation.time.toFixed(4);
      if (capture === seedCapture) return;
      const current = bestByCapture.get(capture);
      if (!current || best.score > current.score) {
        if (DBG && !current) dbg.fusionAlign.accepted += 1; // DBG
        bestByCapture.set(capture, { observation, ...best });
      }
    });
    aligned.push(...[...bestByCapture.values()]);

    const colors = Array<CubeColor | null>(9).fill(null);
    const cellConfidences = Array<number>(9).fill(0);
    const cellSupport = Array<number>(9).fill(0);
    let consensusStrength = 0;
    let consensusConflict = 0;
    for (let index = 0; index < 9; index += 1) {
      const votes = new Map<CubeColor, { weight: number; sources: Set<string>; strongest: number }>();
      aligned.forEach(({ observation, colors: alignedColors, confidences }) => {
        const color = alignedColors[index];
        if (!color) return;
        const weight = stickerWeight(observation, index, confidences);
        const vote = votes.get(color) ?? { weight: 0, sources: new Set<string>(), strongest: 0 };
        vote.weight += weight;
        vote.sources.add(observation.captureId ?? observation.frameId ?? observation.time.toFixed(4));
        vote.strongest = Math.max(vote.strongest, confidences[index] || observation.confidence);
        votes.set(color, vote);
      });
      const ranked = [...votes.entries()].sort((left, right) => right[1].weight - left[1].weight);
      const winner = ranked[0];
      if (!winner) continue;
      const totalWeight = ranked.reduce((total, entry) => total + entry[1].weight, 0);
      const ratio = winner[1].weight / Math.max(0.001, totalWeight);
      const strongestSource = aligned.find((entry) => entry.colors[index] === winner[0])!.observation;
      const support = winner[1].sources.size;
      const singleStrongFrame = support === 1
        && winner[1].strongest >= 78
        && strongestSource.visibleCells >= 7;
      const suppliedBySeed = strongestSource === seed && seed.colors[index] === winner[0];
      const accepted = index === 4
        || (ratio >= 0.67 && (support >= 2 || singleStrongFrame || suppliedBySeed));
      if (!accepted) {
        if (DBG && index !== 4) { if (ratio < 0.67) dbg.fusionCell.rejVoteSplit += 1; else dbg.fusionCell.rejWeakSingleFrame += 1; } // DBG
        continue;
      }
      if (DBG && index !== 4) dbg.fusionCell.accepted += 1; // DBG
      colors[index] = winner[0];
      cellSupport[index] = support;
      cellConfidences[index] = Math.round(Math.min(98, Math.max(35, ratio * 82 + Math.min(14, support * 3))));
      consensusStrength += winner[1].weight;
      consensusConflict += Math.max(0, totalWeight - winner[1].weight);
    }
    colors[4] = seed.centerColor;
    cellConfidences[4] = Math.max(cellConfidences[4], seed.confidence);
    cellSupport[4] = Math.max(cellSupport[4], aligned.length);
    const acceptedCells = colors.filter(Boolean).length;
    const confidence = Math.round(Math.min(97, Math.max(
      38,
      acceptedCells / 9 * 68
        + Math.min(18, aligned.length * 2.5)
        + consensusStrength / Math.max(1, consensusStrength + consensusConflict) * 10,
    )));
    return {
      seed,
      colors,
      cellConfidences,
      cellSupport,
      aligned,
      confidence,
      score: (acceptedCells * 15 + aligned.length * 12 + consensusStrength * 2.5 - consensusConflict * 5
        + frontalCleanlinessScore({ ...seed, cellConfidences }) * 85)
        * colorLayoutQuality(colors),
    };
  });

  const fused = candidates
    .sort((left, right) => right.score - left.score)
    .map((candidate) => ({
      rank: candidate.score,
      observation: {
        ...candidate.seed,
        colors: candidate.colors,
        visibleCells: candidate.colors.filter(Boolean).length,
        confidence: candidate.confidence,
        cellConfidences: candidate.cellConfidences,
        cellSupport: candidate.cellSupport,
        sourceFrames: new Set(candidate.aligned.map(({ observation }) => (
          observation.captureId ?? observation.frameId ?? observation.time.toFixed(4)
        ))).size,
        syntheticFusion: true,
      },
    }));
  // Conserviamo anche le letture geometriche originali. Una faccia nitida può
  // apparire soltanto per pochi decimi; diluirla nel consenso di molti falsi
  // allineamenti (tipici dei cubi stickerless) eliminerebbe proprio la prova
  // migliore. I vincoli fisici sceglieranno poi tra raw e consenso temporale.
  const raw = [...seedsByPattern.values()]
    .map(({ seed, sources }) => ({
      rank: (seed.visibleCells * 28 + seed.confidence + sources.size * 18
        // Fra più passaggi sulla stessa faccia, preferiamo quello visto
        // frontalmente e senza dita davanti: da solo il conteggio celle non
        // basta più, perché anche le celle occluse vengono campionate.
        + frontalCleanlinessScore(seed) * 120)
        * colorLayoutQuality(seed.colors),
      observation: {
        ...seed,
        colors: [...seed.colors],
        cellConfidences: seed.cellConfidences ? [...seed.cellConfidences] : undefined,
        sourceFrames: sources.size,
        syntheticFusion: false,
      },
    }))
    .sort((left, right) => right.rank - left.rank);
  const rawLimit = Math.max(1, Math.ceil(Math.max(1, limit) * 0.75));
  const preferred = [
    ...raw.slice(0, rawLimit),
    ...fused.slice(0, Math.max(1, limit - rawLimit)),
    ...raw.slice(rawLimit),
    ...fused.slice(Math.max(1, limit - rawLimit)),
  ];
  const seen = new Set<string>();
  return preferred
    .filter(({ observation }) => {
      const key = rotationInvariantPattern(observation.colors);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, Math.max(1, limit))
    .map(({ observation }) => observation);
}

export function fuseFaceObservations(observations: FaceGridObservation[]): FaceGridObservation {
  return fuseFaceObservationCandidates(observations, 1)[0];
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

function pieceOptionsFor(position: PieceDefinition, pieces: PieceDefinition[], partial: PartialFacelets): PieceOption[] {
  const counts = colorCounts(partial);
  return pieces.flatMap((piece, pieceIndex) => (
    orientedAssignments(position, piece)
      .filter((assignment) => assignment.stickers.every(({ face, index, color }) => {
        const current = partial[face][index];
        if (current === color) return true;
        if (current !== null) return false;
        // Ogni colore compare esattamente 9 volte su un cubo reale: se è già
        // esaurito altrove, questa assegnazione non può essere valida qui.
        return counts[color] < 9;
      }))
      .map((assignment) => ({ pieceIndex, stickers: assignment.stickers }))
  ));
}

function enumeratePieceAssignments(
  positions: PieceDefinition[],
  pieces: PieceDefinition[],
  partial: PartialFacelets,
  limit: number,
) {
  const counts = colorCounts(partial);
  const options = positions.map((position) => pieces.flatMap((piece, pieceIndex) => (
    orientedAssignments(position, piece)
      .filter((assignment) => assignment.stickers.every(({ face, index, color }) => {
        const current = partial[face][index];
        if (current === color) return true;
        if (current !== null) return false;
        return counts[color] < 9;
      }))
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

function countKnownFacelets(facelets: PartialFacelets) {
  return FACES.reduce((total, face) => total + facelets[face].filter(Boolean).length, 0);
}

function pieceEvidenceValid(partial: PartialFacelets) {
  return CORNERS.every((position) => pieceOptionsFor(position, CORNERS, partial).length > 0)
    && EDGES.every((position) => pieceOptionsFor(position, EDGES, partial).length > 0);
}

function inferForcedPieceGroup(
  positions: PieceDefinition[],
  pieces: PieceDefinition[],
  partial: PartialFacelets,
) {
  const facelets = cloneFacelets(partial);
  let options = positions.map((position) => pieceOptionsFor(position, pieces, facelets));
  let invalid = false;

  for (let iteration = 0; iteration < positions.length + 2; iteration += 1) {
    let changed = false;
    const counts = colorCounts(facelets);
    options = options.map((positionOptions) => positionOptions.filter((option) => option.stickers.every(({ face, index, color }) => {
      const current = facelets[face][index];
      if (current === color) return true;
      if (current !== null) return false;
      return counts[color] < 9;
    })));
    if (options.some((positionOptions) => !positionOptions.length)) {
      invalid = true;
      break;
    }

    const forcedPieceByPosition = new Map<number, number>();
    options.forEach((positionOptions, positionIndex) => {
      const possiblePieces = new Set(positionOptions.map((option) => option.pieceIndex));
      if (possiblePieces.size === 1) forcedPieceByPosition.set(positionIndex, positionOptions[0].pieceIndex);
    });

    const forcedPositionsByPiece = new Map<number, number[]>();
    forcedPieceByPosition.forEach((pieceIndex, positionIndex) => {
      forcedPositionsByPiece.set(pieceIndex, [...(forcedPositionsByPiece.get(pieceIndex) ?? []), positionIndex]);
    });
    if ([...forcedPositionsByPiece.values()].some((positionIndexes) => positionIndexes.length > 1)) {
      invalid = true;
      break;
    }

    const possiblePositionsByPiece = new Map<number, number[]>();
    options.forEach((positionOptions, positionIndex) => {
      new Set(positionOptions.map((option) => option.pieceIndex)).forEach((pieceIndex) => {
        possiblePositionsByPiece.set(pieceIndex, [...(possiblePositionsByPiece.get(pieceIndex) ?? []), positionIndex]);
      });
    });

    options = options.map((positionOptions, positionIndex) => {
      const piecesForcedHere = [...possiblePositionsByPiece.entries()]
        .filter(([, positionIndexes]) => positionIndexes.length === 1 && positionIndexes[0] === positionIndex)
        .map(([pieceIndex]) => pieceIndex);
      if (piecesForcedHere.length > 1) {
        invalid = true;
        return [];
      }
      const unavailablePieces = new Set(
        [...forcedPieceByPosition.entries()]
          .filter(([otherPosition]) => otherPosition !== positionIndex)
          .map(([, pieceIndex]) => pieceIndex),
      );
      const filtered = positionOptions.filter((option) => (
        !unavailablePieces.has(option.pieceIndex)
        && (!piecesForcedHere.length || option.pieceIndex === piecesForcedHere[0])
      ));
      if (filtered.length !== positionOptions.length) changed = true;
      return filtered;
    });
    if (invalid || options.some((positionOptions) => !positionOptions.length)) {
      invalid = true;
      break;
    }

    options.forEach((positionOptions, positionIndex) => {
      const position = positions[positionIndex];
      position.faces.forEach((face, slot) => {
        const index = position.indices[slot];
        if (facelets[face][index]) return;
        const first = positionOptions[0].stickers[slot].color;
        if (positionOptions.every((option) => option.stickers[slot].color === first)) {
          facelets[face][index] = first;
          changed = true;
        }
      });
    });
    if (!changed) break;
  }

  const resolvedPieces = invalid
    ? 0
    : options.filter((positionOptions) => new Set(positionOptions.map((option) => option.pieceIndex)).size === 1).length;
  return { facelets, invalid, resolvedPieces };
}

function inferForcedPieceFacelets(partial: PartialFacelets): ForcedPieceInference {
  const startingFacelets = countKnownFacelets(partial);
  const edges = inferForcedPieceGroup(EDGES, EDGES, partial);
  if (edges.invalid) {
    return {
      facelets: edges.facelets,
      invalid: true,
      inferredFacelets: 0,
      resolvedCorners: 0,
      resolvedEdges: 0,
    };
  }
  const corners = inferForcedPieceGroup(CORNERS, CORNERS, edges.facelets);
  if (corners.invalid) {
    return {
      facelets: corners.facelets,
      invalid: true,
      inferredFacelets: 0,
      resolvedCorners: 0,
      resolvedEdges: edges.resolvedPieces,
    };
  }
  return {
    facelets: corners.facelets,
    invalid: false,
    inferredFacelets: countKnownFacelets(corners.facelets) - startingFacelets,
    resolvedCorners: corners.resolvedPieces,
    resolvedEdges: edges.resolvedPieces,
  };
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

function colorCounts(facelets: PartialFacelets): Record<CubeColor, number> {
  const counts = Object.fromEntries(CUBE_COLORS.map((color) => [color, 0])) as Record<CubeColor, number>;
  FACES.forEach((face) => facelets[face].forEach((color) => {
    if (color) counts[color] += 1;
  }));
  return counts;
}

function colorCountValid(facelets: PartialFacelets) {
  const counts = colorCounts(facelets);
  return Object.values(counts).every((count) => count <= 9);
}

const CELL_POSITION_LABEL = [
  'in alto a sinistra', 'in alto al centro', 'in alto a destra',
  'al centro a sinistra', 'centro', 'al centro a destra',
  'in basso a sinistra', 'in basso al centro', 'in basso a destra',
];

const FACE_COLOR_ADJECTIVE: Record<Face, string> = {
  U: 'bianca', R: 'rossa', F: 'verde', D: 'gialla', L: 'arancione', B: 'blu',
};

function describeMissingFacelets(facelets: PartialFacelets, limit = 6): string | null {
  const missing: string[] = [];
  FACES.forEach((face) => {
    facelets[face].forEach((color, index) => {
      if (color === null && index !== 4) {
        missing.push(`faccia ${FACE_COLOR_ADJECTIVE[face]} · casella ${CELL_POSITION_LABEL[index]}`);
      }
    });
  });
  if (!missing.length) return null;
  const shown = missing.slice(0, limit);
  const suffix = missing.length > limit ? `, e altre ${missing.length - limit}` : '';
  return `Caselle ancora mancanti: ${shown.join('; ')}${suffix}.`;
}

function geometryQuality(observation: FaceGridObservation): number {
  const { rightX, rightY, downX, downY } = observation;
  if (rightX === undefined || rightY === undefined || downX === undefined || downY === undefined) return 0;
  const rightLength = Math.hypot(rightX, rightY);
  const downLength = Math.hypot(downX, downY);
  if (!rightLength || !downLength) return 0;
  const cosine = Math.abs((rightX * downX + rightY * downY) / (rightLength * downLength));
  const ratio = rightLength / downLength;
  const ratioDeviation = Math.abs(Math.log(ratio));
  // 1 quando gli assi sono perfettamente perpendicolari e della stessa
  // lunghezza (griglia vista dritta), via via più basso quanto più il
  // parallelogramma risulta inclinato o sproporzionato.
  return Math.max(0, 1 - cosine * 1.4 - ratioDeviation * 0.6);
}

/**
 * Quanto una lettura è "frontale e pulita", cioè adatta a essere preferita fra
 * più passaggi sulla stessa faccia:
 *
 * - frontalità: una faccia vista dritta è un quadrato, una vista di scorcio è
 *   un parallelogramma inclinato (geometryQuality);
 * - pulizia: le celle coperte da un dito vengono comunque campionate (leggendo
 *   la pelle), quindi il conteggio di celle visibili da solo non basta più a
 *   distinguerle; la confidenza media per cella invece cala quando la lettura
 *   non corrisponde a uno sticker netto.
 *
 * Restituisce un valore neutro (0.5) quando i dati non sono disponibili, per
 * non penalizzare osservazioni prive di geometria o di confidenze per cella.
 */
function frontalCleanlinessScore(observation: FaceGridObservation): number {
  const hasGeometry = observation.rightX !== undefined && observation.downX !== undefined;
  const frontality = hasGeometry ? geometryQuality(observation) : 0.5;
  const confidences = (observation.cellConfidences ?? []).filter((value) => value > 0);
  const cleanliness = confidences.length
    ? Math.max(0, Math.min(1, (confidences.reduce((total, value) => total + value, 0) / confidences.length) / 90))
    : 0.5;
  return frontality * 0.6 + cleanliness * 0.4;
}

function computeFaceReferences(
  hypothesesByFace: Map<Face, FaceGridObservation[]>,
  facelets: PartialFacelets,
): InspectionReconstruction['faceReference'] {
  const references: InspectionReconstruction['faceReference'] = {};
  FACES.forEach((face) => {
    const hypotheses = hypothesesByFace.get(face) ?? [];
    let best: FaceGridObservation | null = null;
    let bestMatches = -1;
    let bestGeometry = -1;
    hypotheses.forEach((hypothesis) => {
      let matches = 0;
      hypothesis.colors.forEach((color, index) => {
        if (color && color === facelets[face][index]) matches += 1;
      });
      const geometry = geometryQuality(hypothesis);
      // Non solo un pareggio esatto: anche a un solo punto di distanza dal
      // migliore, una griglia molto più pulita geometricamente (scorcio
      // meno estremo, quindi più affidabile anche nella lettura colore)
      // vale la pena preferirla per la visualizzazione diagnostica.
      const isNearTie = matches >= bestMatches - 1;
      const winsOnMatches = matches > bestMatches;
      const winsOnGeometryNearTie = isNearTie && geometry > bestGeometry + 0.18;
      if (winsOnMatches || winsOnGeometryNearTie) {
        bestMatches = Math.max(bestMatches, matches);
        bestGeometry = geometry;
        best = hypothesis;
      }
    });
    if (best) {
      const winner = best as FaceGridObservation;
      references[face] = {
        time: winner.time,
        sourceFrames: winner.sourceFrames ?? 1,
        frameId: winner.frameId,
        imageX: winner.imageX,
        imageY: winner.imageY,
        rightX: winner.rightX,
        rightY: winner.rightY,
        downX: winner.downX,
        downY: winner.downY,
        gridSource: winner.gridSource,
        silhouette: winner.silhouette,
      };
    }
  });
  return references;
}

function faceletKey(facelets: PartialFacelets) {
  return FACES.flatMap((face) => facelets[face].map((color) => color?.[0] ?? '_')).join('');
}

type CandidateEvidenceScore = {
  score: number;
  supportingCaptures: number;
};

/**
 * Valuta uno stato completo contro tutte le letture originali, non soltanto
 * contro le ipotesi finite per prime nel beam search. In ogni fotogramma conta
 * una sola griglia per faccia: così i tre crop e le geometrie alternative non
 * possono moltiplicare artificialmente la stessa prova.
 */
function scoreCandidateAgainstObservations(
  candidate: PartialFacelets,
  observationsByFace: Map<Face, FaceGridObservation[]>,
  hypothesesByFace?: Map<Face, FaceGridObservation[]>,
): CandidateEvidenceScore {
  let score = 0;
  let supportingCaptures = 0;

  FACES.forEach((face) => {
    const target = candidate[face];
    const bestByCapture = new Map<string, { score: number; time: number }>();
    (observationsByFace.get(face) ?? []).forEach((observation) => {
      if (colorLayoutQuality(observation.colors) < 0.8) return;
      const turnsToTry = (observation.orientationConfidence ?? 0) >= ORIENTATION_LOCK_CONFIDENCE
        ? [0]
        : [0, 1, 2, 3];
      const best = turnsToTry.map((turns) => {
        const colors = rotateGrid(observation.colors, turns);
        const confidences = rotateNumbers(observation.cellConfidences, turns);
        let matches = 0;
        let mismatches = 0;
        let agreement = 0;
        let conflict = 0;
        colors.forEach((color, index) => {
          if (!color || index === 4) return;
          const weight = stickerWeight(observation, index, confidences);
          if (target[index] === color) {
            matches += 1;
            agreement += weight;
          } else {
            mismatches += 1;
            conflict += weight;
          }
        });
        return {
          matches,
          mismatches,
          score: agreement * 3.2 - conflict * 5.8 + matches * 0.22,
        };
      }).sort((left, right) => right.score - left.score)[0];
      if (!best || best.matches < 3 || best.matches < best.mismatches * 2 || best.score <= 0) return;
      const capture = observation.captureId ?? observation.frameId ?? observation.time.toFixed(4);
      const existing = bestByCapture.get(capture);
      if (!existing || best.score > existing.score) {
        bestByCapture.set(capture, { score: best.score, time: observation.time });
      }
    });

    const evidence = [...bestByCapture.values()].sort((left, right) => left.time - right.time);
    evidence.forEach((entry) => { score += entry.score; });
    supportingCaptures += evidence.length;
    for (let index = 1; index < evidence.length; index += 1) {
      const gap = evidence[index].time - evidence[index - 1].time;
      if (gap >= 0 && gap <= 0.72) {
        score += Math.min(evidence[index - 1].score, evidence[index].score) * 0.18;
      }
    }

    // Una lettura raw ricomparsa identica in più pose è una prova più forte
    // di geometrie alternative dello stesso fotogramma. La premiamo a parte
    // senza usare le celle create dalla fusione sintetica.
    (hypothesesByFace?.get(face) ?? [])
      .filter((observation) => !observation.syntheticFusion && (observation.sourceFrames ?? 1) >= 2)
      .forEach((observation) => {
        const best = [0, 1, 2, 3].map((turns) => {
          const colors = rotateGrid(observation.colors, turns);
          const confidences = rotateNumbers(observation.cellConfidences, turns);
          let agreement = 0;
          let conflict = 0;
          let matches = 0;
          colors.forEach((color, index) => {
            if (!color || index === 4) return;
            const weight = stickerWeight(observation, index, confidences);
            if (target[index] === color) {
              agreement += weight;
              matches += 1;
            } else {
              conflict += weight;
            }
          });
          return { matches, score: agreement * 3.6 - conflict * 7.4 };
        }).sort((left, right) => right.score - left.score)[0];
        if (!best || best.matches < 4) return;
        score += best.score * Math.min(4, observation.sourceFrames ?? 1) * 0.72;
      });
  });

  return { score, supportingCaptures };
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
  const complete = Object.fromEntries(
    FACES.map((face) => [face, facelets[face] as CubeColor[]]),
  ) as Record<Face, CubeColor[]>;
  return validateCubeColorDistribution(complete).valid ? complete : null;
}

function buildFaceCoverage(
  bestByFace: Map<Face, FaceGridObservation>,
  displayed: PartialFacelets,
): InspectionReconstruction['faceCoverage'] {
  return Object.fromEntries(FACES.map((face) => {
    const observation = bestByFace.get(face);
    const observedCells = observation?.colors.filter(Boolean).length ?? 0;
    const displayedCells = displayed[face].filter(Boolean).length;
    const inferredCells = Math.max(0, displayedCells - Math.max(1, observedCells));
    return [face, {
      observedCells,
      inferredCells,
      evidenceFrames: observation?.sourceFrames ?? (observation ? 1 : 0),
      confidence: observation?.confidence ?? 0,
      status: observedCells === 9
        ? 'complete' as const
        : observedCells >= 2
          ? 'partial' as const
          : 'missing' as const,
    }];
  })) as InspectionReconstruction['faceCoverage'];
}

export function reconstructInspectionState(observations: FaceGridObservation[]): InspectionReconstruction {
  const orientedObservations = normalizeObservationOrientations(observations);
  const observationsByFace = new Map<Face, FaceGridObservation[]>();
  orientedObservations.forEach((observation) => {
    if (observation.colors.length !== 9 || observation.visibleCells < 5) { if (DBG) dbg.reconstruct.droppedLowVisible += 1; return; } // DBG
    const face = CANONICAL_COLOR_FACE[observation.centerColor];
    observationsByFace.set(face, [...(observationsByFace.get(face) ?? []), observation]);
  });
  const hypothesesByFace = new Map<Face, FaceGridObservation[]>();
  const bestByFace = new Map<Face, FaceGridObservation>();
  observationsByFace.forEach((faceObservations, face) => {
    const hypotheses = fuseFaceObservationCandidates(faceObservations, 18);
    hypothesesByFace.set(face, hypotheses);
    if (hypotheses[0]) bestByFace.set(face, hypotheses[0]);
  });

  const observedFaces = [...bestByFace.keys()].sort((left, right) => (
    (bestByFace.get(right)?.visibleCells ?? 0) - (bestByFace.get(left)?.visibleCells ?? 0)
  ));
  if (!observedFaces.length) {
    const facelets = withCanonicalCenters();
    return {
      status: 'insufficient', observedFaces: [], observedFacelets: 0, inferredFacelets: 0,
      resolvedCorners: 0, resolvedEdges: 0, candidateCount: 0, truncated: false,
      confidence: 0, facelets, faceCoverage: buildFaceCoverage(bestByFace, facelets), completeFacelets: null,
      message: 'Nessuna griglia 3×3 abbastanza stabile è stata letta durante l’ispezione.',
      faceReference: {},
    };
  }

  const choices = observedFaces.map((face) => {
    const hypotheses = hypothesesByFace.get(face) ?? [bestByFace.get(face)!];
    const rotationsByPattern = new Map<string, {
      grid: Array<CubeColor | null>;
      confidences: number[];
      score: number;
      relaxed: number;
    }>();
    hypotheses.forEach((observation, hypothesisIndex) => {
      const turnsToTry = (observation.orientationConfidence ?? 0) >= ORIENTATION_LOCK_CONFIDENCE
        ? [0]
        : [0, 1, 2, 3];
      turnsToTry.forEach((turns) => {
        const grid = rotateGrid(observation.colors, turns);
        const confidences = rotateNumbers(observation.cellConfidences, turns);
        const weakest = grid.map((color, index) => ({
          index,
          color,
          confidence: confidences[index] || observation.confidence,
        })).filter((cell) => cell.color && cell.index !== 4 && cell.confidence < 66)
          .sort((left, right) => left.confidence - right.confidence)
          .slice(0, 4);
        const removalSets: Array<typeof weakest> = [[]];
        if (hypothesisIndex < 6 && !observation.syntheticFusion) {
          for (let first = 0; first < weakest.length; first += 1) {
            removalSets.push([weakest[first]]);
            for (let second = first + 1; second < weakest.length; second += 1) {
              removalSets.push([weakest[first], weakest[second]]);
              for (let third = second + 1; third < weakest.length; third += 1) {
                removalSets.push([weakest[first], weakest[second], weakest[third]]);
              }
            }
          }
        } else {
          for (let removedCount = 1; removedCount <= Math.min(3, weakest.length); removedCount += 1) {
            removalSets.push(weakest.slice(0, removedCount));
          }
        }
        const variants = removalSets.map((removed) => {
          const variantGrid = [...grid];
          const variantConfidences = [...confidences];
          removed.forEach((cell) => {
            variantGrid[cell.index] = null;
            variantConfidences[cell.index] = 0;
          });
          return { grid: variantGrid, confidences: variantConfidences, removed };
        });
        variants.forEach((variant) => {
          const key = variant.grid.map((color) => color?.[0] ?? '_').join('');
          const sourceFrames = observation.sourceFrames ?? 1;
          const visibleCells = variant.grid.filter(Boolean).length;
          const removalPenalty = variant.removed.reduce((total, cell) => total + cell.confidence * 0.1 + 8, 0);
          const score = visibleCells * 12
            + observation.confidence
            + Math.min(24, sourceFrames * 7)
            + colorLayoutQuality(variant.grid) * 34
            - (observation.syntheticFusion ? 20 : 0)
            - hypothesisIndex * 1.5
            - removalPenalty;
          const existing = rotationsByPattern.get(key);
          if (!existing || score > existing.score) rotationsByPattern.set(key, {
            grid: variant.grid,
            confidences: variant.confidences,
            score,
            relaxed: variant.removed.length,
          });
        });
      });
    });
    return {
      face,
      rotations: [...rotationsByPattern.values()].sort((left, right) => right.score - left.score),
    };
  });
  type RankedCompleteState = { facelets: PartialFacelets; sourceScore: number; relaxed: number };
  const validStates = new Map<string, RankedCompleteState>();
  let sawTruncation = false;
  let bestPartial = withCanonicalCenters();
  let bestObservedPartial = withCanonicalCenters();
  let bestObservedReliability = Object.fromEntries(FACES.map((face) => [face, Array<number>(9).fill(0)])) as Record<Face, number[]>;
  let bestObserved = 0;
  let bestPartialQuality = Number.NEGATIVE_INFINITY;
  let bestPieceInference: ForcedPieceInference | null = null;
  const beamWidth = 1600;
  const maximumRotationCombinations = beamWidth;
  let rotationCombinations = 0;

  function storeCompleteState(facelets: PartialFacelets, sourceScore: number, relaxed = 0) {
    const key = faceletKey(facelets);
    const existing = validStates.get(key);
    if (!existing || sourceScore > existing.sourceScore) {
      validStates.set(key, { facelets, sourceScore, relaxed });
    }
  }

  function considerPartial(
    partial: PartialFacelets,
    reliability: Record<Face, number[]>,
    sourceScore: number,
  ) {
    if (!colorCountValid(partial)) return null;
    const observedCount = countKnownFacelets(partial) - 6;
    const pieceInference = inferForcedPieceFacelets(partial);
    if (pieceInference.invalid) return null;
    const inferredKnownCount = countKnownFacelets(pieceInference.facelets) - 6;
    const bestKnownCount = countKnownFacelets(bestPartial) - 6;
    const quality = observedCount * 42 + inferredKnownCount * 7 + sourceScore;
    if (quality > bestPartialQuality || (
      quality === bestPartialQuality
      && (observedCount > bestObserved || (observedCount === bestObserved && inferredKnownCount > bestKnownCount))
    )) {
      bestObserved = observedCount;
      bestPartialQuality = quality;
      bestObservedPartial = cloneFacelets(partial);
      bestObservedReliability = Object.fromEntries(FACES.map((face) => [face, [...reliability[face]]])) as Record<Face, number[]>;
      bestPartial = cloneFacelets(pieceInference.facelets);
      bestPieceInference = pieceInference;
    }
    return pieceInference;
  }

  type BeamState = {
    facelets: PartialFacelets;
    reliability: Record<Face, number[]>;
    score: number;
    relaxed: number;
  };
  const emptyReliability = () => Object.fromEntries(
    FACES.map((face) => [face, Array<number>(9).fill(0)]),
  ) as Record<Face, number[]>;
  let beam: BeamState[] = [{ facelets: withCanonicalCenters(), reliability: emptyReliability(), score: 0, relaxed: 0 }];
  choices.forEach((choice) => {
    const nextByState = new Map<string, BeamState>();
    beam.forEach((state) => choice.rotations.forEach(({ grid, confidences, score, relaxed }) => {
      const next = cloneFacelets(state.facelets);
      const reliability = Object.fromEntries(
        FACES.map((face) => [face, [...state.reliability[face]]]),
      ) as Record<Face, number[]>;
      let conflict = false;
      grid.forEach((color, index) => {
        if (!color) return;
        const existing = next[choice.face][index];
        if (existing && existing !== color) conflict = true;
        next[choice.face][index] = color;
        reliability[choice.face][index] = confidences[index] || 45;
      });
      if (conflict || !colorCountValid(next) || !pieceEvidenceValid(next)) return;
      const key = faceletKey(next);
      const candidate = {
        facelets: next,
        reliability,
        score: state.score + score,
        relaxed: state.relaxed + relaxed,
      };
      const existing = nextByState.get(key);
      if (!existing || candidate.score > existing.score) nextByState.set(key, candidate);
    }));
    const ranked = [...nextByState.values()].sort((left, right) => right.score - left.score);
    if (ranked.length > beamWidth) sawTruncation = true;
    beam = ranked.slice(0, beamWidth);
    beam.forEach((state) => considerPartial(state.facelets, state.reliability, state.score));
  });

  let relaxedFacelets = 0;
  for (const state of beam) {
    if (rotationCombinations >= maximumRotationCombinations || validStates.size >= 256) {
      sawTruncation = true;
      break;
    }
    rotationCombinations += 1;
    const observedCount = countKnownFacelets(state.facelets) - 6;
    const pieceInference = considerPartial(state.facelets, state.reliability, state.score);
    if (!pieceInference || observedCount < 18) continue;
    const completion = completePartialFacelets(pieceInference.facelets);
    sawTruncation ||= completion.truncated;
    if (state.relaxed > 0) {
      relaxedFacelets = relaxedFacelets ? Math.min(relaxedFacelets, state.relaxed) : state.relaxed;
      sawTruncation = true;
    }
    completion.complete.forEach((candidate) => storeCompleteState(candidate, state.score, state.relaxed));
  }

  // Se ogni faccia contiene anche una sola casella classificata male, nessuna
  // combinazione completa può superare i vincoli del cubo. Recuperiamo allora
  // lo stato migliore rimuovendo poche letture deboli e lasciando che gli
  // angoli/spigoli validi ricostruiscano soltanto quelle caselle.
  if (!validStates.size && bestObserved >= 18) {
    // Non rilassiamo soltanto il singolo ramo con più caselle. Un ramo appena
    // sotto può contenere la faccia nitida corretta e perdere punti solo perché
    // un'altra faccia è coperta. Esplorare pochi rami forti evita che una falsa
    // lettura completa cancelli un pattern ripetuto in più fotogrammi.
    const diversifiedSources: BeamState[] = [{
      facelets: bestObservedPartial,
      reliability: bestObservedReliability,
      score: bestPartialQuality,
      relaxed: 0,
    }];
    const seenAnchorPatterns = new Set<string>([
      `${rotationInvariantPattern(bestObservedPartial.U)}:${rotationInvariantPattern(bestObservedPartial.F)}`,
    ]);
    beam.forEach((state) => {
      if (diversifiedSources.length >= 14) return;
      const key = `${rotationInvariantPattern(state.facelets.U)}:${rotationInvariantPattern(state.facelets.F)}`;
      if (seenAnchorPatterns.has(key)) return;
      seenAnchorPatterns.add(key);
      diversifiedSources.push(state);
    });
    const relaxationSources = diversifiedSources.length
      ? diversifiedSources
      : [{ facelets: bestObservedPartial, reliability: bestObservedReliability, score: bestPartialQuality, relaxed: 0 }];
    let successfulRelaxations = 0;
    for (const source of relaxationSources) {
      const removable = FACES.flatMap((face) => source.facelets[face].map((color, index) => ({
        face,
        index,
        color,
        reliability: source.reliability[face][index] || 45,
      }))).filter((cell) => cell.color && cell.index !== 4)
        .sort((left, right) => left.reliability - right.reliability)
        .slice(0, 18);
      const relaxations: Array<{ indexes: number[]; score: number }> = [];
      for (let first = 0; first < removable.length; first += 1) {
        relaxations.push({ indexes: [first], score: removable[first].reliability });
        for (let second = first + 1; second < removable.length; second += 1) {
          relaxations.push({
            indexes: [first, second],
            score: removable[first].reliability + removable[second].reliability + 12,
          });
          for (let third = second + 1; third < removable.length; third += 1) {
            relaxations.push({
              indexes: [first, second, third],
              score: removable[first].reliability + removable[second].reliability
                + removable[third].reliability + 24,
            });
          }
        }
      }
      relaxations.sort((left, right) => left.score - right.score);
      let sourceRelaxedFacelets = 0;
      let sourceSuccesses = 0;
      for (const relaxation of relaxations.slice(0, 520)) {
        if (sourceRelaxedFacelets && relaxation.indexes.length > sourceRelaxedFacelets) break;
        const partial = cloneFacelets(source.facelets);
        relaxation.indexes.forEach((position) => {
          const cell = removable[position];
          partial[cell.face][cell.index] = null;
        });
        if (!pieceEvidenceValid(partial)) continue;
        const inference = inferForcedPieceFacelets(partial);
        if (inference.invalid) continue;
        const completion = completePartialFacelets(inference.facelets, 12);
        if (!completion.complete.length) continue;
        sourceRelaxedFacelets = relaxation.indexes.length;
        if (!relaxedFacelets || sourceRelaxedFacelets < relaxedFacelets) {
          relaxedFacelets = sourceRelaxedFacelets;
          bestObserved = countKnownFacelets(partial) - 6;
          bestObservedPartial = partial;
          bestPartial = cloneFacelets(inference.facelets);
          bestPieceInference = inference;
        }
        const relaxationPenalty = relaxation.score * 0.7;
        completion.complete.forEach((candidate) => storeCompleteState(
          candidate,
          source.score - relaxationPenalty,
          source.relaxed + sourceRelaxedFacelets,
        ));
        sourceSuccesses += 1;
        successfulRelaxations += 1;
        sawTruncation = true;
        if (sourceSuccesses >= 3 || successfulRelaxations >= 36 || validStates.size >= 320) break;
      }
      if (successfulRelaxations >= 36 || validStates.size >= 320) break;
    }
  }
  const rankedCandidates = [...validStates.values()]
    .map((candidate) => ({
      ...candidate,
      evidence: scoreCandidateAgainstObservations(candidate.facelets, observationsByFace, hypothesesByFace),
    }))
    .sort((left, right) => (
      right.evidence.score + right.evidence.supportingCaptures * 1.8 + right.sourceScore * 0.018
      - (left.evidence.score + left.evidence.supportingCaptures * 1.8 + left.sourceScore * 0.018)
    ));
  if (rankedCandidates[0]?.relaxed) relaxedFacelets = rankedCandidates[0].relaxed;
  const candidates = rankedCandidates.map((candidate) => candidate.facelets);
  const candidateConsensus = consensusFacelets(candidates, withCanonicalCenters());
  const completeFacelets = candidates.length === 1 && !sawTruncation ? asComplete(candidates[0]) : null;
  // Anche quando più completamenti differiscono solo nelle caselle mai viste,
  // mostriamo la migliore ricostruzione fisicamente valida. Lo stato resta
  // "partial" finché il video non rende quella scelta univoca, quindi non viene
  // usato silenziosamente come scramble certificato.
  const provisionalDisplay = completeFacelets
    ?? (candidates.length > 1 ? candidateConsensus : candidates[0])
    ?? bestPartial;
  const displayFacelets = cloneFacelets(provisionalDisplay);
  if (!completeFacelets) {
    FACES.forEach((face) => {
      const stableRaw = (hypothesesByFace.get(face) ?? [])
        .filter((observation) => (
          !observation.syntheticFusion
          && observation.visibleCells >= 8
          && (observation.sourceFrames ?? 1) >= 2
          && colorLayoutQuality(observation.colors) >= 0.8
        ))
        .sort((left, right) => (
          right.visibleCells * 20 + (right.sourceFrames ?? 1) * 14 + right.confidence
          - (left.visibleCells * 20 + (left.sourceFrames ?? 1) * 14 + left.confidence)
        ))[0];
      if (!stableRaw) return;
      const alignment = [0, 1, 2, 3].map((turns) => {
        const colors = rotateGrid(stableRaw.colors, turns);
        const confidences = rotateNumbers(stableRaw.cellConfidences, turns);
        let score = 0;
        colors.forEach((color, index) => {
          if (!color || index === 4 || !candidates[0]?.[face][index]) return;
          score += candidates[0][face][index] === color ? 2 : -3;
        });
        return { colors, confidences, score };
      }).sort((left, right) => right.score - left.score)[0];
      if (!alignment) return;
      const minimumCellConfidence = (stableRaw.sourceFrames ?? 1) >= 3 ? 45 : 50;
      alignment.colors.forEach((color, index) => {
        if (!color || index === 4) return;
        if ((alignment.confidences[index] || stableRaw.confidence) < minimumCellConfidence) return;
        const existing = displayFacelets[face][index];
        if (existing === color) return;
        // Ogni faccia viene sovrascritta in modo indipendente con la sua
        // lettura grezza più sicura: senza questo controllo, letture sbagliate
        // ma sicure su facce diverse (es. riflessi che confondono un colore)
        // potrebbero sommarsi superando le 9 caselle fisicamente possibili.
        const counts = colorCounts(displayFacelets);
        if (existing) counts[existing] -= 1;
        if (counts[color] >= 9) return;
        displayFacelets[face][index] = color;
      });
    });
  }
  const inferredFacelets = Math.max(0, countKnownFacelets(displayFacelets) - 6 - bestObserved);
  const cubieResolution = (definitions: PieceDefinition[]) => definitions.filter((position) => {
    const signatures = new Set(candidates.map((candidate) => position.faces.map((face, slot) => (
      candidate[face][position.indices[slot]]
    )).join('-')));
    return signatures.size === 1 && candidates.length > 0;
  }).length;
  const resolvedCorners = Math.max(cubieResolution(CORNERS), bestPieceInference?.resolvedCorners ?? 0);
  const resolvedEdges = Math.max(cubieResolution(EDGES), bestPieceInference?.resolvedEdges ?? 0);
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
      confidence: Math.min(55, baseConfidence), facelets: bestPartial,
      faceCoverage: buildFaceCoverage(bestByFace, bestPartial), completeFacelets: null,
      message: 'Le caselle osservate non formano uno stato fisicamente possibile: serve una nuova lettura dei fotogrammi sfocati o coperti.',
      faceReference: computeFaceReferences(hypothesesByFace, bestPartial),
    };
  }
  if (completeFacelets) {
    return {
      status: 'complete', observedFaces, observedFacelets: bestObserved, inferredFacelets,
      resolvedCorners, resolvedEdges, candidateCount: 1, truncated: false,
      confidence: baseConfidence, facelets: candidates[0],
      faceCoverage: buildFaceCoverage(bestByFace, candidates[0]), completeFacelets,
      message: 'Stato completo e fisicamente valido nella convenzione bianco sopra, verde frontale.',
      faceReference: computeFaceReferences(hypothesesByFace, candidates[0]),
    };
  }
  const displayedFacelets = countKnownFacelets(displayFacelets) - 6;
  const partialMessage = inferredFacelets > 0
    ? candidates.length > 0
      ? `${displayedFacelets === 48 ? 'Schema completo' : `Schema ricostruito (${displayedFacelets}/48 caselle)`}: ${bestObserved} caselle lette dal video e ${inferredFacelets} completate con i vincoli fisici${relaxedFacelets ? `, correggendo ${relaxedFacelets} ${relaxedFacelets === 1 ? 'lettura debole' : 'letture deboli'}` : ''}. La ricostruzione è valida, ma non ancora unica.`
      : `Ho usato lo schema fisso di angoli e spigoli per dedurre ${inferredFacelets} caselle coperte; serve comunque un unico stato fisicamente valido per generare lo scramble.`
    : 'Le caselle viste sono conservate; quelle mancanti vengono dedotte solo quando i vincoli dei pezzi le rendono uniche.';
  const missingDescription = describeMissingFacelets(displayFacelets);
  return {
    status: bestObserved >= 8 ? 'partial' : 'insufficient', observedFaces,
    observedFacelets: bestObserved, inferredFacelets,
    resolvedCorners, resolvedEdges, candidateCount: candidates.length, truncated: sawTruncation,
    confidence: baseConfidence, facelets: displayFacelets,
    faceCoverage: buildFaceCoverage(bestByFace, displayFacelets), completeFacelets: null,
    message: `${sawTruncation && candidates.length === 0
      ? 'La lettura è compatibile con molti stati: servono altre facce o caselle più nitide.'
      : partialMessage}${missingDescription ? ` ${missingDescription}` : ''}`,
    faceReference: computeFaceReferences(hypothesesByFace, displayFacelets),
  };
}

export function faceletsToSolverString(facelets: Record<Face, CubeColor[]>) {
  return FACES.flatMap((face) => facelets[face].map((color) => CANONICAL_COLOR_FACE[color])).join('');
}
