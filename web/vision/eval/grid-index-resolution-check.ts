// Verifica di coerenza (nessuna modifica a produzione): la diagnosi
// dell'esperimento #10 (vision/eval/grid-alignment-signal.ts) calcola
// gridAlignmentIndex su un fotogramma intero a 640px; la produzione
// (lib/video-decoder.ts, readHighResolutionInspectionFrame) lo calcola sul
// canvas "analysis" a 320px (ritratto) o 480px (orizzontale), spesso
// RITAGLIATO (inspectionCropVariants - fino a 3 ritagli per fotogramma,
// condividono la stessa detection ma hanno risoluzione/ritaglio diversi).
// Questo script isola la SOLA variabile risoluzione/ritaglio: stessi
// vertici nativi, stessi pixel nativi, mappati nei 4 spazi (diagnosi +
// 3 ritagli di produzione) con l'IDENTICA formula di produzione
// (mapModelPointToAnalysisSpace), poi calcola gridAlignmentIndex (la
// stessa funzione reale di produzione, lib/grid-alignment-index.ts) in
// ciascuno spazio e confronta.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ort from 'onnxruntime-node';
import { chromium } from 'playwright';
import { pinnedChromeExecutable } from '../../bench/chrome-path.ts';
import { startStaticServer } from '../../bench/lib/static-server.ts';
import { decodePoseOutput, nonMaxSuppression } from '../inference/pose-decode.ts';
import { filterPlausibleDetections, type FaceCornerDetection } from '../../lib/face-keypoint-model.ts';
import { gridAlignmentIndex } from '../../lib/grid-alignment-index.ts';
import { inspectionCropVariants, mapModelPointToAnalysisSpace } from '../../lib/video-decoder.ts';
import type { Point } from '../../lib/homography.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, '../..');
const MODEL_PATH = path.join(WEB_ROOT, 'vision/models/cube-face-keypoints.onnx');
const MODEL_INPUT_SIZE = 512;
const MODEL_FRAME_MAX_DIMENSION = 960; // stessa costante privata di lib/video-decoder.ts
const CONF_THRESHOLD = 0.25;
const IOU_THRESHOLD = 0.5;
const ANALYSIS_MAX_DIMENSION = 640; // stessa costante della diagnosi (grid-alignment-signal.ts)
const VIDEO_IDS = process.env.RESOLUTION_CHECK_VIDEOS
  ? process.env.RESOLUTION_CHECK_VIDEOS.split(',')
  : ['IMG_6334', 'IMG_6258'];
const TIMESTAMPS = [2, 3, 4, 5, 6, 7, 8];

// Le 4 osservazioni "giuste" esatte di IMG_6334 misurate dalla diagnosi
// (vision/eval/grid-alignment-signal.ts, DEBUG_ROWS_VIDEO=IMG_6334): vertici
// nello spazio 640px-senza-ritaglio della diagnosi, indice gia' noto per
// verifica di coerenza. Mediana di questi 4 indici = 8.904 (combacia col
// report della diagnosi).
const GIUSTE_6334: Array<{ time: number; diagnosticKeypoints: Point[]; knownDiagnosticIndex: number }> = [
  { time: 2, knownDiagnosticIndex: 3.994, diagnosticKeypoints: [
    { x: 147.9936408996582, y: 333.3628845214844 }, { x: 212.66998291015625, y: 321.06590270996094 },
    { x: 241.64474487304688, y: 378.00403594970703 }, { x: 169.12376403808594, y: 378.7648391723633 },
  ] },
  { time: 4, knownDiagnosticIndex: 13.814, diagnosticKeypoints: [
    { x: 145.52740097045898, y: 298.81736755371094 }, { x: 203.73443603515625, y: 304.74761962890625 },
    { x: 201.88697814941406, y: 356.9677734375 }, { x: 137.50123977661133, y: 348.8723373413086 },
  ] },
  { time: 5.5, knownDiagnosticIndex: 19.446, diagnosticKeypoints: [
    { x: 197.94479370117188, y: 303.98143768310547 }, { x: 253.80756378173828, y: 294.580020904541 },
    { x: 260.02357482910156, y: 346.4153289794922 }, { x: 195.7796859741211, y: 347.6142883300781 },
  ] },
  { time: 7, knownDiagnosticIndex: 1.463, diagnosticKeypoints: [
    { x: 95.95466613769531, y: 288.47278594970703 }, { x: 165.4774284362793, y: 288.4214401245117 },
    { x: 139.47813034057617, y: 347.56946563720703 }, { x: 78.49224090576172, y: 338.4552001953125 },
  ] },
];

function log(message: string) {
  console.log(`[resolution-check] ${message}`);
}

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
  nativePixelsBase64: string;
  modelScale: number; modelPadX: number; modelPadY: number; modelPixelsBase64: string;
};

async function captureFrame(page: import('playwright').Page, time: number): Promise<FrameCapture> {
  return page.evaluate(({ time: seekTime, modelSize, modelMaxDim }) => {
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

        const nativeCanvas = document.createElement('canvas');
        nativeCanvas.width = srcWidth;
        nativeCanvas.height = srcHeight;
        const nativeCtx = nativeCanvas.getContext('2d')!;
        nativeCtx.drawImage(video, 0, 0, srcWidth, srcHeight);
        const nativePixelsBase64 = toBase64(nativeCtx.getImageData(0, 0, srcWidth, srcHeight).data);

        const modelScale = Math.min(1, modelMaxDim / Math.max(srcWidth, srcHeight));
        const newW = Math.round(srcWidth * modelScale);
        const newH = Math.round(srcHeight * modelScale);
        const padX = Math.floor((modelSize - newW) / 2);
        const padY = Math.floor((modelSize - newH) / 2);
        const modelCanvas = document.createElement('canvas');
        modelCanvas.width = modelSize;
        modelCanvas.height = modelSize;
        const modelCtx = modelCanvas.getContext('2d')!;
        modelCtx.fillStyle = 'rgb(114,114,114)';
        modelCtx.fillRect(0, 0, modelSize, modelSize);
        modelCtx.drawImage(video, padX, padY, newW, newH);
        const modelPixelsBase64 = toBase64(modelCtx.getImageData(0, 0, modelSize, modelSize).data);

        resolve({ srcWidth, srcHeight, nativePixelsBase64, modelScale, modelPadX: padX, modelPadY: padY, modelPixelsBase64 });
      };
      video.addEventListener('seeked', onSeeked);
      video.currentTime = seekTime;
    });
  }, { time, modelSize: MODEL_INPUT_SIZE, modelMaxDim: MODEL_FRAME_MAX_DIMENSION });
}

// Resample nativePixels (srcWidth x srcHeight) in Node, NESSUN canvas: bilineare
// semplice, sufficiente per un confronto - non e' il percorso di produzione
// (che usa drawImage del browser), ma la domanda e' "l'indice cambia con la
// risoluzione", non "il resize bilineare di Node replica esattamente Chrome".
function resample(
  native: Buffer, srcWidth: number, srcHeight: number,
  cropX: number, cropY: number, cropWidth: number, cropHeight: number,
  outWidth: number, outHeight: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(outWidth * outHeight * 4);
  for (let y = 0; y < outHeight; y += 1) {
    const srcY = Math.min(srcHeight - 1, Math.max(0, Math.round(cropY + (y / outHeight) * cropHeight)));
    for (let x = 0; x < outWidth; x += 1) {
      const srcX = Math.min(srcWidth - 1, Math.max(0, Math.round(cropX + (x / outWidth) * cropWidth)));
      const srcOffset = (srcY * srcWidth + srcX) * 4;
      const dstOffset = (y * outWidth + x) * 4;
      out[dstOffset] = native[srcOffset];
      out[dstOffset + 1] = native[srcOffset + 1];
      out[dstOffset + 2] = native[srcOffset + 2];
      out[dstOffset + 3] = 255;
    }
  }
  return out;
}

async function main() {
  const casesRaw = JSON.parse(fs.readFileSync(path.join(WEB_ROOT, 'bench/cases.json'), 'utf8'));
  const videoDir = process.env.BENCH_VIDEO_DIR || casesRaw.videoDir;
  const session = await ort.InferenceSession.create(MODEL_PATH);
  const videoServer = await startStaticServer(videoDir);
  const browser = await chromium.launch({ executablePath: pinnedChromeExecutable(), headless: true });
  const page = await browser.newPage();
  await page.setContent('<!doctype html><html><body></body></html>');

  try {
    for (const videoId of VIDEO_IDS) {
      const entry = (casesRaw.cases as Array<{ id: string; video: string }>).find((c) => c.id === videoId)!;
      log(`=== ${videoId} ===`);
      const videoUrl = `http://127.0.0.1:${videoServer.port}/${entry.video}`;
      await page.evaluate((url) => {
        const video = document.createElement('video');
        video.src = url;
        video.crossOrigin = 'anonymous';
        video.muted = true;
        (window as unknown as { __video?: HTMLVideoElement }).__video = video;
        document.body.appendChild(video);
        return new Promise<void>((resolve, reject) => {
          video.addEventListener('loadeddata', () => resolve(), { once: true });
          video.addEventListener('error', () => reject(new Error('video error')), { once: true });
        });
      }, videoUrl);

      const explicitEntries = videoId === 'IMG_6334' ? GIUSTE_6334 : null;
      const timesToScan = explicitEntries ? explicitEntries.map((e) => e.time) : TIMESTAMPS;

      for (const time of timesToScan) {
        const frame = await captureFrame(page, time);
        const nativeBuffer = Buffer.from(frame.nativePixelsBase64, 'base64');

        let bestKeypoints: Point[];
        let knownDiagnosticIndex: number | null = null;
        if (explicitEntries) {
          const entry2 = explicitEntries.find((e) => e.time === time)!;
          knownDiagnosticIndex = entry2.knownDiagnosticIndex;
          // Converte i vertici dallo spazio 640px-senza-ritaglio della
          // diagnosi allo spazio nativo, con la STESSA formula/scala che
          // la diagnosi usa per andare da nativo a 640px (qui invertita).
          const diagnosticScale = Math.min(1, ANALYSIS_MAX_DIMENSION / Math.max(frame.srcWidth, frame.srcHeight));
          bestKeypoints = entry2.diagnosticKeypoints.map((p) => ({ x: p.x / diagnosticScale, y: p.y / diagnosticScale }));
        } else {
          const modelPixels = Buffer.from(frame.modelPixelsBase64, 'base64');
          const rawDetections = await runDetection(session, modelPixels);
          const nativeDetections: FaceCornerDetection[] = rawDetections.map((detection) => ({
            score: detection.score,
            keypoints: detection.keypoints.map((kp) => ({
              x: (kp.x - frame.modelPadX) / frame.modelScale,
              y: (kp.y - frame.modelPadY) / frame.modelScale,
            })),
          }));
          const plausible = filterPlausibleDetections(nativeDetections);
          if (!plausible.length) continue;
          bestKeypoints = plausible.reduce((a, b) => (b.score > a.score ? b : a)).keypoints;
        }
        const best = { keypoints: bestKeypoints, score: 0 };

        const video = { videoWidth: frame.srcWidth, videoHeight: frame.srcHeight };
        const portrait = frame.srcHeight >= frame.srcWidth;
        const cropVariants = inspectionCropVariants(portrait);
        const prodAnalysisWidth = portrait ? 320 : 480;

        const results: Array<{ label: string; index: number | null; outOfBounds: boolean }> = [];

        // Diagnosi: fotogramma intero, nessun ritaglio, 640px lato lungo.
        {
          const scale = Math.min(1, ANALYSIS_MAX_DIMENSION / Math.max(frame.srcWidth, frame.srcHeight));
          const outW = Math.round(frame.srcWidth * scale);
          const outH = Math.round(frame.srcHeight * scale);
          const pixels = resample(nativeBuffer, frame.srcWidth, frame.srcHeight, 0, 0, frame.srcWidth, frame.srcHeight, outW, outH);
          const keypoints: Point[] = best.keypoints.map((p) => ({ x: p.x * scale, y: p.y * scale }));
          const outOfBounds = keypoints.some((p) => p.x < 0 || p.y < 0 || p.x > outW || p.y > outH);
          results.push({ label: `diagnosi (640px, nessun ritaglio, ${outW}x${outH})`, index: gridAlignmentIndex(keypoints, pixels, outW, outH), outOfBounds });
        }

        // Produzione: 3 ritagli, ciascuno con la STESSA formula di mapModelPointToAnalysisSpace.
        cropVariants.forEach((crop, cropIndex) => {
          const analysisWidth = prodAnalysisWidth;
          const analysisHeight = Math.round(analysisWidth * (video.videoHeight * crop.height) / (video.videoWidth * crop.width));
          // modelScale usato solo per la formula (qui i keypoint sono gia' in
          // spazio nativo, quindi modelScale=1 nella chiamata).
          const keypoints: Point[] = best.keypoints.map((p) => mapModelPointToAnalysisSpace(
            p, 1, video, crop, analysisWidth, analysisHeight,
          ));
          const outOfBounds = keypoints.some((p) => p.x < 0 || p.y < 0 || p.x > analysisWidth || p.y > analysisHeight);
          const pixels = resample(
            nativeBuffer, frame.srcWidth, frame.srcHeight,
            crop.x * frame.srcWidth, crop.y * frame.srcHeight, crop.width * frame.srcWidth, crop.height * frame.srcHeight,
            analysisWidth, analysisHeight,
          );
          results.push({
            label: `produzione ritaglio ${cropIndex} (${JSON.stringify(crop)}, ${analysisWidth}x${analysisHeight})`,
            index: gridAlignmentIndex(keypoints, pixels, analysisWidth, analysisHeight),
            outOfBounds,
          });
        });

        log(`  t=${time}s${knownDiagnosticIndex !== null ? ` (indice noto dalla diagnosi: ${knownDiagnosticIndex})` : ''}`);
        results.forEach((r) => {
          log(`    ${r.label}: indice=${r.index === null ? 'n/d' : r.index.toFixed(3)}${r.outOfBounds ? '  [FUORI DAI LIMITI DEL CANVAS]' : ''}`);
        });
        const diagIndex = results[0].index;
        if (diagIndex !== null) {
          results.slice(1).forEach((r) => {
            if (r.index !== null) {
              const pct = (100 * Math.abs(r.index - diagIndex)) / Math.max(1e-6, diagIndex);
              log(`      differenza vs diagnosi: ${pct.toFixed(1)}%`);
            }
          });
        }
      }
    }
  } finally {
    await browser.close();
    videoServer.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
