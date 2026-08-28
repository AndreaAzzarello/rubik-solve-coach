import assert from 'node:assert/strict';
import test from 'node:test';
import type { CubeColor } from './cube.ts';
import type { FaceGridObservation } from './inspection-state.ts';
import {
  buildInspectionSampleTimes,
  detectFaceGrids,
  inferInspectionEnd,
  lastInspectionFrameTime,
  selectInspectionKeyframes,
  summarizeCubeObservation,
  type MotionSample,
  type MotionEvent,
  type ObservedColorCoverage,
} from './video-decoder.ts';

const COLORS: CubeColor[] = ['white', 'red', 'green', 'yellow', 'orange', 'blue'];

function coverage(...visible: CubeColor[]): ObservedColorCoverage {
  return Object.fromEntries(COLORS.map((color) => [color, visible.includes(color) ? 0.16 : 0])) as ObservedColorCoverage;
}

function grid(time: number, centerColor: CubeColor, accent: CubeColor, bundleSize = 1): FaceGridObservation {
  return {
    time,
    centerColor,
    colors: [accent, centerColor, accent, centerColor, centerColor, accent, accent, centerColor, accent],
    cellConfidences: Array(9).fill(90),
    confidence: 92,
    visibleCells: 9,
    bundleSize,
  };
}

function sample(
  time: number,
  centerColor: CubeColor,
  options: { difference?: number; sharpness?: number; reference?: boolean; secondFace?: CubeColor } = {},
): MotionSample {
  const faceGrids = [grid(time, centerColor, 'yellow', options.secondFace ? 2 : 1)];
  if (options.secondFace) faceGrids.push(grid(time, options.secondFace, 'red', 2));
  return {
    time,
    difference: options.difference ?? 14,
    cubeDifference: options.difference ?? 14,
    sharpness: options.sharpness ?? 24,
    hasTemporalReference: options.reference ?? true,
    visibleColors: coverage(centerColor, ...(options.secondFace ? [options.secondFace] : [])),
    faceGrids,
  };
}

test('conserva viste nitide lungo tutta l’ispezione anche mentre il cubo si muove', () => {
  const samples = [
    sample(0, 'white', { difference: 0, reference: false, sharpness: 22 }),
    sample(1.1, 'red', { difference: 10, secondFace: 'green' }),
    sample(2.2, 'green', { difference: 12 }),
    sample(3.3, 'yellow', { difference: 14, secondFace: 'orange' }),
    sample(5.1, 'orange', { difference: 16 }),
    sample(7.4, 'blue', { difference: 18, secondFace: 'white' }),
    sample(9.2, 'red', { difference: 20, secondFace: 'blue' }),
  ];

  const keyframes = selectInspectionKeyframes(samples);
  assert.ok(keyframes.some((keyframe) => keyframe.time >= 7.4));
  assert.ok(new Set(keyframes.flatMap((keyframe) => keyframe.faceColors)).size >= 5);
  assert.ok(keyframes.length > 1);

  const summary = summarizeCubeObservation(samples, 0, 10);
  assert.equal(summary.stableFrames, 3);
  assert.ok(summary.sharpFrames >= 6);
  assert.ok(summary.keyframes.some((keyframe) => keyframe.time > 5));
});

test('preferisce il fotogramma nitido nello stesso tratto temporale', () => {
  const samples = [
    sample(2.02, 'white', { sharpness: 2, difference: 1 }),
    sample(2.24, 'green', { sharpness: 31, difference: 18, secondFace: 'red' }),
    sample(3.1, 'yellow', { sharpness: 24 }),
    sample(4.1, 'orange', { sharpness: 25 }),
    sample(5.1, 'blue', { sharpness: 26 }),
  ];

  const keyframes = selectInspectionKeyframes(samples);
  assert.ok(keyframes.some((keyframe) => Math.abs(keyframe.time - 2.24) < 0.01));
  assert.ok(!keyframes.some((keyframe) => Math.abs(keyframe.time - 2.02) < 0.01));
});

test('ferma l’ispezione esattamente un fotogramma prima della prima mossa', () => {
  assert.ok(Math.abs(lastInspectionFrameTime(0, 10, 60) - (10 - 1 / 60)) < 0.000001);
  assert.equal(lastInspectionFrameTime(4, 4.01, 60), 4);
});

test('campiona automaticamente tutta l’ispezione senza oltrepassare il limite', () => {
  const firstPass = buildInspectionSampleTimes(0, 9.9833, 0);
  const secondPass = buildInspectionSampleTimes(0, 9.9833, 1);
  const thirdPass = buildInspectionSampleTimes(0, 9.9833, 2);
  assert.ok(firstPass.length >= 40);
  assert.ok(Math.max(...firstPass) <= 9.9833);
  assert.ok(Math.max(...secondPass) <= 9.9833);
  assert.notEqual(firstPass[0], secondPass[0]);
  assert.notEqual(firstPass[0], thirdPass[0]);
  assert.notEqual(secondPass[0], thirdPass[0]);
});

function rotatePattern(values: Array<CubeColor | null>) {
  const rotated = Array<CubeColor | null>(9).fill(null);
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      rotated[column * 3 + (2 - row)] = values[row * 3 + column];
    }
  }
  return rotated;
}

function patternSample(time: number, colors: Array<CubeColor | null>, crop = 0): MotionSample {
  const captureId = time.toFixed(4);
  return {
    time,
    difference: 0,
    cubeDifference: 0,
    sharpness: 30,
    visibleColors: coverage(...COLORS),
    faceGrids: [{
      time,
      frameId: `${captureId}:crop-${crop}`,
      captureId,
      centerColor: 'white',
      colors,
      cellConfidences: Array(9).fill(92),
      confidence: 92,
      visibleCells: colors.filter(Boolean).length,
      bundleSize: 1,
    }],
  };
}

function motionEvent(
  start: number,
  motionKind: MotionEvent['motionKind'],
  id: number,
): MotionEvent {
  return {
    id,
    start,
    end: start + 0.18,
    peakTime: start + 0.09,
    peakDifference: 20,
    confidence: 88,
    motionKind,
    evidence: 'cube',
    cubeStrength: 84,
    handStrength: 20,
    dominantHand: 'unknown',
    handDirection: 'mixed',
    candidateMove: motionKind === 'face-turn' ? 'R' : 'x',
    candidateConfidence: 70,
    candidateAlternatives: [],
    candidateMoves: [motionKind === 'face-turn' ? 'R' : 'x'],
    internalPeakTimes: [start + 0.09],
    moveCountEstimate: 1,
  };
}

test('le rotazioni x/y/z non chiudono l’ispezione, il primo cambio del pattern sì', () => {
  const initial: Array<CubeColor | null> = [
    'red', 'green', 'blue',
    'orange', 'white', 'yellow',
    'green', 'orange', 'red',
  ];
  const changed = [...initial];
  changed[0] = 'yellow';
  changed[1] = 'red';
  changed[2] = 'orange';
  const samples = [
    patternSample(1, initial),
    patternSample(2.2, rotatePattern(initial)),
    patternSample(4, rotatePattern(rotatePattern(initial))),
    patternSample(10, changed, 0),
    patternSample(10, changed, 1),
  ];
  const boundary = inferInspectionEnd(samples, [motionEvent(9.91, 'face-turn', 1)], 0, 14, 0.6);
  assert.equal(boundary.source, 'state-change');
  assert.ok(boundary.time >= 9.9 && boundary.time <= 10);
});

test('usa una raffica di face turn come fallback senza confonderla con rotazioni globali', () => {
  const events = [
    motionEvent(1.2, 'global-motion', 1),
    motionEvent(2.2, 'global-motion', 2),
    motionEvent(3.2, 'global-motion', 3),
    motionEvent(8, 'face-turn', 4),
    motionEvent(8.45, 'face-turn', 5),
    motionEvent(8.9, 'face-turn', 6),
  ];
  const boundary = inferInspectionEnd([], events, 0, 14, 0.5);
  assert.equal(boundary.source, 'motion-density');
  assert.equal(boundary.time, 8);
});

test('trova una griglia grande anche quando molti frammenti piccoli falsano la mediana globale', () => {
  const width = 120;
  const height = 120;
  const labels = new Int8Array(width * height);
  labels.fill(-1);
  const paint = (left: number, top: number, size: number, color: number) => {
    for (let y = top; y < top + size; y += 1) {
      for (let x = left; x < left + size; x += 1) labels[y * width + x] = color;
    }
  };
  const gridColors = [1, 2, 5, 4, 0, 3, 2, 4, 1];
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      paint(30 + column * 17, 30 + row * 17, 12, gridColors[row * 3 + column]);
    }
  }
  for (let index = 0; index < 42; index += 1) {
    paint(2 + (index % 14) * 8, 84 + Math.floor(index / 14) * 8, 2, index % 6);
  }
  const grids = detectFaceGrids(labels, width, height);
  assert.ok(grids.some((candidate) => candidate.centerColor === 'white' && candidate.visibleCells === 9));
});
