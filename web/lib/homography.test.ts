import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyHomography,
  fitHomography,
  homographyResidual,
  isHomographyPlausible,
  type Correspondence,
  type Homography,
  type Point,
} from './homography.ts';

// Omografia "di riferimento": una faccia vista con una prospettiva blanda ma
// reale (denominatore vicino a 1 su tutta la griglia, non un'affinita' pura),
// cosi' i test dimostrano che il fit recupera davvero la componente
// proiettiva e non solo un'approssimazione affine locale.
const REFERENCE_HOMOGRAPHY: Homography = {
  h11: 82, h12: 9, h13: 300,
  h21: -6, h22: 88, h23: 250,
  h31: 0.0026, h32: -0.0014,
};

const GRID_CELLS: Point[] = [-1, 0, 1].flatMap((row) => [-1, 0, 1].map((column) => ({ x: column, y: row })));

function correspondencesFrom(homography: Homography, points: Point[]): Correspondence[] {
  return points.map((grid) => ({ grid, image: applyHomography(homography, grid) }));
}

test('applica correttamente una trasformazione puramente affine (h31=h32=0)', () => {
  const affine: Homography = { h11: 2, h12: 0, h13: 10, h21: 0, h22: 3, h23: 5, h31: 0, h32: 0 };
  assert.deepEqual(applyHomography(affine, { x: 0, y: 0 }), { x: 10, y: 5 });
  assert.deepEqual(applyHomography(affine, { x: 1, y: 1 }), { x: 12, y: 8 });
  assert.deepEqual(applyHomography(affine, { x: -1, y: 2 }), { x: 8, y: 11 });
});

test('con le 9 corrispondenze esatte ricostruisce l’omografia originale, non solo i punti campionati', () => {
  const correspondences = correspondencesFrom(REFERENCE_HOMOGRAPHY, GRID_CELLS);
  const fitted = fitHomography(correspondences);
  assert.ok(fitted, 'il fit deve riuscire con 9 corrispondenze non degeneri');
  assert.ok(homographyResidual(fitted!, correspondences) < 1e-6, 'residuo ~0 sui punti usati per il fit');

  // Un angolo esterno della faccia (colonna/riga 1.5), MAI passato come
  // corrispondenza: se il fit avesse solo interpolato i 9 campioni invece di
  // ricostruire la vera omografia, qui divergerebbe.
  const outerCorner = { x: 1.5, y: 1.5 };
  const expected = applyHomography(REFERENCE_HOMOGRAPHY, outerCorner);
  const predicted = applyHomography(fitted!, outerCorner);
  assert.ok(Math.hypot(predicted.x - expected.x, predicted.y - expected.y) < 1e-3);
});

test('con esattamente 4 corrispondenze (il minimo) risolve un fit esatto', () => {
  const corners: Point[] = [{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }];
  const correspondences = correspondencesFrom(REFERENCE_HOMOGRAPHY, corners);
  const fitted = fitHomography(correspondences);
  assert.ok(fitted);
  assert.ok(homographyResidual(fitted!, correspondences) < 1e-6);
});

test('con rumore realistico sulle corrispondenze il residuo resta piccolo e limitato', () => {
  const noise = [0.4, -0.3, 0.2, -0.5, 0.3, -0.2, 0.5, -0.4, 0.1];
  const correspondences = correspondencesFrom(REFERENCE_HOMOGRAPHY, GRID_CELLS).map((correspondence, index) => ({
    grid: correspondence.grid,
    image: { x: correspondence.image.x + noise[index], y: correspondence.image.y - noise[index] },
  }));
  const fitted = fitHomography(correspondences);
  assert.ok(fitted);
  const residual = homographyResidual(fitted!, correspondences);
  assert.ok(residual > 0, 'con rumore il residuo non e\' piu\' esattamente zero');
  assert.ok(residual < 1, 'i minimi quadrati devono mediare il rumore, non inseguirlo');
});

test('rifiuta meno di 4 corrispondenze', () => {
  const correspondences = correspondencesFrom(REFERENCE_HOMOGRAPHY, [
    { x: -1, y: -1 }, { x: 1, y: -1 }, { x: 0, y: 1 },
  ]);
  assert.equal(fitHomography(correspondences), null);
});

test('rifiuta corrispondenze tutte sulla stessa riga (nessuno spread verticale)', () => {
  const correspondences = correspondencesFrom(REFERENCE_HOMOGRAPHY, [
    { x: -1, y: 0 }, { x: -0.5, y: 0 }, { x: 0.5, y: 0 }, { x: 1, y: 0 },
  ]);
  assert.equal(fitHomography(correspondences), null);
});

test('rifiuta corrispondenze duplicate/collineari anche se in numero sufficiente', () => {
  const point = { x: -1, y: -1 };
  const correspondences: Correspondence[] = [
    { grid: point, image: applyHomography(REFERENCE_HOMOGRAPHY, point) },
    { grid: point, image: applyHomography(REFERENCE_HOMOGRAPHY, point) },
    { grid: { x: 1, y: 1 }, image: applyHomography(REFERENCE_HOMOGRAPHY, { x: 1, y: 1 }) },
    { grid: { x: 1, y: 1 }, image: applyHomography(REFERENCE_HOMOGRAPHY, { x: 1, y: 1 }) },
  ];
  // Due soli punti geometrici distinti (per quanto ripetuti 4 volte): il
  // sistema resta singolare, deve ricadere sul fallback come con <4 punti.
  assert.equal(fitHomography(correspondences), null);
});

test('rifiuta un fit reso assurdo da una corrispondenza aberrante', () => {
  const sane = correspondencesFrom(REFERENCE_HOMOGRAPHY, [
    { x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 },
  ]);
  const outlier: Correspondence = { grid: { x: -1, y: 1 }, image: { x: -50000, y: 50000 } };
  assert.equal(fitHomography([...sane, outlier]), null);
});

test('isHomographyPlausible rifiuta un\'omografia che ribalta il quadrilatero (denominatore che cambia segno)', () => {
  const flipping: Homography = { h11: 80, h12: 0, h13: 300, h21: 0, h22: 80, h23: 250, h31: 0.9, h32: 0 };
  assert.equal(isHomographyPlausible(flipping), false);
});

test('isHomographyPlausible accetta l\'omografia di riferimento', () => {
  assert.equal(isHomographyPlausible(REFERENCE_HOMOGRAPHY), true);
});
