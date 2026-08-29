import assert from 'node:assert/strict';
import test from 'node:test';
import { CubeState, parseAlgorithm } from './cube.ts';
import type { SolveTranscript, TranscriptSegment, TranscriptStage } from './solve-transcription.ts';
import { buildVirtualReplay } from './virtual-replay.ts';

function segment(stage: TranscriptStage, label: string, tokens: string[]): TranscriptSegment {
  return {
    stage,
    label,
    confidence: 86,
    inferredBoundary: false,
    moves: tokens.map((token, index) => ({
      token,
      time: index * 0.2,
      confidence: 86,
      runSupport: 2,
      kind: stage === 'inspection' ? 'global-motion' : 'face-turn',
      alternatives: [],
    })),
  };
}

function transcript(segments: TranscriptSegment[]): SolveTranscript {
  const consensusMoves = segments.flatMap((entry) => entry.moves);
  return {
    segments,
    consensusMoves,
    moveCount: consensusMoves.length,
    confidence: 86,
    uncertainMoves: 0,
    runCount: 2,
    usedStateProgress: true,
  };
}

test('deriva lo stato iniziale e termina risolto riproducendo tutte le mosse', () => {
  const input = transcript([
    segment('inspection', 'Inspection', ["x'"]),
    segment('cross', 'Cross', ['R', "U'", "R'"]),
    segment('pll', 'PLL', ['U']),
  ]);
  const replay = buildVirtualReplay(input, null);

  assert.ok(replay);
  assert.equal(replay.derivedInitialState, true);
  assert.equal(replay.frames.length, replay.moves.length + 1);
  assert.equal(replay.moves[0].stage, 'inspection');
  assert.equal(replay.finalSolved, true);
});

test('usa lo stato iniziale ricostruito senza includere le mosse dello scramble', () => {
  const initialCube = CubeState.solved().applyMoves(parseAlgorithm("F R U'"));
  const input = transcript([
    segment('scramble', 'Scramble', ['F', 'R', "U'"]),
    segment('cross', 'Cross', ['U']),
  ]);
  const replay = buildVirtualReplay(input, initialCube.faceletRecord());

  assert.ok(replay);
  assert.equal(replay.derivedInitialState, false);
  assert.deepEqual(replay.moves.map((move) => move.token), ['U']);
  assert.equal(replay.frames.length, 2);
  assert.notDeepEqual(replay.frames[0], replay.frames[1]);
});
