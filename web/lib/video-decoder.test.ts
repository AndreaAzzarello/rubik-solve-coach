import assert from 'node:assert/strict';
import test from 'node:test';
import type { CubeColor } from './cube.ts';
import type { FaceGridObservation } from './inspection-state.ts';
import {
  selectInspectionKeyframes,
  summarizeCubeObservation,
  type MotionSample,
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
