// Il vero test: fa girare il modello su fotogrammi presi dai video bench
// reali (IMG_6107/IMG_6108) e salva PNG con i keypoint predetti sovrapposti,
// per un controllo visivo. Il sintetico non ha mani ne' sfondo fotografico:
// un punteggio ottimo li' non dice nulla su questo caso, che e' quello che
// conta davvero prima di integrare il modello nella pipeline.
//
//   node --experimental-strip-types vision/eval/run-real-preview.ts

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { pinnedChromeExecutable } from '../../bench/chrome-path.ts';
import { startStaticServer } from '../../bench/lib/static-server.ts';
import { FaceKeypointDetector, type FaceDetection } from '../inference/detector.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, '..', '..');
const MODEL_PATH = path.join(WEB_ROOT, 'vision', 'models', process.env.PREVIEW_MODEL || 'best.onnx');
const VIDEO_DIR = process.env.BENCH_VIDEO_DIR || 'C:/Users/Andrea/Desktop/App/lenti';
const OUT_DIR = path.join(HERE, 'real-preview');

const CASES = [
  { id: 'IMG_6108', video: 'IMG_6108.mp4', times: [21.12, 21.35, 21.63, 21.72, 21.98, 22.18] },
];

// In-browser, autocontenuta (page.evaluate): cattura un fotogramma a piena
// risoluzione (nessun letterbox, e' solo per la visualizzazione).
async function captureFrame(args: { url: string; time: number }): Promise<{ dataUrl: string }> {
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
  await new Promise<void>((resolve) => {
    const target = Math.min(video.duration - 0.01, Math.max(0, args.time));
    if (Math.abs(video.currentTime - target) < 0.005) { resolve(); return; }
    const done = () => { video.removeEventListener('seeked', done); resolve(); };
    video.addEventListener('seeked', done);
    video.currentTime = target;
  });
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(video, 0, 0);
  return { dataUrl: canvas.toDataURL('image/png') };
}

// In-browser: disegna box+keypoint predetti sopra il fotogramma catturato.
async function drawOverlay(args: { dataUrl: string; detections: FaceDetection[] }): Promise<string> {
  const img = document.createElement('img');
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('impossibile ricaricare il fotogramma catturato'));
    img.src = args.dataUrl;
  });
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);

  const palette = ['#f472b6', '#22d3ee', '#facc15', '#a3e635'];
  args.detections.forEach((detection, faceIndex) => {
    const color = palette[faceIndex % palette.length];
    ctx.beginPath();
    detection.keypoints.forEach((kp, index) => {
      if (index === 0) ctx.moveTo(kp.x, kp.y);
      else ctx.lineTo(kp.x, kp.y);
    });
    ctx.closePath();
    ctx.lineWidth = 3;
    ctx.strokeStyle = color;
    ctx.stroke();
    detection.keypoints.forEach((kp, index) => {
      ctx.beginPath();
      ctx.arc(kp.x, kp.y, 7, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#0f172a';
      ctx.stroke();
      ctx.fillStyle = '#0f172a';
      ctx.font = 'bold 13px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(index), kp.x, kp.y - 14);
    });
    ctx.fillStyle = 'rgba(15,23,42,0.75)';
    ctx.fillRect(6, 6 + faceIndex * 20, 100, 16);
    ctx.fillStyle = color;
    ctx.font = 'bold 12px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`score ${detection.score.toFixed(2)}`, 10, 14 + faceIndex * 20);
  });
  return canvas.toDataURL('image/png');
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const server = await startStaticServer(VIDEO_DIR);
  const detector = await FaceKeypointDetector.create(MODEL_PATH);
  const browser = await chromium.launch({ executablePath: pinnedChromeExecutable(), headless: true });
  const page = await browser.newPage();
  await page.setContent('<!doctype html><html><body></body></html>');

  for (const testCase of CASES) {
    const url = `http://127.0.0.1:${server.port}/${testCase.video}`;
    for (const time of testCase.times) {
      const detections = await detector.detectFromVideoFrame(url, time);
      const frame = await page.evaluate(captureFrame, { url, time });
      const overlayDataUrl = await page.evaluate(drawOverlay, { dataUrl: frame.dataUrl, detections });
      const base64 = overlayDataUrl.replace(/^data:image\/png;base64,/, '');
      const filename = `${testCase.id}-t${time.toFixed(1)}.png`;
      fs.writeFileSync(path.join(OUT_DIR, filename), Buffer.from(base64, 'base64'));
      const scores = detections.map((d) => d.score.toFixed(2)).join(', ');
      console.log(`${filename}: ${detections.length} facce trovate (score: ${scores || 'nessuna'})`);
    }
  }

  await detector.close();
  await browser.close();
  server.close();
  console.log(`\nsalvati in ${OUT_DIR}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
