import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CUBE_COLORS,
  CUBE_FACES,
  CANONICAL_FACE_COLOR,
  CubeState,
  parseAlgorithm,
  type CubeColor,
  type Face,
} from '../lib/cube.ts';
import {
  referenceFromScramble,
  scoreReconstruction,
  type CompleteFaceletMap,
  type FaceletMap,
} from './lib/score.ts';

const SCRAMBLE = "F L2 B2 D F2 D' U' B2 D' F2 L2 D2 R2 B' D' F R U' F2 U";

function solvedFacelets(): CompleteFaceletMap {
  return Object.fromEntries(
    CUBE_FACES.map((face) => [face, Array<CubeColor>(9).fill(CANONICAL_FACE_COLOR[face])]),
  ) as CompleteFaceletMap;
}

function toPartial(map: CompleteFaceletMap): FaceletMap {
  return Object.fromEntries(CUBE_FACES.map((face) => [face, [...map[face]]])) as FaceletMap;
}

test('un cubo identico allo stato reale ottiene 54/54', () => {
  const reference = referenceFromScramble(SCRAMBLE);
  const score = scoreReconstruction({
    facelets: toPartial(reference),
    completeFacelets: reference,
    status: 'complete',
    scramble: SCRAMBLE,
  });
  assert.equal(score.correct, 54);
  assert.equal(score.correctNonCenter, 48);
  assert.equal(score.committedNonCenter, 48);
  assert.equal(score.accuracyOnCommitted, 1);
  assert.equal(score.orientation.bestCorrect, 54);
  assert.equal(score.orientation.systematicOffsetSuspected, false);
});

test('i centri contano ma non gonfiano il segnale: cubo risolto vs scramble', () => {
  const score = scoreReconstruction({
    facelets: toPartial(solvedFacelets()),
    completeFacelets: solvedFacelets(),
    status: 'complete',
    scramble: SCRAMBLE,
  });
  // I 6 centri combaciano sempre (correct - correctNonCenter === 6). Uno stato
  // risolto contro uno scramble vero resta comunque molto lontano.
  assert.equal(score.correct - score.correctNonCenter, 6);
  assert.ok(score.correct < 24, `atteso << 24, ottenuto ${score.correct}`);
  assert.equal(score.committed, 54);
  // Istogramma perfetto (9 per colore) anche se lo stato e' del tutto sbagliato:
  // e' proprio il caso che l'istogramma da solo non sa distinguere.
  for (const color of Object.keys(score.histogramExpected)) {
    if (color === 'unknown') continue;
    assert.equal(score.histogramDelta[color], 0);
  }
});

test('le caselle non lette (null) non contano ne\' giuste ne\' sbagliate', () => {
  const reference = referenceFromScramble(SCRAMBLE);
  const partial = toPartial(reference);
  // Cancella 20 caselle non centrali.
  let removed = 0;
  for (const face of CUBE_FACES) {
    for (let i = 0; i < 9 && removed < 20; i += 1) {
      if (i === 4) continue;
      partial[face][i] = null;
      removed += 1;
    }
  }
  const score = scoreReconstruction({
    facelets: partial,
    completeFacelets: null,
    status: 'partial',
    scramble: SCRAMBLE,
  });
  assert.equal(score.correct, 34); // 54 - 20
  assert.equal(score.committedNonCenter, 28); // 48 - 20
  assert.equal(score.correctNonCenter, 28);
  assert.equal(score.accuracyOnCommitted, 1);
  // la diagnosi orientamento funziona anche su stato parziale (sulle celle lette)
  assert.equal(score.orientation.available, true);
  assert.equal(score.orientation.identityCorrect, 34);
  assert.equal(score.orientation.bestRotation, '(identita)');
  assert.equal(score.orientation.systematicOffsetSuspected, false);
});

test('rileva un offset di orientamento sistematico (tutto il cubo ruotato di y)', () => {
  const reference = referenceFromScramble(SCRAMBLE);
  // Stato fisicamente corretto ma "letto" con il cubo ruotato di y: identita' bassa,
  // una singola rotazione di cubo intero recupera tutto.
  const rotated = CubeState.fromFacelets(reference).applyMoves(parseAlgorithm('y')).faceletRecord();
  const score = scoreReconstruction({
    facelets: toPartial(rotated),
    completeFacelets: rotated,
    status: 'complete',
    scramble: SCRAMBLE,
  });
  assert.ok(score.correct < 30, `identita' dovrebbe essere bassa, e' ${score.correct}`);
  assert.equal(score.orientation.bestCorrect, 54);
  assert.equal(score.orientation.systematicOffsetSuspected, true);
  assert.notEqual(score.orientation.bestRotation, '(identita)');
});

test('errori sparsi non vengono scambiati per offset sistematico', () => {
  const reference = referenceFromScramble(SCRAMBLE);
  const noisy = toPartial(reference);
  // 8 alterazioni locali sparse, ciascuna garantita diversa dal valore reale:
  // nessuna rotazione di cubo intero le annulla.
  const spots: Array<[Face, number]> = [
    ['U', 0], ['R', 1], ['F', 2], ['D', 3], ['L', 5], ['B', 6], ['U', 7], ['F', 8],
  ];
  for (const [face, index] of spots) {
    const expected = reference[face][index];
    noisy[face][index] = CUBE_COLORS.find((color) => color !== expected)!;
  }
  const score = scoreReconstruction({
    facelets: noisy,
    completeFacelets: null,
    status: 'partial',
    scramble: SCRAMBLE,
  });
  assert.equal(score.correct, 46); // 54 - 8
  assert.equal(score.orientation.systematicOffsetSuspected, false);
});
