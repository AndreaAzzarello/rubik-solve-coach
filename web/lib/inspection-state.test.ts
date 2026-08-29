import assert from 'node:assert/strict';
import test from 'node:test';
import Cube from 'cubejs';
import { CubeState, invertMoves, movesToString, parseAlgorithm } from './cube.ts';
import {
  CANONICAL_FACE_COLOR,
  CUBIE_COLOR_SCHEMA,
  CUBE_ORIENTATIONS,
  cubeOrientationFromFrontAndUp,
  faceletsToSolverString,
  normalizeObservationOrientations,
  reconstructInspectionState,
  type FaceGridObservation,
} from './inspection-state.ts';
import { createScrambleFromInspection } from './inspection-solver.ts';
import type { CubeColor, Face } from './cube.ts';

const FACES: Face[] = ['U', 'R', 'F', 'D', 'L', 'B'];

function rotate<T>(values: T[], turns: number) {
  let result = [...values];
  for (let turn = 0; turn < turns; turn += 1) {
    const next = Array<T>(9);
    for (let row = 0; row < 3; row += 1) {
      for (let column = 0; column < 3; column += 1) {
        next[column * 3 + (2 - row)] = result[row * 3 + column];
      }
    }
    result = next;
  }
  return result;
}

function observationsFor(cube: CubeState, turns: number[] = []) {
  return FACES.map((face, index): FaceGridObservation => ({
    time: index,
    centerColor: CANONICAL_FACE_COLOR[face],
    colors: rotate(cube.facelets(face), turns[index] ?? 0),
    confidence: 94,
    visibleCells: 9,
  }));
}

function partialObservation(face: Face, known: Partial<Record<number, CubeColor>>) {
  const colors = Array<CubeColor | null>(9).fill(null);
  colors[4] = CANONICAL_FACE_COLOR[face];
  Object.entries(known).forEach(([index, color]) => {
    if (color !== undefined) colors[Number(index)] = color;
  });
  return {
    time: 20,
    centerColor: CANONICAL_FACE_COLOR[face],
    colors,
    confidence: 92,
    visibleCells: Math.max(5, colors.filter(Boolean).length),
    orientationConfidence: 96,
  } satisfies FaceGridObservation;
}

test('espone lo schema colore fisso di ogni pezzo', () => {
  assert.equal(CUBIE_COLOR_SCHEMA.corners.length, 8);
  assert.equal(CUBIE_COLOR_SCHEMA.edges.length, 12);
  assert.ok(CUBIE_COLOR_SCHEMA.corners.some((piece) => (
    piece.name === 'URF' && piece.colors.join('-') === 'white-red-green'
  )));
  assert.ok(CUBIE_COLOR_SCHEMA.corners.some((piece) => (
    piece.name === 'UFL' && piece.colors.join('-') === 'white-green-orange'
  )));
  assert.ok(CUBIE_COLOR_SCHEMA.edges.some((piece) => (
    piece.name === 'FL' && piece.colors.join('-') === 'green-orange'
  )));
});

test('enumera le 24 pose possibili dei centri del cubo', () => {
  assert.equal(CUBE_ORIENTATIONS.length, 24);
  assert.equal(new Set(CUBE_ORIENTATIONS.map((orientation) => (
    `${orientation.front}-${orientation.up}-${orientation.right}-${orientation.down}-${orientation.left}-${orientation.back}`
  ))).size, 24);
  assert.deepEqual(cubeOrientationFromFrontAndUp('green', 'white'), {
    front: 'green',
    up: 'white',
    right: 'red',
    down: 'yellow',
    left: 'orange',
    back: 'blue',
  });
  assert.deepEqual(cubeOrientationFromFrontAndUp('green', 'orange'), {
    front: 'green',
    up: 'orange',
    right: 'white',
    down: 'red',
    left: 'yellow',
    back: 'blue',
  });
  assert.equal(cubeOrientationFromFrontAndUp('green', 'blue'), null);
});

test('orienta una faccia usando il centro adiacente visto nello stesso frame', () => {
  const solved = CubeState.solved();
  const front: FaceGridObservation = {
    time: 12,
    centerColor: 'green',
    colors: rotate(solved.facelets('F'), 1),
    confidence: 90,
    visibleCells: 9,
    imageX: 50,
    imageY: 50,
    rightX: 0,
    rightY: -12,
    downX: 12,
    downY: 0,
  };
  const top: FaceGridObservation = {
    time: 12,
    centerColor: 'white',
    colors: solved.facelets('U'),
    confidence: 88,
    visibleCells: 9,
    imageX: 50,
    imageY: 28,
    rightX: 12,
    rightY: 0,
    downX: 0,
    downY: 12,
  };
  const oriented = normalizeObservationOrientations([front, top]);
  const normalizedFront = oriented.find((observation) => observation.centerColor === 'green');
  assert.ok((normalizedFront?.orientationConfidence ?? 0) >= 58);
  assert.deepEqual(normalizedFront?.colors, solved.facelets('F'));
});

test('deduce lo spigolo mancante usando l’inventario fisso dei pezzi', () => {
  const reconstruction = reconstructInspectionState([
    partialObservation('F', { 0: 'green', 1: 'green', 3: 'green', 5: 'green', 7: 'green' }),
    partialObservation('U', { 7: 'white' }),
    partialObservation('R', { 3: 'red' }),
    partialObservation('D', { 1: 'yellow' }),
  ]);
  assert.equal(reconstruction.status, 'partial');
  assert.equal(reconstruction.facelets.L[5], 'orange');
  assert.ok(reconstruction.inferredFacelets >= 1);
  assert.ok(reconstruction.resolvedEdges >= 4);
});

test('ricostruisce lo stato risolto nella convenzione bianco U e verde F', () => {
  const reconstruction = reconstructInspectionState(observationsFor(CubeState.solved(), [0, 1, 2, 3, 0, 1]));
  assert.equal(reconstruction.status, 'complete');
  assert.equal(reconstruction.observedFacelets, 48);
  assert.equal(reconstruction.inferredFacelets, 0);
  assert.ok(reconstruction.completeFacelets);
  assert.equal(faceletsToSolverString(reconstruction.completeFacelets), 'U'.repeat(9) + 'R'.repeat(9) + 'F'.repeat(9) + 'D'.repeat(9) + 'L'.repeat(9) + 'B'.repeat(9));
});

test('ricostruisce uno scramble valido anche se ogni faccia appare ruotata nel video', () => {
  const scrambled = CubeState.solved().applyMoves(parseAlgorithm("R U F2 L' D B2 U' R2"));
  const reconstruction = reconstructInspectionState(observationsFor(scrambled, [3, 1, 0, 2, 1, 3]));
  assert.equal(reconstruction.status, 'complete');
  assert.ok(reconstruction.completeFacelets);
  assert.equal(faceletsToSolverString(reconstruction.completeFacelets), scrambled.faceletString());
  assert.equal(reconstruction.resolvedCorners, 8);
  assert.equal(reconstruction.resolvedEdges, 12);
});

test('fonde più fotogrammi della stessa faccia senza inventare caselle', () => {
  const cube = CubeState.solved().applyMoves(parseAlgorithm('R U F'));
  const complete = observationsFor(cube);
  const first = complete[0];
  const leftHalf = first.colors.map((color, index) => ([0, 1, 3, 4, 6, 7].includes(index) ? color : null));
  const rightHalf = rotate(first.colors, 1).map((color, index) => ([0, 1, 2, 4, 5, 8].includes(index) ? color : null));
  const split: FaceGridObservation[] = [
    { ...first, colors: leftHalf, visibleCells: leftHalf.filter(Boolean).length },
    { ...first, time: 0.2, colors: rightHalf, visibleCells: rightHalf.filter(Boolean).length },
    ...complete.slice(1),
  ];
  const reconstruction = reconstructInspectionState(split);
  assert.equal(reconstruction.status, 'complete');
  assert.ok(reconstruction.completeFacelets);
  assert.equal(faceletsToSolverString(reconstruction.completeFacelets), cube.faceletString());
});

test('con poche caselle conserva lo stato come ambiguo', () => {
  const observation = observationsFor(CubeState.solved())[0];
  const partial = { ...observation, colors: observation.colors.map((color, index) => (index <= 5 ? color : null)), visibleCells: 6 };
  const reconstruction = reconstructInspectionState([partial]);
  assert.equal(reconstruction.status, 'insufficient');
  assert.equal(reconstruction.completeFacelets, null);
  assert.equal(reconstruction.observedFacelets, 5);
  assert.equal(reconstruction.faceCoverage.U.status, 'partial');
  assert.equal(reconstruction.faceCoverage.U.observedCells, 6);
});

test('più fotogrammi multi-faccia concordi prevalgono su una lettura isolata errata', () => {
  const cube = CubeState.solved().applyMoves(parseAlgorithm("R U F2 L' D"));
  const complete = observationsFor(cube);
  const correctU = complete[0];
  const wrongColors = [...correctU.colors];
  wrongColors[0] = wrongColors[0] === 'red' ? 'blue' : 'red';
  const observations: FaceGridObservation[] = [
    { ...correctU, time: 0.1, confidence: 91, bundleSize: 3 },
    { ...correctU, time: 0.3, confidence: 90, bundleSize: 3 },
    { ...correctU, time: 0.5, confidence: 89, bundleSize: 2 },
    { ...correctU, colors: wrongColors, time: 0.2, confidence: 96, bundleSize: 1 },
    ...complete.slice(1).map((observation, index) => ({ ...observation, time: index + 1, bundleSize: 2 })),
  ];
  const reconstruction = reconstructInspectionState(observations);
  assert.equal(reconstruction.status, 'complete');
  assert.ok(reconstruction.completeFacelets);
  assert.equal(faceletsToSolverString(reconstruction.completeFacelets), cube.faceletString());
  assert.ok(reconstruction.faceCoverage.U.evidenceFrames >= 3);
  const reversed = reconstructInspectionState([...observations].reverse());
  assert.deepEqual(reversed.facelets, reconstruction.facelets);
});

test('completa lo schema senza lasciare caselle vuote quando una lettura debole è incompatibile', () => {
  const observations = observationsFor(CubeState.solved());
  const noisy = observations.map((observation) => ({
    ...observation,
    cellConfidences: observation.colors.map(() => 94),
  }));
  noisy[5].colors = [...noisy[5].colors];
  noisy[5].colors[0] = 'red';
  noisy[5].cellConfidences![0] = 38;

  const reconstruction = reconstructInspectionState(noisy);
  const displayed = FACES.flatMap((face) => reconstruction.facelets[face]);
  assert.equal(reconstruction.status, 'partial');
  assert.equal(reconstruction.completeFacelets, null);
  assert.equal(displayed.filter(Boolean).length, 54);
  assert.ok(reconstruction.candidateCount >= 1);
  assert.match(reconstruction.message, /correggendo 1 lettura debole/);
});

test('lo scramble prodotto dal solver riproduce esattamente lo stato ricostruito', () => {
  const scrambled = CubeState.solved().applyMoves(parseAlgorithm('R U F2 L2 D B2 U2 R2'));
  Cube.initSolver();
  const solution = Cube.fromString(scrambled.faceletString()).solve();
  const scramble = movesToString(invertMoves(parseAlgorithm(solution)));
  const replayed = CubeState.solved().applyMoves(parseAlgorithm(scramble));
  assert.equal(replayed.faceletString(), scrambled.faceletString());
});

test('la ricerca multipla restituisce il candidato verificato più breve', async () => {
  const scrambled = CubeState.solved().applyMoves(parseAlgorithm('R U F2 L2 D B2 U2 R2'));
  const result = await createScrambleFromInspection(scrambled.faceletRecord());
  assert.equal(result.verified, true);
  assert.ok(result.candidatesTested > 1);
  assert.equal(parseAlgorithm(result.scramble).length, result.moveCount);
  assert.equal(
    CubeState.solved().applyMoves(parseAlgorithm(result.scramble)).faceletString(),
    scrambled.faceletString(),
  );
});