// Rilevamento dei 4 vertici di ogni faccia cubo visibile via il modello
// ONNX YOLOv8n-pose fine-tuned (vision/training/), eseguito nel browser con
// onnxruntime-web (backend wasm forzato, single-thread: niente bisogno di
// header COOP/COEP per SharedArrayBuffer, stesso vincolo di determinismo gia'
// scelto per `pnpm bench` — un backend GPU/webgl reintrodurrebbe
// non-determinismo nel punteggio).
//
// STEP 4: l'inferenza (detectFaceCorners) va chiamata dal chiamante UNA
// VOLTA per fotogramma sul video intero a risoluzione da training (~960px
// lato lungo), non sul canvas di analisi 320-480px ritagliato - quel canvas
// produceva quadrilateri minuscoli/mal posizionati (bug trovato dal vivo via
// bench/debug-grids). Vedi lib/video-decoder.ts, readHighResolutionInspectionFrame.
//
// Split deliberato in due parti:
// - faceGridFromCorners/faceGridsFromDetections: geometria pura (omografia +
//   campionamento colore via gli stessi helper di video-decoder.ts),
//   testabile in Node senza canvas/ONNX (vedi face-keypoint-model.test.ts).
// - detectFaceCorners: orchestrazione browser (canvas + onnxruntime-web),
//   non testabile in Node puro - stesso schema di lib/hand-motion.ts (nessun
//   test unitario, verificato dal vivo via bench/eval, non da una suite Node).

import * as ort from 'onnxruntime-web/wasm';
import { CUBE_COLORS, type CubeColor } from './cube.ts';
import { type RgbSample, sampleCentralRoiRgb } from './color-calibration.ts';
import { applyHomography, fitHomography, NOMINAL_CORNERS, type Point } from './homography.ts';
import type { FaceGridObservation } from './inspection-state.ts';
import { applyLocalCenterCalibration, sampleVirtualCell } from './video-decoder.ts';
import { decodePoseOutput, nonMaxSuppression } from '../vision/inference/pose-decode.ts';

const MODEL_URL = '/models/cube-face-keypoints.onnx';
const MODEL_INPUT_SIZE = 512;
const CONF_THRESHOLD = 0.25;
const IOU_THRESHOLD = 0.5;
// Stessa banda 42-94 gia' usata dai due percorsi geometrici in
// video-decoder.ts (detectFaceGrids): tenerla identica evita che la fusione
// multi-frame in inspection-state.ts sovra/sotto-pesi sistematicamente le
// candidate del modello solo perche' la scala di confidenza e' diversa.
const CONFIDENCE_FLOOR = 42;
const CONFIDENCE_CEILING = 94;
const CELL_CONFIDENCE_FLOOR = 35;
const CELL_CONFIDENCE_CEILING = 90;

// Filtro di plausibilita' pre-fusione (trovato dal vivo via bench/debug-grids:
// il modello produce a volte quadrilateri minuscoli o strisce sul bordo con
// score ALTO — lo score da solo non li distingue da una faccia vera). Meglio
// scartare che tenere: ogni video ha molti fotogrammi, un rilevamento perso
// costa meno di uno sbagliato che spiazza una lettura geometrica corretta
// nella fusione a voto per-cella.
const MIN_DETECTION_SCORE = 0.5;
// |sin(angolo fra le due diagonali)|: 1 per un quadrilatero "quadrato" anche
// in prospettiva, vicino a 0 per una striscia degenere (diagonali quasi
// parallele anche se lunghe).
const MIN_QUAD_SHAPE_SCORE = 0.35;
// Una faccia vera non e' mai una piccola frazione dell'area della faccia piu'
// grande vista nello stesso fotogramma (stesso cubo, stessa distanza).
const MIN_RELATIVE_AREA = 0.35;

export type FaceCornerDetection = { score: number; keypoints: Point[] };

function quadArea(corners: Point[]): number {
  let sum = 0;
  for (let i = 0; i < corners.length; i += 1) {
    const a = corners[i];
    const b = corners[(i + 1) % corners.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

function isConvexQuad(corners: Point[]): boolean {
  let sign = 0;
  for (let i = 0; i < corners.length; i += 1) {
    const prev = corners[(i - 1 + corners.length) % corners.length];
    const curr = corners[i];
    const next = corners[(i + 1) % corners.length];
    const cross = (curr.x - prev.x) * (next.y - curr.y) - (curr.y - prev.y) * (next.x - curr.x);
    if (Math.abs(cross) < 1e-9) return false;
    const currentSign = Math.sign(cross);
    if (sign === 0) sign = currentSign;
    else if (currentSign !== sign) return false;
  }
  return true;
}

/** |sin(angolo fra le diagonali)|: 2*Area / (|d1|*|d2|). */
function quadShapeScore(corners: Point[]): number {
  const d1 = { x: corners[2].x - corners[0].x, y: corners[2].y - corners[0].y };
  const d2 = { x: corners[3].x - corners[1].x, y: corners[3].y - corners[1].y };
  const len1 = Math.hypot(d1.x, d1.y);
  const len2 = Math.hypot(d2.x, d2.y);
  if (len1 < 1e-6 || len2 < 1e-6) return 0;
  return Math.abs(d1.x * d2.y - d1.y * d2.x) / (len1 * len2);
}

/**
 * Filtro pre-fusione: score minimo, quadrilatero convesso e non a striscia,
 * area non troppo piccola rispetto alla faccia piu' grande vista nello
 * STESSO fotogramma (le detection vanno passate gia' raggruppate per
 * fotogramma, prima di rimapparle nello spazio di ciascun ritaglio).
 */
export function filterPlausibleDetections(detections: FaceCornerDetection[]): FaceCornerDetection[] {
  const candidates = detections
    .filter((detection) => detection.score >= MIN_DETECTION_SCORE)
    .filter((detection) => detection.keypoints.length === 4 && isConvexQuad(detection.keypoints))
    .map((detection) => ({ detection, area: quadArea(detection.keypoints), shape: quadShapeScore(detection.keypoints) }))
    .filter((candidate) => candidate.shape >= MIN_QUAD_SHAPE_SCORE);

  if (candidates.length === 0) return [];
  const maxArea = Math.max(...candidates.map((candidate) => candidate.area));
  return candidates
    .filter((candidate) => candidate.area >= maxArea * MIN_RELATIVE_AREA)
    .map((candidate) => candidate.detection);
}

/**
 * Geometria pura: dai 4 vertici rilevati (ordine "dal piu' in alto, in senso
 * orario" — stesso usato in training, vision/dataset/annotation.ts) stima
 * l'omografia grid->immagine, campiona le 9 celle e produce una candidata
 * nella stessa forma di quelle prodotte da detectFaceGrids.
 */
export function faceGridFromCorners(
  detection: FaceCornerDetection,
  labels: Int8Array,
  width: number,
  height: number,
  pixels?: Uint8ClampedArray,
): Omit<FaceGridObservation, 'time'> | null {
  if (detection.keypoints.length !== NOMINAL_CORNERS.length) return null;
  const correspondences = detection.keypoints.map((image, index) => ({ grid: NOMINAL_CORNERS[index], image }));
  const homography = fitHomography(correspondences);
  if (!homography) return null;

  const center = applyHomography(homography, { x: 0, y: 0 });
  const right = applyHomography(homography, { x: 1, y: 0 });
  const down = applyHomography(homography, { x: 0, y: 1 });
  const rightVector = { x: right.x - center.x, y: right.y - center.y };
  const downVector = { x: down.x - center.x, y: down.y - center.y };
  const sampleRadius = Math.max(2, Math.min(Math.hypot(rightVector.x, rightVector.y), Math.hypot(downVector.x, downVector.y)) * 0.3);

  const colors = Array<CubeColor | null>(9).fill(null);
  const rawColors = Array<RgbSample | null>(9).fill(null);
  const cellConfidences = Array<number>(9).fill(0);
  let visibleCells = 0;

  for (let row = -1; row <= 1; row += 1) {
    for (let column = -1; column <= 1; column += 1) {
      const target = applyHomography(homography, { x: column, y: row });
      const virtual = sampleVirtualCell(labels, width, height, target.x, target.y, sampleRadius);
      if (!virtual) continue;
      const cellIndex = (row + 1) * 3 + column + 1;
      colors[cellIndex] = CUBE_COLORS[virtual.label];
      rawColors[cellIndex] = pixels ? sampleCentralRoiRgb(pixels, width, height, {
        x: Math.round(target.x - sampleRadius),
        y: Math.round(target.y - sampleRadius),
        width: Math.round(sampleRadius * 2),
        height: Math.round(sampleRadius * 2),
      }, 0.4) ?? null : null;
      cellConfidences[cellIndex] = Math.round(Math.min(CELL_CONFIDENCE_CEILING, Math.max(CELL_CONFIDENCE_FLOOR, virtual.confidence * CELL_CONFIDENCE_CEILING)));
      visibleCells += 1;
    }
  }

  const centerColor = colors[4];
  if (visibleCells < 6 || !centerColor) return null;
  applyLocalCenterCalibration(centerColor, rawColors, colors, cellConfidences);

  const avgCellConfidence = cellConfidences.reduce((sum, value) => sum + value, 0) / (visibleCells * CELL_CONFIDENCE_CEILING);
  // Il punteggio del modello (gia' validato su 21 frame reali di
  // validazione: 100% recall, 66% PCK@5%) pesa piu' delle sole geometria/
  // colore, a differenza dei due percorsi geometrici che non hanno un
  // segnale di confidenza indipendente dalla geometria stessa.
  const score = detection.score * 0.5 + (visibleCells / 9) * 0.3 + avgCellConfidence * 0.2;

  return {
    centerColor,
    colors,
    rawColors,
    cellConfidences,
    visibleCells,
    confidence: Math.round(Math.min(CONFIDENCE_CEILING, Math.max(CONFIDENCE_FLOOR, score * 100))),
    imageX: center.x,
    imageY: center.y,
    rightX: rightVector.x,
    rightY: rightVector.y,
    downX: downVector.x,
    downY: downVector.y,
    gridSource: 'model',
    silhouette: detection.keypoints.map((point) => ({ x: point.x, y: point.y })),
  };
}

let sessionPromise: Promise<ort.InferenceSession> | null = null;

function getSession(): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    // wasmPaths NON viene sovrascritto: onnxruntime-web e' gia' una
    // dipendenza npm pinnata a lockfile (stessa logica per cui non serve
    // vendorizzarla come si fa per MediaPipe, che invece dipende da un CDN
    // esterno soggetto a deriva). Puntare a una copia in public/ rompe
    // l'import() dinamico del loader .mjs sotto Vite (visto dal vivo: "no
    // available backend found" nel bench) perche' un file in public/ sta
    // fuori dal grafo di moduli che Vite sa trasformare/servire in dev.
    ort.env.wasm.numThreads = 1;
    sessionPromise = ort.InferenceSession.create(MODEL_URL, { executionProviders: ['wasm'] });
  }
  return sessionPromise;
}

type PreparedInput = { tensor: Float32Array; scale: number; padX: number; padY: number };

// Stessa identica matematica di letterbox usata in training/eval
// (vision/inference/detector.ts): riquadro 512x512, riempimento
// rgb(114,114,114), fattore di scala uniforme min(target/w, target/h).
function letterbox(source: CanvasImageSource, srcWidth: number, srcHeight: number, target: number): PreparedInput {
  const canvas = document.createElement('canvas');
  canvas.width = target;
  canvas.height = target;
  const ctx = canvas.getContext('2d')!;
  const scale = Math.min(target / srcWidth, target / srcHeight);
  const newWidth = Math.round(srcWidth * scale);
  const newHeight = Math.round(srcHeight * scale);
  const padX = Math.floor((target - newWidth) / 2);
  const padY = Math.floor((target - newHeight) / 2);
  ctx.fillStyle = 'rgb(114,114,114)';
  ctx.fillRect(0, 0, target, target);
  ctx.drawImage(source, padX, padY, newWidth, newHeight);
  const pixels = ctx.getImageData(0, 0, target, target).data;
  const size = target * target;
  const tensor = new Float32Array(3 * size);
  for (let i = 0; i < size; i += 1) {
    tensor[i] = pixels[i * 4] / 255;
    tensor[size + i] = pixels[i * 4 + 1] / 255;
    tensor[2 * size + i] = pixels[i * 4 + 2] / 255;
  }
  return { tensor, scale, padX, padY };
}

/** Orchestrazione browser: inferenza ONNX sul fotogramma gia' disegnato in `context`, coordinate rimappate allo spazio immagine originale. */
export async function detectFaceCorners(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
): Promise<FaceCornerDetection[]> {
  const session = await getSession();
  const prepared = letterbox(context.canvas, width, height, MODEL_INPUT_SIZE);
  const inputTensor = new ort.Tensor('float32', prepared.tensor, [1, 3, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE]);
  const results = await session.run({ [session.inputNames[0]]: inputTensor });
  const output = results[session.outputNames[0]];
  const [, channels, numAnchors] = output.dims as [number, number, number];
  const numKeypoints = (channels - 5) / 3;
  const raw = decodePoseOutput(output.data as Float32Array, numAnchors, numKeypoints, CONF_THRESHOLD);
  const kept = nonMaxSuppression(raw, IOU_THRESHOLD);
  return kept.map((detection) => ({
    score: detection.score,
    keypoints: detection.keypoints.map((kp) => ({
      x: (kp.x - prepared.padX) / prepared.scale,
      y: (kp.y - prepared.padY) / prepared.scale,
    })),
  }));
}

/**
 * Geometria pura da detection GIA' calcolate altrove (STEP 4: il chiamante -
 * readHighResolutionInspectionFrame - fa girare detectFaceCorners una sola
 * volta sul fotogramma intero a risoluzione da training, poi rimappa i
 * vertici nello spazio di ciascun canvas di analisi/ritaglio prima di
 * chiamare questa funzione). Nessuna inferenza qui.
 */
export function faceGridsFromDetections(
  detections: FaceCornerDetection[],
  labels: Int8Array,
  width: number,
  height: number,
  pixels?: Uint8ClampedArray,
): Array<Omit<FaceGridObservation, 'time'>> {
  const grids: Array<Omit<FaceGridObservation, 'time'>> = [];
  detections.forEach((detection) => {
    const grid = faceGridFromCorners(detection, labels, width, height, pixels);
    if (grid) grids.push(grid);
  });
  return grids;
}
