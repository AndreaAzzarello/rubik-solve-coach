import assert from 'node:assert/strict';
import test from 'node:test';
import type { CubeColor, Face } from './cube.ts';
import {
  buildColorCalibration,
  classifyCalibratedColor,
  classifyGuidedCaptures,
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
});
