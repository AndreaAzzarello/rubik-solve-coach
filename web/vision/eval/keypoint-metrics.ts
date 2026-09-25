// Metriche del piano per il rilevatore di keypoint: PCK e grid-cell hit-rate,
// piu' recall/precisione a livello di istanza (trovare il numero giusto di
// facce e' un fallimento diverso da "trovata ma imprecisa"). Puro: nessuna
// dipendenza da ONNX/Playwright, prende gia' rilevazioni e ground truth.

import { applyHomography, fitHomography, NOMINAL_CORNERS } from '../../lib/homography.ts';
import { boxIou, type Box } from '../inference/pose-decode.ts';
import type { LabeledFace } from './yolo-label.ts';

type Point = { x: number; y: number };

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

// L'ordine dei 4 keypoint (annotation.ts, geometricOrder) e' geometrico
// ("dal piu' in alto, in senso orario"), non semantico: un lieve disaccordo
// fra predizione e ground truth su quale corner sia "il piu' in alto" ruota
// l'intero ciclo. Proviamo le 4 rotazioni cicliche per entrambi i versi (8
// permutazioni totali) e teniamo la migliore, invece di confrontare indice
// per indice e penalizzare un errore che non e' nella geometria.
function candidateOrders(n: number): number[][] {
  const base = Array.from({ length: n }, (_, i) => i);
  const reversedBase = [...base].reverse();
  const orders: number[][] = [];
  [base, reversedBase].forEach((sequence) => {
    for (let rotation = 0; rotation < n; rotation += 1) {
      orders.push(sequence.map((_, i) => sequence[(i + rotation) % n]));
    }
  });
  return orders;
}

/** `order[gtIndex]` = indice in `predicted` allineato a `groundTruth[gtIndex]`. */
function bestAlignment(predicted: Point[], groundTruth: Point[]): { order: number[]; meanDistance: number } {
  let best = { order: candidateOrders(predicted.length)[0], meanDistance: Infinity };
  candidateOrders(predicted.length).forEach((order) => {
    const total = order.reduce((sum, predIndex, gtIndex) => sum + dist(predicted[predIndex], groundTruth[gtIndex]), 0);
    const mean = total / order.length;
    if (mean < best.meanDistance) best = { order, meanDistance: mean };
  });
  return best;
}

function faceDiagonal(box: Box): number {
  return Math.hypot(box.w, box.h);
}

export type MatchedInstance = {
  groundTruth: LabeledFace;
  predictedKeypoints: Point[]; // riallineati all'ordine di groundTruth.keypoints
};

export type ImageEvalResult = {
  groundTruthCount: number;
  matchedCount: number;
  unmatchedPredictions: number;
  instances: MatchedInstance[];
};

/** Accoppia istanze reali e predette per IoU del box (greedy, un solo passaggio: bastano 1-3 istanze per immagine). */
export function matchInstances(
  groundTruthFaces: LabeledFace[],
  predictedBoxes: Array<{ box: Box; keypoints: Point[] }>,
  iouThreshold = 0.3,
): ImageEvalResult {
  const usedPredictions = new Set<number>();
  const instances: MatchedInstance[] = [];

  groundTruthFaces.forEach((gt) => {
    let bestIndex = -1;
    let bestIou = iouThreshold;
    predictedBoxes.forEach((pred, index) => {
      if (usedPredictions.has(index)) return;
      const overlap = boxIou(gt.box, pred.box);
      if (overlap > bestIou) { bestIou = overlap; bestIndex = index; }
    });
    if (bestIndex === -1) return;
    usedPredictions.add(bestIndex);
    const { order } = bestAlignment(predictedBoxes[bestIndex].keypoints, gt.keypoints);
    instances.push({
      groundTruth: gt,
      predictedKeypoints: order.map((predIndex) => predictedBoxes[bestIndex].keypoints[predIndex]),
    });
  });

  return {
    groundTruthCount: groundTruthFaces.length,
    matchedCount: instances.length,
    unmatchedPredictions: predictedBoxes.length - usedPredictions.size,
    instances,
  };
}

export type PckTally = { correct: number; total: number };

/** PCK: quota di keypoint ETICHETTATI (visibility 1 o 2) entro `threshold` * diagonale faccia. Separato per visibilita' alta/bassa. */
export function accumulatePck(
  instances: MatchedInstance[],
  threshold: number,
  tallies: { overall: PckTally; visible: PckTally; occluded: PckTally },
): void {
  instances.forEach(({ groundTruth, predictedKeypoints }) => {
    const diag = faceDiagonal(groundTruth.box);
    groundTruth.keypoints.forEach((gtPoint, index) => {
      if (gtPoint.visibility === 0) return;
      const predicted = predictedKeypoints[index];
      const correct = dist(predicted, gtPoint) <= threshold * diag;
      tallies.overall.total += 1;
      if (correct) tallies.overall.correct += 1;
      const bucket = gtPoint.visibility === 2 ? tallies.visible : tallies.occluded;
      bucket.total += 1;
      if (correct) bucket.correct += 1;
    });
  });
}

/**
 * Grid-cell hit-rate: adatta la metrica del piano ai dati che abbiamo
 * davvero (le label salvano i 4 angoli, non i poligoni sticker). Confronta
 * dove finiscono i 9 punti griglia usando l'omografia dai keypoint REALI
 * contro quella dai keypoint PREDETTI (gia' riallineati): un "hit" e' entro
 * 1/6 del passo cella, soglia scelta perche' e' meta' della meta'-cella (una
 * lettura del colore centrata sul punto sbagliato di piu' rischia di
 * campionare lo sticker adiacente).
 */
export function gridCellHitRate(instances: MatchedInstance[], hitFraction = 1 / 6): { hits: number; total: number } {
  let hits = 0;
  let total = 0;
  const gridPoints: Point[] = [];
  for (let row = -1; row <= 1; row += 1) {
    for (let column = -1; column <= 1; column += 1) gridPoints.push({ x: column, y: row });
  }

  instances.forEach(({ groundTruth, predictedKeypoints }) => {
    const correspondencesGt = NOMINAL_CORNERS.map((grid, i) => ({ grid, image: groundTruth.keypoints[i] }));
    const correspondencesPred = NOMINAL_CORNERS.map((grid, i) => ({ grid, image: predictedKeypoints[i] }));
    const homographyGt = fitHomography(correspondencesGt);
    const homographyPred = fitHomography(correspondencesPred);
    if (!homographyGt || !homographyPred) return; // corner troppo degeneri per un fit: non contiamo l'istanza

    const cellStep = Math.hypot(groundTruth.box.w, groundTruth.box.h) / 3 / Math.SQRT2;
    const tolerance = cellStep * hitFraction;

    gridPoints.forEach((point) => {
      const trueSample = applyHomography(homographyGt, point);
      const predSample = applyHomography(homographyPred, point);
      total += 1;
      if (dist(trueSample, predSample) <= tolerance) hits += 1;
    });
  });

  return { hits, total };
}
