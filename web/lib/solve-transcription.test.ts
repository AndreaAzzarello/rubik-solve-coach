import assert from 'node:assert/strict';
import test from 'node:test';
import { CubeState, invertMoves, parseAlgorithm, type CubeColor, type Face } from './cube.ts';
import { buildSolveTranscript, formatTranscript, mergeMotionEventRuns } from './solve-transcription.ts';
import type { MotionEvent, SolveWindow } from './video-decoder.ts';

function event(id: number, time: number, token: string, confidence = 72): MotionEvent {
  const global = /^[xyz]/.test(token);
  return {
    id, start: time - 0.08, end: time + 0.08, peakTime: time, peakDifference: 20,
    confidence: 82, motionKind: global ? 'global-motion' : 'face-turn', evidence: 'combined',
    cubeStrength: 80, handStrength: 74, dominantHand: 'right', handDirection: 'right',
    candidateMove: token, candidateConfidence: confidence, candidateAlternatives: [],
    candidateMoves: [token], internalPeakTimes: [time], moveCountEstimate: 1,
  };
}

test('sovrappone più analisi e sceglie la mossa sostenuta dalla maggioranza', () => {
  const merged = mergeMotionEventRuns([
    [event(1, 1, 'R'), event(2, 2, "U'")],
    [event(1, 1.04, 'R'), event(2, 2.03, 'U')],
    [event(1, 0.98, 'R'), event(2, 1.97, "U'")],
  ]);
  assert.deepEqual(merged.map((move) => move.token), ['R', "U'"]);
  assert.equal(merged[0].runSupport, 3);
});

test('produce un output leggibile senza punti interrogativi e con fasi separate', () => {
  const tokens = ['x', 'R', 'U', "R'", "U'"];
  const solveMoves = parseAlgorithm(tokens.slice(1).join(' '));
  const initial = CubeState.solved().applyMoves(invertMoves(solveMoves)).faceletRecord() as Record<Face, CubeColor[]>;
  const window: SolveWindow = {
    id: 1, start: 2, end: 5.5, eventIds: [2, 3, 4, 5], confidence: 80,
    startState: 'scrambled-likely',
    stages: [
      { kind: 'inspection', start: 0, end: 2, eventIds: [1] },
      { kind: 'solve', start: 2, end: 5.5, eventIds: [2, 3, 4, 5] },
    ],
  };
  const transcript = buildSolveTranscript([tokens.map((token, index) => event(index + 1, index + 1, token))], window, initial, 'white');
  const output = formatTranscript(transcript, "F R U R'");
  assert.match(output, /\/\/Scramble/);
  assert.match(output, /x \/\/Inspection/);
  assert.doesNotMatch(output, /\?/);
  assert.ok(transcript.moveCount >= 3);
});
