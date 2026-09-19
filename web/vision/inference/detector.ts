// Inferenza locale del modello di keypoint faccia: carica l'ONNX una volta
// (onnxruntime-node) e una pagina Playwright persistente per il preprocessing
// (letterbox + estrazione tensore) via canvas 2D - stesso Chrome for Testing
// pinnato gia' usato dal bench, nessuna dipendenza nuova per la parte
// immagine (niente sharp/jimp: il canvas del browser basta e riusa
// infrastruttura gia' verificata in questo repo).
//
// Il browser NON sa nulla del cubo: prende un URL (immagine o fotogramma
// video) e restituisce un tensore NCHW gia' letterboxed + i parametri per
// rimappare le coordinate all'immagine originale. Tutta la logica di
// decodifica/NMS vive in pose-decode.ts (puro, testato a parte).

import ort from 'onnxruntime-node';
import { chromium, type Browser, type Page } from 'playwright';
import { pinnedChromeExecutable } from '../../bench/chrome-path.ts';
import { decodePoseOutput, nonMaxSuppression, type Box, type Keypoint } from './pose-decode.ts';

export type FaceDetection = { score: number; box: Box; keypoints: Keypoint[] };

type PreparedInput = {
  tensor: number[];
  scale: number;
  padX: number;
  padY: number;
  origWidth: number;
  origHeight: number;
};

const MODEL_INPUT_SIZE = 512;
const CONF_THRESHOLD = 0.25;
const IOU_THRESHOLD = 0.5;

// Eseguita in-browser via page.evaluate: nessuna chiusura esterna, tutto
// autocontenuto (page.evaluate serializza solo il testo di questa funzione).
async function prepareFromImageUrl(args: { url: string; targetSize: number }): Promise<PreparedInput> {
  function letterboxAndExtract(source: CanvasImageSource, srcW: number, srcH: number, target: number): PreparedInput {
    const canvas = document.createElement('canvas');
    canvas.width = target;
    canvas.height = target;
    const ctx = canvas.getContext('2d')!;
    const scale = Math.min(target / srcW, target / srcH);
    const newW = Math.round(srcW * scale);
    const newH = Math.round(srcH * scale);
    const padX = Math.floor((target - newW) / 2);
    const padY = Math.floor((target - newH) / 2);
    ctx.fillStyle = 'rgb(114,114,114)'; // colore di padding standard YOLO
    ctx.fillRect(0, 0, target, target);
    ctx.drawImage(source, padX, padY, newW, newH);
    const pixels = ctx.getImageData(0, 0, target, target).data;
    const size = target * target;
    const tensor = new Array(3 * size);
    for (let i = 0; i < size; i += 1) {
      tensor[i] = pixels[i * 4] / 255;
      tensor[size + i] = pixels[i * 4 + 1] / 255;
      tensor[2 * size + i] = pixels[i * 4 + 2] / 255;
    }
    return { tensor, scale, padX, padY, origWidth: srcW, origHeight: srcH };
  }

  const img = document.createElement('img');
  img.crossOrigin = 'anonymous';
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error(`impossibile caricare ${args.url}`));
    img.src = args.url;
  });
  return letterboxAndExtract(img, img.naturalWidth, img.naturalHeight, args.targetSize);
}

async function prepareFromVideoFrame(args: { url: string; time: number; targetSize: number }): Promise<PreparedInput> {
  function letterboxAndExtract(source: CanvasImageSource, srcW: number, srcH: number, target: number): PreparedInput {
    const canvas = document.createElement('canvas');
    canvas.width = target;
    canvas.height = target;
    const ctx = canvas.getContext('2d')!;
    const scale = Math.min(target / srcW, target / srcH);
    const newW = Math.round(srcW * scale);
    const newH = Math.round(srcH * scale);
    const padX = Math.floor((target - newW) / 2);
    const padY = Math.floor((target - newH) / 2);
    ctx.fillStyle = 'rgb(114,114,114)';
    ctx.fillRect(0, 0, target, target);
    ctx.drawImage(source, padX, padY, newW, newH);
    const pixels = ctx.getImageData(0, 0, target, target).data;
    const size = target * target;
    const tensor = new Array(3 * size);
    for (let i = 0; i < size; i += 1) {
      tensor[i] = pixels[i * 4] / 255;
      tensor[size + i] = pixels[i * 4 + 1] / 255;
      tensor[2 * size + i] = pixels[i * 4 + 2] / 255;
    }
    return { tensor, scale, padX, padY, origWidth: srcW, origHeight: srcH };
  }

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
  return letterboxAndExtract(video, video.videoWidth, video.videoHeight, args.targetSize);
}

function mapToOriginalSpace(detection: { score: number; box: Box; keypoints: Keypoint[] }, prepared: PreparedInput): FaceDetection {
  const toOrig = (x: number, y: number) => ({
    x: (x - prepared.padX) / prepared.scale,
    y: (y - prepared.padY) / prepared.scale,
  });
  const boxCenter = toOrig(detection.box.x, detection.box.y);
  return {
    score: detection.score,
    box: {
      x: boxCenter.x,
      y: boxCenter.y,
      w: detection.box.w / prepared.scale,
      h: detection.box.h / prepared.scale,
    },
    keypoints: detection.keypoints.map((kp) => {
      const point = toOrig(kp.x, kp.y);
      return { x: point.x, y: point.y, conf: kp.conf };
    }),
  };
}

export class FaceKeypointDetector {
  private session!: ort.InferenceSession;

  private browser!: Browser;

  private page!: Page;

  private constructor() {}

  static async create(modelPath: string): Promise<FaceKeypointDetector> {
    const detector = new FaceKeypointDetector();
    detector.session = await ort.InferenceSession.create(modelPath);
    detector.browser = await chromium.launch({ executablePath: pinnedChromeExecutable(), headless: true });
    detector.page = await detector.browser.newPage();
    await detector.page.setContent('<!doctype html><html><body></body></html>');
    return detector;
  }

  async detectFromImageUrl(url: string): Promise<FaceDetection[]> {
    const prepared = await this.page.evaluate(prepareFromImageUrl, { url, targetSize: MODEL_INPUT_SIZE });
    return this.runAndDecode(prepared);
  }

  async detectFromVideoFrame(url: string, time: number): Promise<FaceDetection[]> {
    const prepared = await this.page.evaluate(prepareFromVideoFrame, { url, time, targetSize: MODEL_INPUT_SIZE });
    return this.runAndDecode(prepared);
  }

  private async runAndDecode(prepared: PreparedInput): Promise<FaceDetection[]> {
    const inputTensor = new ort.Tensor('float32', Float32Array.from(prepared.tensor), [1, 3, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE]);
    const results = await this.session.run({ [this.session.inputNames[0]]: inputTensor });
    const output = results[this.session.outputNames[0]];
    const [, channels, numAnchors] = output.dims as [number, number, number];
    const numKeypoints = (channels - 5) / 3;
    const raw = decodePoseOutput(output.data as Float32Array, numAnchors, numKeypoints, CONF_THRESHOLD);
    const kept = nonMaxSuppression(raw, IOU_THRESHOLD);
    return kept.map((det) => mapToOriginalSpace(det, prepared));
  }

  async close(): Promise<void> {
    await this.page.close();
    await this.browser.close();
  }
}
