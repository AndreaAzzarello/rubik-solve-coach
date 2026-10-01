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
import { boxIou, decodePoseOutput, nonMaxSuppression, type Box, type Keypoint } from './pose-decode.ts';

export type FaceDetection = { score: number; box: Box; keypoints: Keypoint[] };

type PreparedInput = {
  tensor: number[];
  scale: number;
  padX: number;
  padY: number;
  origWidth: number;
  origHeight: number;
  cropX: number;
  cropY: number;
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
    return { tensor, scale, padX, padY, origWidth: srcW, origHeight: srcH, cropX: 0, cropY: 0 };
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

// Secondo passaggio del rilevamento a due stadi: ritaglia un sotto-rettangolo
// dell'immagine (in coordinate originali) e lo letterboxa a targetSize, come
// prepareFromImageUrl ma partendo da un crop invece che dall'immagine intera -
// permette al modello di vedere il cubo piu' grande quando occupa poco del
// fotogramma originale.
async function prepareFromImageUrlCropped(args: {
  url: string;
  cropX: number;
  cropY: number;
  cropW: number;
  cropH: number;
  targetSize: number;
}): Promise<PreparedInput> {
  const img = document.createElement('img');
  img.crossOrigin = 'anonymous';
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error(`impossibile caricare ${args.url}`));
    img.src = args.url;
  });

  const target = args.targetSize;
  const canvas = document.createElement('canvas');
  canvas.width = target;
  canvas.height = target;
  const ctx = canvas.getContext('2d')!;
  const scale = Math.min(target / args.cropW, target / args.cropH);
  const newW = Math.round(args.cropW * scale);
  const newH = Math.round(args.cropH * scale);
  const padX = Math.floor((target - newW) / 2);
  const padY = Math.floor((target - newH) / 2);
  ctx.fillStyle = 'rgb(114,114,114)';
  ctx.fillRect(0, 0, target, target);
  ctx.drawImage(img, args.cropX, args.cropY, args.cropW, args.cropH, padX, padY, newW, newH);
  const pixels = ctx.getImageData(0, 0, target, target).data;
  const size = target * target;
  const tensor = new Array(3 * size);
  for (let i = 0; i < size; i += 1) {
    tensor[i] = pixels[i * 4] / 255;
    tensor[size + i] = pixels[i * 4 + 1] / 255;
    tensor[2 * size + i] = pixels[i * 4 + 2] / 255;
  }
  return {
    tensor,
    scale,
    padX,
    padY,
    origWidth: img.naturalWidth,
    origHeight: img.naturalHeight,
    cropX: args.cropX,
    cropY: args.cropY,
  };
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
    return { tensor, scale, padX, padY, origWidth: srcW, origHeight: srcH, cropX: 0, cropY: 0 };
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
    x: (x - prepared.padX) / prepared.scale + prepared.cropX,
    y: (y - prepared.padY) / prepared.scale + prepared.cropY,
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

  // Rilevamento a due stadi: primo passaggio sull'immagine intera per
  // localizzare il cubo, poi un secondo passaggio su un ritaglio quadrato
  // attorno a quel bbox (+ margine) ridimensionato a MODEL_INPUT_SIZE - il
  // cubo occupa piu' pixel nel tensore quando e' piccolo nel fotogramma
  // originale. Se il primo passaggio non trova nulla, ritorna il risultato
  // (vuoto) del primo passaggio invece di inventare un ritaglio.
  async detectTwoPassFromImageUrl(url: string, marginFraction = 0.3): Promise<FaceDetection[]> {
    const prepared1 = await this.page.evaluate(prepareFromImageUrl, { url, targetSize: MODEL_INPUT_SIZE });
    const pass1 = await this.runAndDecode(prepared1);
    if (pass1.length === 0) return pass1;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    pass1.forEach((det) => {
      det.keypoints.forEach((kp) => {
        minX = Math.min(minX, kp.x);
        minY = Math.min(minY, kp.y);
        maxX = Math.max(maxX, kp.x);
        maxY = Math.max(maxY, kp.y);
      });
    });

    const unionW = maxX - minX;
    const unionH = maxY - minY;
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const squareSize = Math.min(
      Math.max(unionW, unionH) * (1 + marginFraction),
      Math.min(prepared1.origWidth, prepared1.origHeight),
    );
    const cropX = Math.min(Math.max(centerX - squareSize / 2, 0), prepared1.origWidth - squareSize);
    const cropY = Math.min(Math.max(centerY - squareSize / 2, 0), prepared1.origHeight - squareSize);

    const prepared2 = await this.page.evaluate(prepareFromImageUrlCropped, {
      url,
      cropX,
      cropY,
      cropW: squareSize,
      cropH: squareSize,
      targetSize: MODEL_INPUT_SIZE,
    });
    return this.runAndDecode(prepared2);
  }

  // Come detectTwoPassFromImageUrl, ma il secondo passaggio puo' solo
  // RAFFINARE: il risultato ha sempre la stessa lista di facce del primo
  // passaggio (stesso recall), con i keypoint sostituiti da quelli del
  // secondo passaggio solo per le facce che hanno una corrispondenza IoU
  // sufficiente nel ritaglio - mai una faccia in meno di quante ne trova il
  // primo passaggio da solo.
  async detectTwoPassRefineFromImageUrl(url: string, marginFraction = 0.3, iouThreshold = 0.3): Promise<FaceDetection[]> {
    const prepared1 = await this.page.evaluate(prepareFromImageUrl, { url, targetSize: MODEL_INPUT_SIZE });
    const pass1 = await this.runAndDecode(prepared1);
    if (pass1.length === 0) return pass1;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    pass1.forEach((det) => {
      det.keypoints.forEach((kp) => {
        minX = Math.min(minX, kp.x);
        minY = Math.min(minY, kp.y);
        maxX = Math.max(maxX, kp.x);
        maxY = Math.max(maxY, kp.y);
      });
    });

    const unionW = maxX - minX;
    const unionH = maxY - minY;
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const squareSize = Math.min(
      Math.max(unionW, unionH) * (1 + marginFraction),
      Math.min(prepared1.origWidth, prepared1.origHeight),
    );
    const cropX = Math.min(Math.max(centerX - squareSize / 2, 0), prepared1.origWidth - squareSize);
    const cropY = Math.min(Math.max(centerY - squareSize / 2, 0), prepared1.origHeight - squareSize);

    const prepared2 = await this.page.evaluate(prepareFromImageUrlCropped, {
      url,
      cropX,
      cropY,
      cropW: squareSize,
      cropH: squareSize,
      targetSize: MODEL_INPUT_SIZE,
    });
    const pass2 = await this.runAndDecode(prepared2);

    const usedPass2 = new Set<number>();
    return pass1.map((det1) => {
      let bestIndex = -1;
      let bestIou = iouThreshold;
      pass2.forEach((det2, index) => {
        if (usedPass2.has(index)) return;
        const iou = boxIou(det1.box, det2.box);
        if (iou > bestIou) { bestIou = iou; bestIndex = index; }
      });
      if (bestIndex === -1) return det1;
      usedPass2.add(bestIndex);
      return pass2[bestIndex];
    });
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
