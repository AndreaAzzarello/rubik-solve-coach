// Stima e applica l'omografia che mappa le coordinate di griglia di una
// faccia (colonna, riga) sulle coordinate pixel dell'immagine, a partire da
// corrispondenze reali (sticker riconosciuti a una posizione di griglia
// nota). Serve a sostituire l'estrapolazione affine (centro + due vettori
// `right`/`down`) usata oggi in `detectFaceGrids`/`detectCubeFaceQuads`, che
// e' esatta solo in proiezione ortografica: in una foto reale (prospettica)
// una faccia di scorcio e' un trapezio, non un parallelogramma, e
// l'estrapolazione lineare deriva progressivamente lontano dall'ancora.
//
// Convenzione di coordinate di griglia: colonna/riga in [-1, 0, 1] con (0,0)
// al centro della faccia, la stessa usata da `detectFaceGrids` per calcolare
// `center + right*colonna + down*riga`. Gli angoli esterni della faccia (il
// contorno) sono a colonna/riga ±1.5, coerente con `faceCenterX/Y = origin +
// (right+down)*1.5` gia' usato per il path silhouette.
//
// Modulo puro (nessuna dipendenza dal DOM/canvas): non e' ancora agganciato
// alla pipeline di rilevamento (step successivo).

export type Point = { x: number; y: number };

export type Correspondence = { grid: Point; image: Point };

/** Omografia 3x3 con h33 normalizzato a 1: [[h11,h12,h13],[h21,h22,h23],[h31,h32,1]]. */
export type Homography = {
  h11: number; h12: number; h13: number;
  h21: number; h22: number; h23: number;
  h31: number; h32: number;
};

const MIN_CORRESPONDENCES = 4;
const MIN_DISTINCT_COLUMNS = 2;
const MIN_DISTINCT_ROWS = 2;
const SINGULARITY_EPSILON = 1e-9;
const MIN_DENOMINATOR = 1e-3;
const CORNER_MARGIN = 1.5;

// Esportata per vision/eval: la metrica "grid-cell hit-rate" deve accoppiare
// i keypoint predetti e quelli reali agli STESSI 4 angoli nominali usati qui,
// altrimenti confronterebbe due omografie non comparabili.
export const NOMINAL_CORNERS: Point[] = [
  { x: -CORNER_MARGIN, y: -CORNER_MARGIN },
  { x: CORNER_MARGIN, y: -CORNER_MARGIN },
  { x: CORNER_MARGIN, y: CORNER_MARGIN },
  { x: -CORNER_MARGIN, y: CORNER_MARGIN },
];

export function applyHomography(homography: Homography, point: Point): Point {
  const denominator = homography.h31 * point.x + homography.h32 * point.y + 1;
  return {
    x: (homography.h11 * point.x + homography.h12 * point.y + homography.h13) / denominator,
    y: (homography.h21 * point.x + homography.h22 * point.y + homography.h23) / denominator,
  };
}

// Richiede corrispondenze su almeno due righe e due colonne distinte: con
// punti tutti allineati (stessa riga o stessa colonna) l'omografia non e'
// univocamente determinabile e il fit sarebbe instabile.
function hasEnoughSpread(correspondences: Correspondence[]): boolean {
  const columns = new Set(correspondences.map(({ grid }) => grid.x));
  const rows = new Set(correspondences.map(({ grid }) => grid.y));
  return columns.size >= MIN_DISTINCT_COLUMNS && rows.size >= MIN_DISTINCT_ROWS;
}

// Eliminazione di Gauss con pivot parziale. Torna null se il sistema e'
// singolare (o troppo vicino alla singolarita'): capita con corrispondenze
// quasi collineari o duplicate, e segnala al chiamante di ricadere sul
// posizionamento affine invece di fidarsi di un fit instabile.
function solveLinearSystem(matrix: number[][], vector: number[]): number[] | null {
  const size = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < size; column += 1) {
    let pivotRow = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivotRow][column])) pivotRow = row;
    }
    if (Math.abs(augmented[pivotRow][column]) < SINGULARITY_EPSILON) return null;
    [augmented[column], augmented[pivotRow]] = [augmented[pivotRow], augmented[column]];
    for (let row = column + 1; row < size; row += 1) {
      const factor = augmented[row][column] / augmented[column][column];
      for (let k = column; k <= size; k += 1) augmented[row][k] -= factor * augmented[column][k];
    }
  }
  const solution = Array<number>(size).fill(0);
  for (let row = size - 1; row >= 0; row -= 1) {
    let sum = augmented[row][size];
    for (let column = row + 1; column < size; column += 1) sum -= augmented[row][column] * solution[column];
    solution[row] = sum / augmented[row][row];
  }
  return solution;
}

// Un'omografia numericamente valida ma stimata da poche corrispondenze
// rumorose puo' essere geometricamente assurda: angoli fuori scala, punti
// "dietro" il piano immagine (denominatore vicino a zero), o un contorno
// autointersecante. Proiettando i 4 angoli nominali della faccia verifichiamo
// che restino un quadrilatero semplice e convesso prima di fidarci del fit.
export function isHomographyPlausible(homography: Homography): boolean {
  const projected: Point[] = [];
  for (const corner of NOMINAL_CORNERS) {
    const denominator = homography.h31 * corner.x + homography.h32 * corner.y + 1;
    if (!Number.isFinite(denominator) || Math.abs(denominator) < MIN_DENOMINATOR) return false;
    const projectedCorner = applyHomography(homography, corner);
    if (!Number.isFinite(projectedCorner.x) || !Number.isFinite(projectedCorner.y)) return false;
    projected.push(projectedCorner);
  }
  let sign = 0;
  for (let index = 0; index < projected.length; index += 1) {
    const previous = projected[(index - 1 + projected.length) % projected.length];
    const current = projected[index];
    const next = projected[(index + 1) % projected.length];
    const cross = (current.x - previous.x) * (next.y - current.y) - (current.y - previous.y) * (next.x - current.x);
    if (Math.abs(cross) < 1e-9) return false;
    const currentSign = Math.sign(cross);
    if (sign === 0) sign = currentSign;
    else if (currentSign !== sign) return false;
  }
  return true;
}

/**
 * Stima l'omografia (8 gradi di liberta', h33=1) che mappa le coordinate di
 * griglia sulle coordinate immagine, a minimi quadrati quando le
 * corrispondenze sono piu' di 4 (risolvendo le equazioni normali A^T A h =
 * A^T b, un sistema 8x8, con la stessa eliminazione di Gauss usata per il
 * fit esatto a 4 punti). Torna null se i dati non bastano, sono troppo
 * allineati, il sistema e' singolare, o il risultato non e' geometricamente
 * plausibile (vedi `isHomographyPlausible`): in ogni caso il chiamante deve
 * ricadere sul posizionamento affine attuale.
 */
export function fitHomography(correspondences: Correspondence[]): Homography | null {
  if (correspondences.length < MIN_CORRESPONDENCES) return null;
  if (!hasEnoughSpread(correspondences)) return null;

  const rows: number[][] = [];
  const values: number[] = [];
  correspondences.forEach(({ grid, image }) => {
    rows.push([grid.x, grid.y, 1, 0, 0, 0, -grid.x * image.x, -grid.y * image.x]);
    values.push(image.x);
    rows.push([0, 0, 0, grid.x, grid.y, 1, -grid.x * image.y, -grid.y * image.y]);
    values.push(image.y);
  });

  const normalMatrix = Array.from({ length: 8 }, () => Array<number>(8).fill(0));
  const normalVector = Array<number>(8).fill(0);
  for (let sampleIndex = 0; sampleIndex < rows.length; sampleIndex += 1) {
    const row = rows[sampleIndex];
    for (let i = 0; i < 8; i += 1) {
      normalVector[i] += row[i] * values[sampleIndex];
      for (let j = 0; j < 8; j += 1) normalMatrix[i][j] += row[i] * row[j];
    }
  }

  const solved = solveLinearSystem(normalMatrix, normalVector);
  if (!solved) return null;
  const [h11, h12, h13, h21, h22, h23, h31, h32] = solved;
  const homography: Homography = { h11, h12, h13, h21, h22, h23, h31, h32 };
  return isHomographyPlausible(homography) ? homography : null;
}

/** Errore medio di riproiezione in pixel: usato nei test e, negli step
 * successivi, come segnale di confidenza del fit. */
export function homographyResidual(homography: Homography, correspondences: Correspondence[]): number {
  if (correspondences.length === 0) return 0;
  const total = correspondences.reduce((sum, { grid, image }) => {
    const projected = applyHomography(homography, grid);
    return sum + Math.hypot(projected.x - image.x, projected.y - image.y);
  }, 0);
  return total / correspondences.length;
}
