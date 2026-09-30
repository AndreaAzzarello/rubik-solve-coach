// Step 1 del flusso di annotazione reale: estrae fotogrammi candidati dai
// video di training (CASES sotto), poi ne tiene un sottoinsieme diversificato
// (troppi fotogrammi quasi identici, cubo fermo, sprecherebbero lavoro di
// annotazione senza aggiungere variazione vera di angolo/luce/occlusione).
//
// Deliberatamente NON usa la finestra di ispezione di
// reconstructInspectionFromVideo (prima versione di questo script): quel
// concetto ("prima della prima mossa") serve al bench per misurare
// l'accuratezza a freddo, ma qui non c'entra - un rilevatore di keypoint
// geometrici non sa ne' gli importa se il cubo e' in fase di ispezione o di
// risoluzione, gli serve solo vedere una faccia. Su IMG_6108 quella finestra
// si e' rivelata anche un caso limite della segmentazione automatica (1.1s
// individuati invece di essere rappresentativa), che avrebbe dato solo 6
// fotogrammi utilizzabili invece di ~110: campioniamo l'intero video.
//
//   node --experimental-strip-types vision/annotate/extract-frames.ts

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';
import { pinnedChromeExecutable } from '../../bench/chrome-path.ts';
import { startStaticServer } from '../../bench/lib/static-server.ts';
import { filterPlausibleDetections } from '../../lib/face-keypoint-model.ts';
import { FaceKeypointDetector } from '../inference/detector.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, 'frames');
const LABELS_DIR = path.join(HERE, 'labels');
const VIDEO_DIR = process.env.BENCH_VIDEO_DIR || 'C:/Users/Andrea/Desktop/App/lenti';

// EXTRACT_MODE=test estrae per la VALUTAZIONE PCK, non per il training:
// split forzato a 'test', mai letto da merge-real-annotations.ts (che scarta
// esplicitamente questo split) quindi non puo' finire nel dataset. Video di
// default: IMG_6258/6260/6281, i casi di test del bench - MAI training.
const EXTRACT_MODE = process.env.EXTRACT_MODE === 'test' ? 'test' : 'train';
const CASES = process.env.EXTRACT_CASES
  ? process.env.EXTRACT_CASES.split(',')
  : EXTRACT_MODE === 'test'
    ? ['IMG_6258', 'IMG_6260', 'IMG_6281']
    : ['IMG_6297', 'IMG_6298', 'IMG_6299', 'IMG_6300'];
const CANDIDATE_STEP_SEC = 0.2;
const SELECTED_PER_VIDEO = EXTRACT_MODE === 'test' ? 15 : 25;
const HELD_OUT_PER_VIDEO = EXTRACT_MODE === 'test' ? 0 : 3;
const MAX_DIMENSION = 960;
const START_MARGIN_SEC = 1;
const END_MARGIN_SEC = 1;
// train: selezione attiva invece di uniforme (vedi extractForVideo). Distanza
// minima fra fotogrammi scelti, per non concentrarli tutti nello stesso
// istante di incertezza (es. un unico gesto rapido).
const MIN_SELECTED_GAP_SEC = 0.4;
const MODEL_PATH = path.join(HERE, '..', 'models', 'cube-face-keypoints.onnx');

// Guardia strutturale, non solo convenzione: questi 3 sono i casi di test del
// bench (bench/cases.json) - non devono MAI entrare nel training, qualunque
// sia la fonte di CASES (default o EXTRACT_CASES).
const NEVER_IN_TRAINING = ['IMG_6258', 'IMG_6260', 'IMG_6281'];
if (EXTRACT_MODE === 'train') {
  const forbidden = CASES.filter((id) => NEVER_IN_TRAINING.includes(id));
  if (forbidden.length) {
    throw new Error(`${forbidden.join(', ')}: video di test, mai in training. Rimuovili da EXTRACT_CASES o usa EXTRACT_MODE=test.`);
  }
}

// --- funzioni eseguite in-browser (page.evaluate): autocontenute, nessuna
// chiusura esterna. Il <video> resta in window tra una chiamata e l'altra
// della STESSA pagina, cosi' il seek ripetuto (100+ volte per video) non deve
// ricaricare la sorgente ogni volta. ---

declare global {
  interface Window {
    __annotateVideo?: HTMLVideoElement;
    __annotateVideoUrl?: string;
    __annotateSeek?: (time: number) => Promise<void>;
  }
}

async function ensureVideoLoaded(args: { url: string }): Promise<{ width: number; height: number; duration: number }> {
  if (window.__annotateVideoUrl !== args.url) {
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = args.url;
    await new Promise<void>((resolve, reject) => {
      const onReady = () => {
        if (video.readyState >= 2 && Number.isFinite(video.duration) && video.duration > 0) resolve();
      };
      video.addEventListener('loadeddata', onReady);
      video.addEventListener('canplay', onReady);
      video.addEventListener('error', () => reject(new Error(`impossibile caricare ${args.url}`)));
      onReady();
    });
    window.__annotateVideo = video;
    window.__annotateVideoUrl = args.url;
    // Definita qui (non a livello di modulo): page.evaluate serializza solo
    // il testo della funzione passata, senza le funzioni esterne a cui fa
    // riferimento - deve restare raggiungibile da window tra una evaluate e
    // l'altra della stessa pagina.
    window.__annotateSeek = async (time: number) => {
      const target = Math.min(video.duration - 0.01, Math.max(0, time));
      if (Math.abs(video.currentTime - target) < 0.005) return;
      await new Promise<void>((resolve) => {
        const done = () => { video.removeEventListener('seeked', done); resolve(); };
        video.addEventListener('seeked', done);
        video.currentTime = target;
      });
    };
  }
  const video = window.__annotateVideo!;
  return { width: video.videoWidth, height: video.videoHeight, duration: video.duration };
}

async function captureThumbnail(args: { time: number }): Promise<number[]> {
  await window.__annotateSeek!(args.time);
  const video = window.__annotateVideo!;
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 16;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(video, 0, 0, 16, 16);
  const data = ctx.getImageData(0, 0, 16, 16).data;
  const gray: number[] = [];
  for (let i = 0; i < data.length; i += 4) gray.push((data[i] + data[i + 1] + data[i + 2]) / 3);
  return gray;
}

async function captureFullFrame(args: { time: number; maxDimension: number }): Promise<string> {
  await window.__annotateSeek!(args.time);
  const video = window.__annotateVideo!;
  const scale = Math.min(1, args.maxDimension / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.92);
}

// --- lato Node: selezione a diversita' massima (farthest-point greedy) ---

function euclidean(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
}

function selectDiverse(signatures: number[][], count: number): number[] {
  if (signatures.length <= count) return signatures.map((_, i) => i);
  const selected = [Math.floor(signatures.length / 2)];
  const minDistances = signatures.map((sig) => euclidean(sig, signatures[selected[0]]));
  while (selected.length < count) {
    let bestIndex = -1;
    let bestDistance = -1;
    minDistances.forEach((distance, index) => {
      if (selected.includes(index)) return;
      if (distance > bestDistance) { bestDistance = distance; bestIndex = index; }
    });
    selected.push(bestIndex);
    signatures.forEach((sig, index) => {
      const d = euclidean(sig, signatures[bestIndex]);
      if (d < minDistances[index]) minDistances[index] = d;
    });
  }
  return selected.sort((a, b) => a - b);
}

type FrameEntry = { id: string; video: string; time: number; split: 'train' | 'val' | 'test' };
type PlausibleDetection = { score: number; keypoints: Array<{ x: number; y: number }> };

function bestScoring(list: PlausibleDetection[]): PlausibleDetection | null {
  return list.length ? list.reduce((a, b) => (b.score > a.score ? b : a)) : null;
}

// Incertezza per candidato: alta se il modello non trova nulla o e' poco
// sicuro, alta anche se i vertici "saltano" molto rispetto al fotogramma
// immediatamente prima/dopo (instabilita' temporale) - questi due segnali
// insieme individuano i casi davvero difficili (sfocato, occluso, angolo
// scomodo), non solo genericamente diversi come faceva selectDiverse.
function estimateUncertainty(detectionsByCandidate: PlausibleDetection[][], maxDimension: number): number[] {
  return detectionsByCandidate.map((detections, i) => {
    const best = bestScoring(detections);
    if (!best) return 1;
    const avgScore = detections.reduce((sum, d) => sum + d.score, 0) / detections.length;
    const neighborIndices = [i - 1, i + 1].filter((j) => j >= 0 && j < detectionsByCandidate.length);
    const jitters = neighborIndices.map((j) => {
      const neighbor = bestScoring(detectionsByCandidate[j]);
      if (!neighbor) return 0;
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += Math.hypot(best.keypoints[k].x - neighbor.keypoints[k].x, best.keypoints[k].y - neighbor.keypoints[k].y);
      return (sum / 4) / maxDimension;
    });
    const jitter = jitters.length ? Math.max(...jitters) : 0;
    return 0.5 * (1 - avgScore) + 0.5 * Math.min(1, jitter * 4);
  });
}

// Greedy per incertezza decrescente, scartando candidati troppo vicini nel
// tempo a uno gia' scelto (altrimenti un singolo tratto instabile del video
// monopolizzerebbe l'intera selezione).
function selectUncertain(times: number[], uncertainty: number[], count: number): number[] {
  const order = times.map((_, i) => i).sort((a, b) => uncertainty[b] - uncertainty[a]);
  const picked: number[] = [];
  for (const index of order) {
    if (picked.length >= count) break;
    if (picked.some((j) => Math.abs(times[j] - times[index]) < MIN_SELECTED_GAP_SEC)) continue;
    picked.push(index);
  }
  return picked.sort((a, b) => a - b);
}

// Prossimo indice libero per questo video, in base agli id gia' nel
// manifest: una ri-estrazione dello stesso video continua da dove aveva
// lasciato invece di ripartire da -000 (che sovrascriverebbe fotogrammi ed
// etichette esistenti, ore di annotazione manuale).
export function nextSafeIndex(existingIds: string[], caseId: string): number {
  const prefix = `${caseId}-`;
  let max = -1;
  for (const id of existingIds) {
    if (!id.startsWith(prefix)) continue;
    const suffix = id.slice(prefix.length);
    if (!/^\d+$/.test(suffix)) continue;
    max = Math.max(max, parseInt(suffix, 10));
  }
  return max + 1;
}

// Ultima rete di sicurezza, indipendente dal manifest (che potrebbe essere
// disallineato dal disco): controlla i file veri prima di scrivere. Non
// sovrascrive mai, fallisce rumorosamente invece.
export function assertFrameIdAvailable(id: string, framesDir: string, labelsDir: string): void {
  const conflicts = [
    path.join(framesDir, `${id}.jpg`),
    path.join(labelsDir, `${id}.json`),
    path.join(labelsDir, `${id}.txt`),
  ].filter((candidate) => fs.existsSync(candidate));
  if (conflicts.length) {
    throw new Error(`collisione id ${id}: esiste gia' ${conflicts.join(', ')} - l'estrazione non sovrascrive mai file esistenti`);
  }
}

async function extractForVideo(
  page: Page,
  videoUrl: string,
  caseId: string,
  detector: FaceKeypointDetector | null,
  existingIds: string[],
): Promise<FrameEntry[]> {
  const { duration } = await page.evaluate(ensureVideoLoaded, { url: videoUrl });
  const start = START_MARGIN_SEC;
  const end = Math.max(start + 1, duration - END_MARGIN_SEC);
  console.log(`[${caseId}] durata ${duration.toFixed(1)}s, campiono ${start.toFixed(2)}s - ${end.toFixed(2)}s`);
  const candidateTimes: number[] = [];
  for (let t = start; t <= end; t += CANDIDATE_STEP_SEC) candidateTimes.push(t);

  let selectedIndices: number[];
  // Riusate per i candidati gia' catturati a piena risoluzione in modalita'
  // incertezza, per non ricatturarli una seconda volta piu' sotto.
  const capturedDataUrls: Array<string | undefined> = [];

  if (detector) {
    console.log(`[${caseId}] ${candidateTimes.length} candidati, valuto l'incertezza del modello su ciascuno...`);
    const detectionsByCandidate: PlausibleDetection[][] = [];
    for (let i = 0; i < candidateTimes.length; i += 1) {
      const dataUrl = await page.evaluate(captureFullFrame, { time: candidateTimes[i], maxDimension: MAX_DIMENSION });
      capturedDataUrls[i] = dataUrl;
      const raw = await detector.detectFromImageUrl(dataUrl);
      detectionsByCandidate.push(filterPlausibleDetections(
        raw.map((d) => ({ score: d.score, keypoints: d.keypoints.map(({ x, y }) => ({ x, y })) })),
      ));
    }
    const uncertainty = estimateUncertainty(detectionsByCandidate, MAX_DIMENSION);
    selectedIndices = selectUncertain(candidateTimes, uncertainty, SELECTED_PER_VIDEO);
    const avgPicked = selectedIndices.reduce((sum, i) => sum + uncertainty[i], 0) / Math.max(1, selectedIndices.length);
    console.log(`[${caseId}] selezionati ${selectedIndices.length} per incertezza (media ${avgPicked.toFixed(2)} su scala 0-1, piu' alto = piu' incerto)`);
  } else {
    const signatures: number[][] = [];
    for (let i = 0; i < candidateTimes.length; i += 1) {
      signatures.push(await page.evaluate(captureThumbnail, { time: candidateTimes[i] }));
    }
    console.log(`[${caseId}] ${candidateTimes.length} candidati, seleziono i ${SELECTED_PER_VIDEO} piu' diversi...`);
    selectedIndices = selectDiverse(signatures, SELECTED_PER_VIDEO);
  }

  const startIndex = nextSafeIndex(existingIds, caseId);
  if (startIndex > 0) console.log(`[${caseId}] ${startIndex} fotogrammi gia' presenti, continuo da -${String(startIndex).padStart(3, '0')}`);

  const entries: FrameEntry[] = [];
  for (let i = 0; i < selectedIndices.length; i += 1) {
    const time = candidateTimes[selectedIndices[i]];
    const dataUrl = capturedDataUrls[selectedIndices[i]]
      ?? await page.evaluate(captureFullFrame, { time, maxDimension: MAX_DIMENSION });
    const base64 = dataUrl.replace(/^data:image\/jpeg;base64,/, '');
    const id = `${caseId}-${String(startIndex + i).padStart(3, '0')}`;
    assertFrameIdAvailable(id, OUT_DIR, LABELS_DIR);
    fs.writeFileSync(path.join(OUT_DIR, `${id}.jpg`), Buffer.from(base64, 'base64'));
    let split: FrameEntry['split'] = 'train';
    if (EXTRACT_MODE === 'test') {
      split = 'test';
    } else {
      // Held-out spaziato uniformemente sugli indici selezionati (non sugli
      // ultimi in ordine temporale): copre l'intera finestra, non solo la coda.
      const isHeldOut = i % Math.round(SELECTED_PER_VIDEO / HELD_OUT_PER_VIDEO) === 0
        && entries.filter((e) => e.split === 'val').length < HELD_OUT_PER_VIDEO;
      split = isHeldOut ? 'val' : 'train';
    }
    entries.push({ id, video: caseId, time, split });
  }
  console.log(`[${caseId}] estratti ${entries.length} fotogrammi (${entries.filter((e) => e.split === 'val').length} val, ${entries.filter((e) => e.split === 'test').length} test)`);
  return entries;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Caricato PRIMA di estrarre: serve a nextSafeIndex per non riassegnare id
  // gia' usati (vedi anche assertFrameIdAvailable, che controlla i file
  // veri indipendentemente da questo elenco).
  const manifestPath = path.join(OUT_DIR, 'manifest.json');
  const existing: FrameEntry[] = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : [];
  const existingIds = existing.map((entry) => entry.id);

  const videoServer = await startStaticServer(VIDEO_DIR);

  const browser = await chromium.launch({ executablePath: pinnedChromeExecutable(), headless: true });
  const capturePage = await browser.newPage();
  await capturePage.setContent('<!doctype html><html><body></body></html>');

  // Selezione attiva (train) vs diversita' uniforme (test): il detector
  // serve solo alla prima, non ha senso caricarlo per l'altra.
  const detector = EXTRACT_MODE === 'train' ? await FaceKeypointDetector.create(MODEL_PATH) : null;
  if (detector) console.log('modello di rilevamento facce caricato (selezione per incertezza)');

  const allEntries: FrameEntry[] = [];
  for (const caseId of CASES) {
    const videoUrl = `http://127.0.0.1:${videoServer.port}/${caseId}.mp4`;

    const entries = await extractForVideo(capturePage, videoUrl, caseId, detector, existingIds);
    allEntries.push(...entries);
  }

  if (detector) await detector.close();

  // Additivo, non sovrascrive: manifest.json puo' gia' contenere fotogrammi
  // di video estratti in run precedenti (es. IMG_6107/6108), con annotazioni
  // gia' fatte che riferiscono quegli id.
  fs.writeFileSync(manifestPath, JSON.stringify([...existing, ...allEntries], null, 2));

  await browser.close();
  videoServer.close();

  const trainCount = allEntries.filter((e) => e.split === 'train').length;
  const valCount = allEntries.filter((e) => e.split === 'val').length;
  console.log(`\ntotale ${allEntries.length} fotogrammi (${trainCount} train, ${valCount} val) in ${OUT_DIR}`);
}

// Guardia: gira solo se eseguito direttamente (node extract-frames.ts), non
// quando il file viene importato (es. dal test, per le funzioni pure sopra) -
// altrimenti un semplice `import` lancerebbe l'intera estrazione.
const isMainModule = path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] ?? '');
if (isMainModule) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
