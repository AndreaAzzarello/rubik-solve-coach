// Diagnosi (nessuna modifica al codice di produzione): in un cubo senza
// bordi neri, se la griglia 3x3 e' posizionata bene i confini tra colori
// diversi cadono sulle linee interne della griglia; se e' storta, li tagliano
// dentro le celle. Questo script misura un indice puramente geometrico (mai
// i colori classificati) e verifica se separa le osservazioni-modello giuste
// dalle sbagliate (verita' dallo scramble), per capire se e' un segnale
// utile a scartare osservazioni PRIMA della fusione.
//
// Riusa solo funzioni pure/esportate esistenti (faceGridFromCorners,
// fitHomography/applyHomography, computeFaceSampleGrid, i classificatori
// colore, referenceFromScramble) per ottenere le stesse osservazioni che la
// pipeline produce - nessuna logica di classificazione duplicata. L'unica
// parte NUOVA e' l'indice geometrico (energia del gradiente) e il minimo
// collante per farlo girare in Node (inferenza ONNX + estrazione fotogramma
// via Playwright, stesso pattern di vision/inference/detector.ts).
//
// Semplificazioni dichiarate rispetto alla produzione:
// - un solo passaggio di rilevamento (il fotogramma intero), non il
//   raffinamento a due passaggi - i vertici del passaggio 1 sono comunque
//   quelli con cui faceGridFromCorners legge i colori quando il passaggio 2
//   non trova corrispondenza, quindi restano un sottoinsieme fedele.
// - finestra di ispezione fissa (1s..min(durata-0.5, 16s)) invece della
//   segmentazione automatica basata sul moto: non serve il confine esatto,
//   un fotogramma preso durante lo scramble produce semplicemente
//   un'osservazione "sbagliata" (coerente con la verita'), non un dato falsato.
// - classificazione colore SENZA calibrazione sui centri del video (la stessa
//   usata DENTRO faceGridFromCorners/frameSignature per il percorso modello,
//   prima di qualunque raffinamento successivo in summarizeCubeObservation):
//   e' esattamente lo stadio "osservazioni che arrivano a faceGridFromCorners"
//   richiesto, non uno stadio successivo.
//
// INDICE (definizione esatta): spazio colore Lab (CIE L*a*b*, stesso
// rgbToLab della pipeline). Per ogni detezione, l'omografia proiettiva vera
// (fitHomography sui 4 vertici, non l'approssimazione affine centro+2
// vettori) mappa le coordinate di griglia [-1.5,1.5] ai pixel immagine.
// "Energia riga": gradiente locale (differenza centrale Lab a +-2px in x e
// y, poi norma euclidea) campionato in una fascia di +-0.07 unita' di
// griglia attorno a ciascuna delle 4 linee interne (x=+-0.5 verticali,
// y=+-0.5 orizzontali), lungo tutta la loro lunghezza (coordinata
// perpendicolare da -1.1 a 1.1, passo 0.05). "Energia cella": stesso
// gradiente campionato nel 40% centrale (margine 0.3 unita' di griglia da
// ogni bordo) di ciascuna delle 9 celle. Indice = media(energia riga) /
// max(epsilon, media(energia cella)). Ipotesi: griglia ben posizionata ->
// transizioni di colore concentrate sulle linee -> indice alto; griglia
// storta -> transizioni anche dentro le celle -> indice basso.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ort from 'onnxruntime-node';
import { chromium } from 'playwright';
import { pinnedChromeExecutable } from '../../bench/chrome-path.ts';
import { startStaticServer } from '../../bench/lib/static-server.ts';
import { referenceFromScramble } from '../../bench/lib/score.ts';
import { decodePoseOutput, nonMaxSuppression } from '../inference/pose-decode.ts';
import {
  faceGridFromCorners,
  filterPlausibleDetections,
  type FaceCornerDetection,
} from '../../lib/face-keypoint-model.ts';
import {
  fitHomography,
  applyHomography,
  computeFaceSampleGrid,
  NOMINAL_CORNERS,
  type Point,
} from '../../lib/homography.ts';
import { createAdaptiveColorClassifier, rgbToLab, type RgbSample } from '../../lib/color-calibration.ts';
import { CANONICAL_COLOR_FACE, CUBE_COLORS, type CubeColor, type Face } from '../../lib/cube.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, '../..');
const MODEL_PATH = path.join(WEB_ROOT, 'vision/models/cube-face-keypoints.onnx');
const MODEL_INPUT_SIZE = 512;
const CONF_THRESHOLD = 0.25;
const IOU_THRESHOLD = 0.5;
const ANALYSIS_MAX_DIMENSION = 640; // risoluzione per l'indice geometrico e la classificazione colore (non il modello)
const EXCLUDED_IDS = new Set(['IMG_6281', 'IMG_6297', 'IMG_6338', 'IMG_6260']);
const SEED = 20261009;
const SAMPLE_COUNT = 5;
const SCAN_STEP = 0.5;
const SCAN_START = 1;
const SCAN_END_CAP = 16;

function log(message: string) {
  console.log(`[grid-signal] ${message}`);
}

// mulberry32: PRNG deterministico piccolo, stesso usato altrove nel repo
// (vision/dataset/generate-pass2-crops.ts) per selezioni riproducibili.
function mulberry32(seed: number) {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickSample<T>(candidates: T[], count: number, seed: number): { chosen: T[]; order: T[] } {
  const random = mulberry32(seed);
  const pool = [...candidates];
  const order: T[] = [];
  while (pool.length) {
    const index = Math.floor(random() * pool.length);
    order.push(pool.splice(index, 1)[0]);
  }
  return { chosen: order.slice(0, count), order };
}

// --- indice geometrico: energia del gradiente di colore (Lab), solo pixel ---

function pixelLab(pixels: Uint8ClampedArray, width: number, height: number, x: number, y: number) {
  const clampedX = Math.max(0, Math.min(width - 1, Math.round(x)));
  const clampedY = Math.max(0, Math.min(height - 1, Math.round(y)));
  const offset = (clampedY * width + clampedX) * 4;
  return rgbToLab({ red: pixels[offset], green: pixels[offset + 1], blue: pixels[offset + 2] });
}

function gradientEnergyAt(pixels: Uint8ClampedArray, width: number, height: number, point: Point): number {
  const step = 2;
  const left = pixelLab(pixels, width, height, point.x - step, point.y);
  const right = pixelLab(pixels, width, height, point.x + step, point.y);
  const up = pixelLab(pixels, width, height, point.x, point.y - step);
  const down = pixelLab(pixels, width, height, point.x, point.y + step);
  const dx = Math.hypot(right.lightness - left.lightness, right.a - left.a, right.b - left.b);
  const dy = Math.hypot(down.lightness - up.lightness, down.a - up.a, down.b - up.b);
  return Math.hypot(dx, dy);
}

const LINE_BAND_HALF_WIDTH = 0.07;
const LINE_POSITIONS = [-0.5, 0.5];
const LINE_RANGE_FROM = -1.1;
const LINE_RANGE_TO = 1.1;
const LINE_RANGE_STEP = 0.05;
const CELL_MARGIN = 0.2; // meta' lato del patch centrale campionato in ogni cella (meta' cella = 0.5)
const CELL_STEP = 0.08;

function gridAlignmentIndex(
  keypoints: Point[],
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): number | null {
  const homography = fitHomography(keypoints.map((image, index) => ({ grid: NOMINAL_CORNERS[index], image })));
  if (!homography) return null;

  const lineEnergies: number[] = [];
  LINE_POSITIONS.forEach((linePos) => {
    for (let along = LINE_RANGE_FROM; along <= LINE_RANGE_TO; along += LINE_RANGE_STEP) {
      [-LINE_BAND_HALF_WIDTH, 0, LINE_BAND_HALF_WIDTH].forEach((offset) => {
        const vertical = applyHomography(homography, { x: linePos + offset, y: along });
        const horizontal = applyHomography(homography, { x: along, y: linePos + offset });
        lineEnergies.push(gradientEnergyAt(pixels, width, height, vertical));
        lineEnergies.push(gradientEnergyAt(pixels, width, height, horizontal));
      });
    }
  });

  const cellEnergies: number[] = [];
  for (let row = -1; row <= 1; row += 1) {
    for (let column = -1; column <= 1; column += 1) {
      for (let dx = -CELL_MARGIN; dx <= CELL_MARGIN + 1e-9; dx += CELL_STEP) {
        for (let dy = -CELL_MARGIN; dy <= CELL_MARGIN + 1e-9; dy += CELL_STEP) {
          const gridPoint = applyHomography(homography, { x: column + dx, y: row + dy });
          cellEnergies.push(gradientEnergyAt(pixels, width, height, gridPoint));
        }
      }
    }
  }

  const mean = (values: number[]) => values.reduce((total, value) => total + value, 0) / Math.max(1, values.length);
  const lineEnergy = mean(lineEnergies);
  const cellEnergy = mean(cellEnergies);
  return lineEnergy / Math.max(1e-6, cellEnergy);
}

// --- verita' da scramble, dopo allineamento di rotazione ---

function rotateGrid3x3<T>(colors: T[], turns: number): T[] {
  let result = [...colors];
  for (let turn = 0; turn < turns; turn += 1) {
    const rotated = new Array(9);
    for (let row = 0; row < 3; row += 1) {
      for (let column = 0; column < 3; column += 1) {
        rotated[column * 3 + (2 - row)] = result[row * 3 + column];
      }
    }
    result = rotated;
  }
  return result;
}

function classifyAgainstTruth(
  colors: Array<CubeColor | null>,
  expected: CubeColor[],
): { correct: number; label: 'giusta' | 'sbagliata' | 'esclusa' } {
  let best = 0;
  for (let turns = 0; turns < 4; turns += 1) {
    const rotated = rotateGrid3x3(colors, turns);
    const correct = rotated.reduce((total, color, index) => total + (color === expected[index] ? 1 : 0), 0);
    best = Math.max(best, correct);
  }
  const label = best >= 8 ? 'giusta' : best <= 5 ? 'sbagliata' : 'esclusa';
  return { correct: best, label };
}

// --- statistiche ---

function quartiles(values: number[]) {
  if (!values.length) return { q1: NaN, median: NaN, q3: NaN };
  const sorted = [...values].sort((left, right) => left - right);
  const at = (ratio: number) => {
    const position = ratio * (sorted.length - 1);
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper) return sorted[lower];
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
  };
  return { q1: at(0.25), median: at(0.5), q3: at(0.75) };
}

function auc(positives: number[], negatives: number[]): number {
  if (!positives.length || !negatives.length) return NaN;
  let wins = 0;
  positives.forEach((p) => negatives.forEach((n) => {
    if (p > n) wins += 1;
    else if (p === n) wins += 0.5;
  }));
  return wins / (positives.length * negatives.length);
}

// --- classificazione colore identica a frameSignature/faceGridFromCorners
// per il percorso modello (nessuna calibrazione sui centri: e' lo stadio
// PRIMA del raffinamento successivo in summarizeCubeObservation). Replica i
// 3 controlli di lib/video-decoder.ts:classifyPixelLabel (soglia 0.12-0.88
// del fotogramma, confidenza >=0.16), non esportata perche' privata li'. ---

function classifyPixelLabelLike(
  classify: ReturnType<typeof createAdaptiveColorClassifier>,
  red: number,
  green: number,
  blue: number,
  x: number,
  y: number,
  width: number,
  height: number,
): number {
  if (!(x >= width * 0.12 && x <= width * 0.88 && y >= height * 0.12 && y <= height * 0.88)) return -1;
  const classification = classify({ red, green, blue });
  const color = classification?.color ?? null;
  if (!color || (classification?.confidence ?? 0) < 0.16) return -1;
  return CUBE_COLORS.indexOf(color);
}

function buildAdaptiveClassifier(pixels: Uint8ClampedArray, width: number, height: number) {
  const samples: RgbSample[] = [];
  const step = Math.max(2, Math.floor(Math.min(width, height) / 110));
  for (let y = Math.floor(height * 0.1); y <= Math.ceil(height * 0.9); y += step) {
    for (let x = Math.floor(width * 0.1); x <= Math.ceil(width * 0.9); x += step) {
      const offset = (y * width + x) * 4;
      samples.push({ red: pixels[offset], green: pixels[offset + 1], blue: pixels[offset + 2] });
    }
  }
  return createAdaptiveColorClassifier(samples);
}

function buildLabels(
  detections: FaceCornerDetection[],
  classify: ReturnType<typeof createAdaptiveColorClassifier>,
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): Int8Array {
  const labels = new Int8Array(width * height).fill(-1);
  detections.forEach((detection) => {
    const grid = computeFaceSampleGrid(detection.keypoints);
    if (!grid) return;
    grid.points.forEach((point) => {
      const minX = Math.max(0, Math.round(point.x - grid.sampleRadius));
      const maxX = Math.min(width - 1, Math.round(point.x + grid.sampleRadius));
      const minY = Math.max(0, Math.round(point.y - grid.sampleRadius));
      const maxY = Math.min(height - 1, Math.round(point.y + grid.sampleRadius));
      for (let py = minY; py <= maxY; py += 1) {
        for (let px = minX; px <= maxX; px += 1) {
          const target = py * width + px;
          if (labels[target] !== -1) continue;
          const offset = target * 4;
          const label = classifyPixelLabelLike(classify, pixels[offset], pixels[offset + 1], pixels[offset + 2], px, py, width, height);
          if (label >= 0) labels[target] = label;
        }
      }
    });
  });
  return labels;
}

// --- rilevamento modello (solo passaggio 1, vedi nota in testa al file) ---

async function runDetection(session: ort.InferenceSession, modelPixels: Buffer): Promise<FaceCornerDetection[]> {
  const size = MODEL_INPUT_SIZE * MODEL_INPUT_SIZE;
  const tensor = new Float32Array(3 * size);
  for (let i = 0; i < size; i += 1) {
    const offset = i * 4;
    tensor[i] = modelPixels[offset] / 255;
    tensor[size + i] = modelPixels[offset + 1] / 255;
    tensor[2 * size + i] = modelPixels[offset + 2] / 255;
  }
  const inputName = session.inputNames[0];
  const input = new ort.Tensor('float32', tensor, [1, 3, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE]);
  const results = await session.run({ [inputName]: input });
  const output = results[session.outputNames[0]];
  const [, channels, numAnchors] = output.dims as [number, number, number];
  const numKeypoints = (channels - 5) / 3;
  const raw = decodePoseOutput(output.data as Float32Array, numAnchors, numKeypoints, CONF_THRESHOLD);
  const kept = nonMaxSuppression(raw, IOU_THRESHOLD);
  return kept.map((detection) => ({
    score: detection.score,
    keypoints: detection.keypoints.map((kp) => ({ x: kp.x, y: kp.y })),
  }));
}

type FrameCapture = {
  srcWidth: number; srcHeight: number;
  fullWidth: number; fullHeight: number; fullPixelsBase64: string;
  modelScale: number; modelPadX: number; modelPadY: number; modelPixelsBase64: string;
};

async function captureFrame(
  page: import('playwright').Page,
  time: number,
): Promise<FrameCapture> {
  return page.evaluate(({ time: seekTime, analysisMax, modelSize }) => {
    function toBase64(data: Uint8ClampedArray): string {
      let binary = '';
      const chunkSize = 8192;
      for (let i = 0; i < data.length; i += chunkSize) {
        binary += String.fromCharCode(...data.subarray(i, Math.min(data.length, i + chunkSize)));
      }
      return btoa(binary);
    }
    const video = (window as unknown as { __video: HTMLVideoElement }).__video;
    return new Promise<FrameCapture>((resolve) => {
      const onSeeked = () => {
        video.removeEventListener('seeked', onSeeked);
        const srcWidth = video.videoWidth;
        const srcHeight = video.videoHeight;

        const analysisScale = Math.min(1, analysisMax / Math.max(srcWidth, srcHeight));
        const fullWidth = Math.round(srcWidth * analysisScale);
        const fullHeight = Math.round(srcHeight * analysisScale);
        const fullCanvas = document.createElement('canvas');
        fullCanvas.width = fullWidth;
        fullCanvas.height = fullHeight;
        const fullCtx = fullCanvas.getContext('2d')!;
        fullCtx.drawImage(video, 0, 0, fullWidth, fullHeight);
        const fullPixelsBase64 = toBase64(fullCtx.getImageData(0, 0, fullWidth, fullHeight).data);

        const modelScale = Math.min(modelSize / srcWidth, modelSize / srcHeight);
        const newW = Math.round(srcWidth * modelScale);
        const newH = Math.round(srcHeight * modelScale);
        const modelPadX = Math.floor((modelSize - newW) / 2);
        const modelPadY = Math.floor((modelSize - newH) / 2);
        const modelCanvas = document.createElement('canvas');
        modelCanvas.width = modelSize;
        modelCanvas.height = modelSize;
        const modelCtx = modelCanvas.getContext('2d')!;
        modelCtx.fillStyle = 'rgb(114,114,114)';
        modelCtx.fillRect(0, 0, modelSize, modelSize);
        modelCtx.drawImage(video, modelPadX, modelPadY, newW, newH);
        const modelPixelsBase64 = toBase64(modelCtx.getImageData(0, 0, modelSize, modelSize).data);

        resolve({ srcWidth, srcHeight, fullWidth, fullHeight, fullPixelsBase64, modelScale, modelPadX, modelPadY, modelPixelsBase64 });
      };
      video.addEventListener('seeked', onSeeked);
      video.currentTime = seekTime;
    });
  }, { time, analysisMax: ANALYSIS_MAX_DIMENSION, modelSize: MODEL_INPUT_SIZE });
}

type Row = {
  videoId: string; face: Face; time: number; correct: number;
  label: 'giusta' | 'sbagliata' | 'esclusa'; index: number | null;
  detectionScore: number;
};

async function main() {
  const casesRaw = JSON.parse(fs.readFileSync(path.join(WEB_ROOT, 'bench/cases.json'), 'utf8'));
  const videoDir = process.env.BENCH_VIDEO_DIR || casesRaw.videoDir;
  const candidates = (casesRaw.cases as Array<{ id: string }>).filter((c) => !EXCLUDED_IDS.has(c.id));
  const { chosen, order } = pickSample(candidates, SAMPLE_COUNT, SEED);

  log(`seed=${SEED}`);
  log(`candidati esclusi: ${[...EXCLUDED_IDS].join(', ')}`);
  log(`ordine di selezione (mulberry32): ${order.map((c) => (c as { id: string }).id).join(', ')}`);
  log(`video scelti: ${chosen.map((c) => (c as { id: string }).id).join(', ')}`);

  const session = await ort.InferenceSession.create(MODEL_PATH);
  const videoServer = await startStaticServer(videoDir);
  const browser = await chromium.launch({ executablePath: pinnedChromeExecutable(), headless: true });
  const page = await browser.newPage();
  await page.setContent('<!doctype html><html><body></body></html>');

  const allRows: Row[] = [];

  try {
    for (const entry of chosen as Array<{ id: string; video: string; scramble: string }>) {
      log(`=== ${entry.id} ===`);
      const expected = referenceFromScramble(entry.scramble);
      const videoUrl = `http://127.0.0.1:${videoServer.port}/${entry.video}`;
      const duration: number = await page.evaluate((url) => {
        const video = document.createElement('video');
        video.src = url;
        video.crossOrigin = 'anonymous';
        video.muted = true;
        (window as unknown as { __video?: HTMLVideoElement }).__video = video;
        document.body.appendChild(video);
        return new Promise<number>((resolve, reject) => {
          video.addEventListener('loadeddata', () => resolve(video.duration), { once: true });
          video.addEventListener('error', () => reject(new Error('video error')), { once: true });
        });
      }, videoUrl);

      const scanEnd = Math.min(duration - 0.5, SCAN_END_CAP);
      let videoRows = 0;
      let videoTimestamps = 0;

      for (let time = SCAN_START; time <= scanEnd; time += SCAN_STEP) {
        videoTimestamps += 1;
        const frame = await captureFrame(page, time);
        const fullBuffer = Buffer.from(frame.fullPixelsBase64, 'base64');
        const fullPixels = new Uint8ClampedArray(fullBuffer.buffer, fullBuffer.byteOffset, fullBuffer.byteLength);
        const modelPixels = Buffer.from(frame.modelPixelsBase64, 'base64');

        const rawDetections = await runDetection(session, modelPixels);
        const analysisScale = frame.fullWidth / frame.srcWidth;
        const detectionsAnalysisSpace: FaceCornerDetection[] = rawDetections.map((detection) => ({
          score: detection.score,
          keypoints: detection.keypoints.map((kp) => ({
            x: ((kp.x - frame.modelPadX) / frame.modelScale) * analysisScale,
            y: ((kp.y - frame.modelPadY) / frame.modelScale) * analysisScale,
          })),
        }));
        const plausible = filterPlausibleDetections(detectionsAnalysisSpace);
        if (!plausible.length) continue;

        const classify = buildAdaptiveClassifier(fullPixels, frame.fullWidth, frame.fullHeight);
        const labels = buildLabels(plausible, classify, fullPixels, frame.fullWidth, frame.fullHeight);

        plausible.forEach((detection) => {
          const observation = faceGridFromCorners(detection, labels, frame.fullWidth, frame.fullHeight, fullPixels);
          if (!observation || !observation.centerColor) return;
          const face = CANONICAL_COLOR_FACE[observation.centerColor];
          const { correct, label } = classifyAgainstTruth(observation.colors, expected[face]);
          const index = gridAlignmentIndex(detection.keypoints, fullPixels, frame.fullWidth, frame.fullHeight);
          allRows.push({ videoId: entry.id, face, time, correct, label, index, detectionScore: detection.score });
          videoRows += 1;
        });
      }

      log(`  ${entry.id}: ${videoTimestamps} fotogrammi campionati, ${videoRows} osservazioni valide`);
    }
  } finally {
    await browser.close();
    videoServer.close();
  }

  // --- report ---
  const withIndex = allRows.filter((row) => row.index !== null) as Array<Row & { index: number }>;
  const videoIds = [...new Set(allRows.map((row) => row.videoId))];

  function reportGroup(label: string, rows: Array<Row & { index: number }>) {
    const giusta = rows.filter((r) => r.label === 'giusta').map((r) => r.index);
    const sbagliata = rows.filter((r) => r.label === 'sbagliata').map((r) => r.index);
    const esclusa = rows.filter((r) => r.label === 'esclusa').length;
    const qg = quartiles(giusta);
    const qs = quartiles(sbagliata);
    const groupAuc = auc(giusta, sbagliata);
    log(`--- ${label} ---`);
    log(`  giuste=${giusta.length} sbagliate=${sbagliata.length} escluse=${esclusa}`);
    log(`  indice giuste    Q1=${qg.q1.toFixed(3)} mediana=${qg.median.toFixed(3)} Q3=${qg.q3.toFixed(3)}`);
    log(`  indice sbagliate Q1=${qs.q1.toFixed(3)} mediana=${qs.median.toFixed(3)} Q3=${qs.q3.toFixed(3)}`);
    log(`  AUC=${Number.isNaN(groupAuc) ? 'n/d (gruppo vuoto)' : groupAuc.toFixed(3)}`);
    return groupAuc;
  }

  videoIds.forEach((id) => reportGroup(id, withIndex.filter((row) => row.videoId === id)));
  const totalAuc = reportGroup('TOTALE', withIndex);

  log(`AUC totale = ${totalAuc.toFixed(3)}`);
  if (totalAuc >= 0.8) {
    log('Interpretazione: segnale promettente (AUC totale >=0.80) - verificare sopra se >=0.70 anche in ogni video.');
  } else if (totalAuc >= 0.65) {
    log('Interpretazione: segnale debole (AUC totale fra 0.65 e 0.80, o buono solo in alcuni video).');
  } else {
    log('Interpretazione: pista chiusa (AUC totale <0.65).');
  }

  // --- verifiche richieste ---
  log('=== VERIFICHE ===');

  log('1. Indipendenza: gridAlignmentIndex(keypoints, pixels, width, height) usa solo');
  log('   fitHomography/applyHomography (geometria dai 4 vertici) e rgbToLab sui pixel');
  log('   grezzi del fotogramma raddrizzato dall\'omografia. Non riceve in input colors,');
  log('   centerColor, confidence, cellConfidences, rawColors, né alcun dato di fusione/');
  log('   ricostruzione: SI, verificato per firma della funzione (vedi file), non solo a parole.');

  log('2. Composizione delle sbagliate (proxy: correct 0-3="lontana", 4-5="vicina" - nessuna');
  log('   etichetta spuria a mano disponibile, questa e\' una soglia sul conteggio celle');
  log('   corrette gia\' calcolato, non un nuovo giudizio visivo):');
  const giustaRows = withIndex.filter((r) => r.label === 'giusta');
  const giustaIdx = giustaRows.map((r) => r.index);
  const vicina = withIndex.filter((r) => r.label === 'sbagliata' && r.correct >= 4);
  const lontana = withIndex.filter((r) => r.label === 'sbagliata' && r.correct <= 3);
  const medianScore = (rows: Row[]) => quartiles(rows.map((r) => r.detectionScore)).median;
  log(`   (contesto) giuste: n=${giustaRows.length}, detection.score mediana=${medianScore(giustaRows).toFixed(3)}`);
  log(`   vicina (4-5/9, prob. faccia vera spostata): n=${vicina.length}, detection.score mediana=${medianScore(vicina).toFixed(3)}, AUC(giusta vs vicina)=${auc(giustaIdx, vicina.map((r) => r.index)).toFixed(3)}`);
  log(`   lontana (0-3/9, prob. rilevamento spurio o lettura molto sbagliata): n=${lontana.length}, detection.score mediana=${medianScore(lontana).toFixed(3)}, AUC(giusta vs lontana)=${auc(giustaIdx, lontana.map((r) => r.index)).toFixed(3)}`);

  log('3. Ridondanza: filterPlausibleDetections e il gate "visibleCells>=6 && centerColor" di');
  log('   faceGridFromCorners sono applicati PRIMA di registrare qualunque riga (vedi il');
  log('   flusso: plausible=filterPlausibleDetections(...); poi faceGridFromCorners ritorna');
  log('   null se uno dei due gate non passa, e solo allora la riga entra in allRows).');
  log('   Quindi 0 osservazioni registrate verrebbero scartate da questi due filtri: l\'AUC');
  log('   "solo su quelle che arrivano alla fusione" e\' la STESSA gia\' riportata sopra.');

  log('4. Sbilanciamento per video (soglia: meno di 10 giuste O meno di 10 sbagliate):');
  videoIds.forEach((id) => {
    const rows = withIndex.filter((r) => r.videoId === id);
    const g = rows.filter((r) => r.label === 'giusta').length;
    const s = rows.filter((r) => r.label === 'sbagliata').length;
    const flag = g < 10 || s < 10 ? 'SI - AUC di questo video non affidabile' : 'no';
    log(`   ${id}: giuste=${g} sbagliate=${s} -> sbilanciato: ${flag}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
