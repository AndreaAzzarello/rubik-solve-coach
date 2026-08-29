import assert from 'node:assert/strict';
import test from 'node:test';
import type { CubeColor, Face } from './cube.ts';
import {
  buildColorCalibration,
  buildInitialColorCalibration,
  classifyBalancedCubeFacelets,
  classifyCalibratedColor,
  classifyGuidedCaptures,
  createAdaptiveColorClassifier,
  sampleCentralRoiRgb,
  validateCubeColorDistribution,
  type GuidedFaceCapture,
  type RgbSample,
} from './color-calibration.ts';

const COLORS: Record<CubeColor, RgbSample> = {
  white: { red: 220, green: 225, blue: 232 },
  red: { red: 205, green: 42, blue: 48 },
  green: { red: 30, green: 166, blue: 82 },
  yellow: { red: 226, green: 181, blue: 25 },
  orange: { red: 229, green: 103, blue: 24 },
  blue: { red: 42, green: 91, blue: 197 },
};

test('usa i sei centri come profili colore della sessione', () => {
  const calibration = buildColorCalibration(Object.entries(COLORS).map(([color, sample]) => ({
    color: color as CubeColor,
    sample,
  })));
  Object.entries(COLORS).forEach(([color, sample]) => {
    const shifted = { red: sample.red * 0.94, green: sample.green * 0.96, blue: sample.blue * 0.92 };
    assert.equal(classifyCalibratedColor(shifted, calibration).color, color);
  });
});

test('riclassifica tutte le facce dopo aver acquisito l’ultimo centro', () => {
  const faces: Array<[Face, CubeColor]> = [
    ['U', 'white'], ['R', 'red'], ['F', 'green'], ['D', 'yellow'], ['L', 'orange'], ['B', 'blue'],
  ];
  const captures: GuidedFaceCapture[] = faces.map(([face, centerColor], faceIndex) => ({
    face,
    centerColor,
    cells: Array.from({ length: 9 }, (_, index) => COLORS[index === 4 ? centerColor : faces[(faceIndex + index) % faces.length][1]]),
    quality: 0.9,
    capturedAt: faceIndex,
  }));
  const classified = classifyGuidedCaptures(captures);
  faces.forEach(([face, centerColor]) => {
    assert.equal(classified.facelets[face][4], centerColor);
    assert.equal(classified.facelets[face].filter(Boolean).length, 9);
  });
  assert.equal(classified.validation.valid, true);
});

test('campiona solo il 25% centrale della ROI ignorando il bordo', () => {
  const width = 8;
  const height = 8;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const central = x >= 2 && x <= 5 && y >= 2 && y <= 5;
      pixels[offset] = central ? 28 : 225;
      pixels[offset + 1] = central ? 174 : 25;
      pixels[offset + 2] = central ? 78 : 30;
      pixels[offset + 3] = 255;
    }
  }
  assert.deepEqual(sampleCentralRoiRgb(pixels, width, height, {
    x: 0, y: 0, width, height,
  }), { red: 28, green: 174, blue: 78 });
});

test('salva i sei riferimenti medi prima della classificazione finale', () => {
  const references = Object.entries(COLORS).flatMap(([color, sample]) => ([
    { color: color as CubeColor, sample, weight: 0.9 },
    {
      color: color as CubeColor,
      sample: { red: sample.red + 4, green: sample.green + 2, blue: sample.blue + 3 },
      weight: 0.8,
    },
  ]));
  const profile = buildInitialColorCalibration(references);
  assert.equal(profile.ready, true);
  assert.equal(profile.calibratedColors, 6);
  assert.deepEqual(profile.missingColors, []);
  assert.ok(profile.calibration.green);
});

test('il classificatore HSV adattivo segue la luce del fotogramma', () => {
  const calibration = buildColorCalibration(Object.entries(COLORS).map(([color, sample]) => ({
    color: color as CubeColor,
    sample,
  })));
  const frame = Object.values(COLORS).flatMap((sample) => Array.from({ length: 20 }, () => sample));
  const classify = createAdaptiveColorClassifier(frame, calibration);
  assert.equal(classify({ red: 188, green: 38, blue: 43 })?.color, 'red');
  assert.equal(classify({ red: 210, green: 215, blue: 222 })?.color, 'white');
  assert.equal(classify({ red: 4, green: 5, blue: 4 }), null);
});

test('il clustering globale assegna esattamente nove caselle a ogni colore', () => {
  const faces: Face[] = ['U', 'R', 'F', 'D', 'L', 'B'];
  const faceColors: CubeColor[] = ['white', 'red', 'green', 'yellow', 'orange', 'blue'];
  const calibration = buildColorCalibration(faceColors.map((color) => ({ color, sample: COLORS[color] })));
  const pool = faceColors.flatMap((color) => Array.from({ length: 8 }, (_, index) => ({
    red: COLORS[color].red + (index % 3) - 1,
    green: COLORS[color].green + (index % 2),
    blue: COLORS[color].blue - (index % 2),
  })));
  const rawFacelets = Object.fromEntries(faces.map((face, faceIndex) => {
    const cells = Array<RgbSample | null>(9).fill(null);
    cells[4] = COLORS[faceColors[faceIndex]];
    const positions = [0, 1, 2, 3, 5, 6, 7, 8];
    positions.forEach((position) => { cells[position] = pool.shift() ?? null; });
    return [face, cells];
  })) as Record<Face, Array<RgbSample | null>>;
  const balanced = classifyBalancedCubeFacelets(rawFacelets, calibration);
  assert.ok(balanced);
  assert.equal(balanced.validation.valid, true);
  Object.values(balanced.validation.colorCounts).forEach((count) => assert.equal(count, 9));
});

test('rifiuta schemi con conteggi errati o centri duplicati', () => {
  const faces: Face[] = ['U', 'R', 'F', 'D', 'L', 'B'];
  const facelets = Object.fromEntries(faces.map((face, faceIndex) => (
    [face, Array<CubeColor>(9).fill((['white', 'red', 'green', 'yellow', 'orange', 'blue'] as CubeColor[])[faceIndex])]
  ))) as Record<Face, CubeColor[]>;
  assert.equal(validateCubeColorDistribution(facelets).valid, true);
  facelets.R[4] = 'white';
  const invalid = validateCubeColorDistribution(facelets);
  assert.equal(invalid.valid, false);
  assert.equal(invalid.centersUnique, false);
  assert.equal(invalid.eachColorNine, false);
});
