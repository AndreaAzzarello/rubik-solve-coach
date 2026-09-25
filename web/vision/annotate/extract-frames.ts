// Step 1 del flusso di annotazione reale: estrae fotogrammi candidati dai
// video bench (IMG_6107/IMG_6108), poi ne tiene un sottoinsieme diversificato
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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, 'frames');
const VIDEO_DIR = process.env.BENCH_VIDEO_DIR || 'C:/Users/Andrea/Desktop/App/lenti';

const CASES = ['IMG_6107', 'IMG_6108'];
const CANDIDATE_STEP_SEC = 0.2;
const SELECTED_PER_VIDEO = 110;
const HELD_OUT_PER_VIDEO = 15;
const MAX_DIMENSION = 960;
const START_MARGIN_SEC = 1;
const END_MARGIN_SEC = 1;

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

type FrameEntry = { id: string; video: string; time: number; split: 'train' | 'val' };

async function extractForVideo(page: Page, videoUrl: string, caseId: string): Promise<FrameEntry[]> {
  const { duration } = await page.evaluate(ensureVideoLoaded, { url: videoUrl });
  const start = START_MARGIN_SEC;
  const end = Math.max(start + 1, duration - END_MARGIN_SEC);
  console.log(`[${caseId}] durata ${duration.toFixed(1)}s, campiono ${start.toFixed(2)}s - ${end.toFixed(2)}s`);
  const candidateTimes: number[] = [];
  for (let t = start; t <= end; t += CANDIDATE_STEP_SEC) candidateTimes.push(t);

  const signatures: number[][] = [];
  for (let i = 0; i < candidateTimes.length; i += 1) {
    signatures.push(await page.evaluate(captureThumbnail, { time: candidateTimes[i] }));
  }
  console.log(`[${caseId}] ${candidateTimes.length} candidati, seleziono i ${SELECTED_PER_VIDEO} piu' diversi...`);

  const selectedIndices = selectDiverse(signatures, SELECTED_PER_VIDEO);
  const entries: FrameEntry[] = [];
  for (let i = 0; i < selectedIndices.length; i += 1) {
    const time = candidateTimes[selectedIndices[i]];
    const dataUrl = await page.evaluate(captureFullFrame, { time, maxDimension: MAX_DIMENSION });
    const base64 = dataUrl.replace(/^data:image\/jpeg;base64,/, '');
    const id = `${caseId}-${String(i).padStart(3, '0')}`;
    fs.writeFileSync(path.join(OUT_DIR, `${id}.jpg`), Buffer.from(base64, 'base64'));
    // Held-out spaziato uniformemente sugli indici selezionati (non sugli
    // ultimi in ordine temporale): copre l'intera finestra, non solo la coda.
    const isHeldOut = i % Math.round(SELECTED_PER_VIDEO / HELD_OUT_PER_VIDEO) === 0
      && entries.filter((e) => e.split === 'val').length < HELD_OUT_PER_VIDEO;
    entries.push({ id, video: caseId, time, split: isHeldOut ? 'val' : 'train' });
  }
  console.log(`[${caseId}] estratti ${entries.length} fotogrammi (${entries.filter((e) => e.split === 'val').length} val)`);
  return entries;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const videoServer = await startStaticServer(VIDEO_DIR);

  const browser = await chromium.launch({ executablePath: pinnedChromeExecutable(), headless: true });
  const capturePage = await browser.newPage();
  await capturePage.setContent('<!doctype html><html><body></body></html>');

  const allEntries: FrameEntry[] = [];
  for (const caseId of CASES) {
    const videoUrl = `http://127.0.0.1:${videoServer.port}/${caseId}.mp4`;
     
    const entries = await extractForVideo(capturePage, videoUrl, caseId);
    allEntries.push(...entries);
  }

  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(allEntries, null, 2));

  await browser.close();
  videoServer.close();

  const trainCount = allEntries.filter((e) => e.split === 'train').length;
  const valCount = allEntries.filter((e) => e.split === 'val').length;
  console.log(`\ntotale ${allEntries.length} fotogrammi (${trainCount} train, ${valCount} val) in ${OUT_DIR}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
