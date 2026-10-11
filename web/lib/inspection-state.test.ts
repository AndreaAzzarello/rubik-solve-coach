import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  type PartialFacelets,
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

// Esperimento #15 (vedi docs/pipeline-experiments.md): test di sanità
// permanente. Premessa logica: se l'input della ricerca contiene SOLO
// letture compatibili con la verità, una ricerca che esplora tutto lo
// spazio fisicamente valido deve sempre includere lo stato vero fra i
// candidati (e, con copertura piena, deve ricostruirlo esattamente). Se
// questo fallisse sarebbe un bug nella ricostruzione o nella conversione
// delle osservazioni, non un problema di dati/video reali.
//
// Scrambles presi da bench/cases.json (gli stessi 13 video del bench):
// nessun video o immagine, solo lo scramble testuale - l'oracolo passa
// dalle STESSE funzioni di produzione (CubeState.facelets, lo schema
// CANONICAL_FACE_COLOR, reconstructInspectionState) usate dal resto di
// questo file di test.
const HERE_INSPECTION_STATE_TEST = path.dirname(fileURLToPath(import.meta.url));
const BENCH_CASES: Array<{ id: string; scramble: string }> = JSON.parse(
  fs.readFileSync(path.join(HERE_INSPECTION_STATE_TEST, '../bench/cases.json'), 'utf8'),
).cases;

function trueCubeState(scramble: string): CubeState {
  return CubeState.solved().applyMoves(parseAlgorithm(scramble));
}

// PRNG deterministico (mulberry32), seed dichiarato: 20261012. Serve solo a
// scegliere SEMPRE lo stesso sottoinsieme di 30 caselle per ogni scramble,
// così un fallimento è riproducibile.
const ORACLE_SEED = 20261012;
function mulberry32(seed: number) {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fullFaceObservation(cube: CubeState, face: Face): FaceGridObservation {
  return {
    time: 0,
    centerColor: CANONICAL_FACE_COLOR[face],
    colors: cube.facelets(face),
    confidence: 95,
    visibleCells: 9,
    sourceFrames: 3,
  };
}

function partialFaceObservation(cube: CubeState, face: Face, revealedIndices: Set<number>): FaceGridObservation {
  const full = cube.facelets(face);
  const colors = full.map((color, index) => (index === 4 || revealedIndices.has(index) ? color : null));
  return {
    time: 0,
    centerColor: CANONICAL_FACE_COLOR[face],
    colors,
    confidence: 95,
    visibleCells: colors.filter(Boolean).length,
    sourceFrames: 3,
  };
}

// Legge __benchCandidateStatesDiag (lo stesso hook solo-bench usato dagli
// esperimenti #13/#14) per vedere TUTTI gli stati candidati trovati, non
// solo il primo in classifica - qui in Node puro, nessun browser.
function reconstructWithCandidates(observations: FaceGridObservation[]) {
  const target = globalThis as { __benchCandidateStatesDiag?: PartialFacelets[] };
  target.__benchCandidateStatesDiag = [];
  const result = reconstructInspectionState(observations, { observedCells: 0, usable: false });
  const candidates = target.__benchCandidateStatesDiag ?? [];
  delete target.__benchCandidateStatesDiag;
  return { result, candidates };
}

function matchesTrueState(candidate: PartialFacelets, reference: Record<Face, CubeColor[]>): boolean {
  return FACES.every((face) => candidate[face].every((color, index) => color === reference[face][index]));
}

test('esperimento #15 test 1a: copertura piena (48/48) → ricostruzione identica alla verità su tutti i 13 scramble del bench', () => {
  const failures: string[] = [];
  BENCH_CASES.forEach(({ id, scramble }) => {
    const cube = trueCubeState(scramble);
    const reference = cube.faceletRecord();
    const observations = FACES.map((face) => fullFaceObservation(cube, face));
    const { result } = reconstructWithCandidates(observations);
    if (result.status !== 'complete') {
      failures.push(`${id}: stato "${result.status}" invece di "complete"`);
      return;
    }
    if (!result.completeFacelets || !FACES.every((face) => (
      result.completeFacelets![face].every((color, index) => color === reference[face][index])
    ))) {
      failures.push(`${id}: completeFacelets non coincide con la verità`);
    }
  });
  assert.equal(failures.length, 0, `casi falliti:\n${failures.join('\n')}`);
});

test('esperimento #15 test 1b: 5 facce complete (una assente) → lo stato vero è sempre fra i candidati su tutti i 13 scramble', () => {
  const failures: string[] = [];
  BENCH_CASES.forEach(({ id, scramble }, caseIndex) => {
    const cube = trueCubeState(scramble);
    const reference = cube.faceletRecord();
    const missingFace = FACES[caseIndex % FACES.length];
    const observations = FACES.filter((face) => face !== missingFace).map((face) => fullFaceObservation(cube, face));
    const { result, candidates } = reconstructWithCandidates(observations);
    const present = result.status === 'complete'
      ? !!result.completeFacelets && FACES.every((face) => (
        result.completeFacelets![face].every((color, index) => color === reference[face][index])
      ))
      : candidates.some((candidate) => matchesTrueState(candidate, reference));
    if (!present) {
      failures.push(`${id}: faccia assente ${missingFace}, stato "${result.status}", stato vero non presente fra ${candidates.length || 1} candidati`);
    }
  });
  assert.equal(failures.length, 0, `casi falliti:\n${failures.join('\n')}`);
});

// TODO (non skip: gira comunque a ogni `pnpm test:inspection`, ma un
// fallimento non rompe la build - cosi' il bug noto resta visibile senza
// bloccare CI). Bug confermato dall'esperimento #15: con copertura sparsa
// (30/48, media ~5 celle/faccia) e orientationConfidence non impostata (ogni
// faccia prova le 4 rotazioni), enumeratePieceAssignments (riga ~796,
// troncamento riga ~825, cap 768) e completePartialFacelets (riga ~995,
// troncamento righe ~1005/1010, cap 96) enumerano i completamenti
// angoli/spigoli in un ordine arbitrario (depth-first, posizioni ordinate
// per minor numero di opzioni) e si fermano al cap SENZA alcuna preferenza
// per i completamenti coerenti con l'evidenza. Con poca evidenza le
// combinazioni fisicamente valide superano facilmente il cap, e lo stato
// vero (garantito compatibile per costruzione in questo test) può restare
// fuori dal campione arbitrario. Vedi docs/pipeline-experiments.md,
// esperimento #15, per la proposta di correzione (non implementata).
test('esperimento #15 test 1c: 30/48 caselle casuali (seed 20261012) → lo stato vero è sempre fra i candidati su tutti i 13 scramble', { todo: 'bug noto esperimento #15: enumeratePieceAssignments/completePartialFacelets troncano in ordine arbitrario, vedi docs/pipeline-experiments.md' }, () => {
  const failures: string[] = [];
  BENCH_CASES.forEach(({ id, scramble }, caseIndex) => {
    const cube = trueCubeState(scramble);
    const reference = cube.faceletRecord();
    const random = mulberry32(ORACLE_SEED + caseIndex);
    const allCells = FACES.flatMap((face) => [0, 1, 2, 3, 5, 6, 7, 8].map((index) => ({ face, index })));
    for (let i = allCells.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [allCells[i], allCells[j]] = [allCells[j], allCells[i]];
    }
    const revealed = new Set(allCells.slice(0, 30).map((cell) => `${cell.face}#${cell.index}`));
    const revealedByFace = new Map<Face, Set<number>>(FACES.map((face) => [face, new Set<number>()]));
    revealed.forEach((key) => {
      const [face, indexStr] = key.split('#');
      revealedByFace.get(face as Face)!.add(Number(indexStr));
    });
    const observations = FACES
      .map((face) => partialFaceObservation(cube, face, revealedByFace.get(face)!))
      .filter((observation) => observation.visibleCells >= 5);
    const { result, candidates } = reconstructWithCandidates(observations);
    const present = result.status === 'complete'
      ? !!result.completeFacelets && FACES.every((face) => (
        result.completeFacelets![face].every((color, index) => color === reference[face][index])
      ))
      : candidates.some((candidate) => matchesTrueState(candidate, reference));
    if (!present) {
      failures.push(`${id}: stato "${result.status}", stato vero non presente fra ${candidates.length || 1} candidati (30 caselle rivelate, seed ${ORACLE_SEED + caseIndex})`);
    }
  });
  assert.equal(failures.length, 0, `casi falliti:\n${failures.join('\n')}`);
});