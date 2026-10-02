import assert from 'node:assert/strict';
import test from 'node:test';
import {
  boundsIou,
  faceGridFromCorners,
  filterPlausibleDetections,
  mergeTwoPassDetections,
  quadBounds,
} from './face-keypoint-model.ts';

// Stessa costruzione di griglia sintetica usata dal test di detectFaceGrids
// in video-decoder.test.ts (gridColors -> indice in CUBE_COLORS: 0=white).
function paintedGrid(width: number, height: number) {
  const labels = new Int8Array(width * height);
  labels.fill(-1);
  const step = 17;
  const size = 12;
  const origin = 30;
  const paint = (left: number, top: number, color: number) => {
    for (let y = top; y < top + size; y += 1) {
      for (let x = left; x < left + size; x += 1) labels[y * width + x] = color;
    }
  };
  const gridColors = [1, 2, 5, 4, 0, 3, 2, 4, 1]; // centro (indice 4) = white
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      paint(origin + column * step, origin + row * step, gridColors[row * 3 + column]);
    }
  }
  // Centro cella (1,1) = origin + step + size/2
  const faceCenter = origin + step + size / 2;
  const margin = 1.5 * step;
  const corners = [
    { x: faceCenter - margin, y: faceCenter - margin },
    { x: faceCenter + margin, y: faceCenter - margin },
    { x: faceCenter + margin, y: faceCenter + margin },
    { x: faceCenter - margin, y: faceCenter + margin },
  ];
  return { labels, width, height, faceCenter, corners };
}

test('ricostruisce la griglia 3x3 dai 4 vertici via omografia', () => {
  const { labels, width, height, faceCenter, corners } = paintedGrid(120, 120);
  const result = faceGridFromCorners({ score: 0.9, keypoints: corners }, labels, width, height);

  assert.ok(result);
  assert.equal(result!.centerColor, 'white');
  assert.equal(result!.visibleCells, 9);
  assert.equal(result!.gridSource, 'model');
  assert.ok(Math.abs(result!.imageX! - faceCenter) < 1);
  assert.ok(Math.abs(result!.imageY! - faceCenter) < 1);
  assert.ok(result!.confidence >= 42 && result!.confidence <= 94);
});

test('rifiuta 4 vertici degeneri (nessuno spread) invece di produrre una griglia inventata', () => {
  const { labels, width, height } = paintedGrid(120, 120);
  const degenerate = [{ x: 50, y: 50 }, { x: 50, y: 50 }, { x: 50, y: 50 }, { x: 50, y: 50 }];
  const result = faceGridFromCorners({ score: 0.9, keypoints: degenerate }, labels, width, height);
  assert.equal(result, null);
});

test('rifiuta quando meno di 6 celle sono leggibili (fuori faccia)', () => {
  const width = 120;
  const height = 120;
  const labels = new Int8Array(width * height);
  labels.fill(-1); // nessuna cella dipinta da nessuna parte
  const corners = [
    { x: 20, y: 20 },
    { x: 90, y: 20 },
    { x: 90, y: 90 },
    { x: 20, y: 90 },
  ];
  const result = faceGridFromCorners({ score: 0.9, keypoints: corners }, labels, width, height);
  assert.equal(result, null);
});

const SQUARE = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];

test('filterPlausibleDetections tiene un quadrilatero ben formato con score sufficiente', () => {
  const kept = filterPlausibleDetections([{ score: 0.9, keypoints: SQUARE }]);
  assert.equal(kept.length, 1);
});

test('filterPlausibleDetections scarta score sotto soglia anche con forma buona', () => {
  const kept = filterPlausibleDetections([{ score: 0.3, keypoints: SQUARE }]);
  assert.equal(kept.length, 0);
});

test('filterPlausibleDetections scarta una striscia degenere (diagonali quasi parallele)', () => {
  const strip = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 10 }, { x: 0, y: 10 }];
  const kept = filterPlausibleDetections([{ score: 0.9, keypoints: strip }]);
  assert.equal(kept.length, 0);
});

test('filterPlausibleDetections scarta un quadrilatero troppo piccolo rispetto al piu grande nello stesso fotogramma', () => {
  const tiny = [{ x: 200, y: 200 }, { x: 220, y: 200 }, { x: 220, y: 220 }, { x: 200, y: 220 }];
  const kept = filterPlausibleDetections([
    { score: 0.9, keypoints: SQUARE },
    { score: 0.9, keypoints: tiny },
  ]);
  assert.equal(kept.length, 1);
  assert.deepEqual(kept[0].keypoints, SQUARE);
});

test('boundsIou: 1 per due quadrati identici, 0 per quadrati separati', () => {
  assert.equal(boundsIou(quadBounds(SQUARE), quadBounds(SQUARE)), 1);
  const far = [{ x: 500, y: 500 }, { x: 600, y: 500 }, { x: 600, y: 600 }, { x: 500, y: 600 }];
  assert.equal(boundsIou(quadBounds(SQUARE), quadBounds(far)), 0);
});

test('boundsIou: un quadrato degenere (area 0) non produce NaN/Infinity, IoU 0', () => {
  const point = [{ x: 50, y: 50 }, { x: 50, y: 50 }, { x: 50, y: 50 }, { x: 50, y: 50 }];
  const iou = boundsIou(quadBounds(SQUARE), quadBounds(point));
  assert.equal(iou, 0);
});

test('mergeTwoPassDetections: sostituisce con la faccia del passaggio 2 se c\'e\' corrispondenza IoU', () => {
  const shifted = SQUARE.map((p) => ({ x: p.x + 2, y: p.y + 2 })); // IoU alto ma non identico
  const pass1 = [{ score: 0.7, keypoints: SQUARE }];
  const pass2 = [{ score: 0.9, keypoints: shifted }];
  const merged = mergeTwoPassDetections(pass1, pass2, 0.3);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0], pass2[0]);
});

test('mergeTwoPassDetections: tiene il passaggio 1 se nessuna corrispondenza nel passaggio 2', () => {
  const far = [{ x: 500, y: 500 }, { x: 600, y: 500 }, { x: 600, y: 600 }, { x: 500, y: 600 }];
  const pass1 = [{ score: 0.7, keypoints: SQUARE }];
  const pass2 = [{ score: 0.9, keypoints: far }];
  const merged = mergeTwoPassDetections(pass1, pass2, 0.3);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0], pass1[0]);
});

test('mergeTwoPassDetections: il risultato ha sempre la stessa lunghezza del passaggio 1, anche con un quadrato degenere nel passaggio 2', () => {
  const point = [{ x: 50, y: 50 }, { x: 50, y: 50 }, { x: 50, y: 50 }, { x: 50, y: 50 }];
  const pass1 = [{ score: 0.7, keypoints: SQUARE }, { score: 0.6, keypoints: point }];
  const pass2: typeof pass1 = [];
  const merged = mergeTwoPassDetections(pass1, pass2, 0.3);
  assert.equal(merged.length, pass1.length);
  assert.deepEqual(merged, pass1);
});
