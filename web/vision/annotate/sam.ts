// Wrapper MobileSAM: incapsula il preprocessing (via una pagina Playwright
// riusata per il resize/pad su canvas), l'encoder (una volta per fotogramma,
// cache in memoria) e il decoder (uno per ogni punto di richiesta, veloce).
// Vedi sam-test.ts per la verifica visiva che ha validato questo
// preprocessing/formato prima di scriverlo qui come modulo.

import ort from 'onnxruntime-node';
import type { Page } from 'playwright';
import { maskToQuad } from './mask-to-quad.ts';
import type { Point } from '../../lib/video-decoder.ts';

const SAM_SIZE = 1024;

type PreprocessResult = {
  pixels: number[];
  origWidth: number;
  origHeight: number;
  resizedWidth: number;
  resizedHeight: number;
};

// In-browser, autocontenuta: resize (lato lungo = 1024) + pad in alto a
// sinistra dentro 1024x1024 (convenzione ufficiale SAM), pixel HWC 0-255.
async function preprocessForSam(args: { url: string }): Promise<PreprocessResult> {
  const img = document.createElement('img');
  img.crossOrigin = 'anonymous';
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error(`impossibile caricare ${args.url}`));
    img.src = args.url;
  });
  const origWidth = img.naturalWidth;
  const origHeight = img.naturalHeight;
  const scale = 1024 / Math.max(origWidth, origHeight);
  const resizedWidth = Math.round(origWidth * scale);
  const resizedHeight = Math.round(origHeight * scale);

  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 1024;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0, resizedWidth, resizedHeight);
  const data = ctx.getImageData(0, 0, 1024, 1024).data;
  const pixels: number[] = new Array(1024 * 1024 * 3);
  for (let i = 0, p = 0; i < data.length; i += 4, p += 3) {
    pixels[p] = data[i];
    pixels[p + 1] = data[i + 1];
    pixels[p + 2] = data[i + 2];
  }
  return { pixels, origWidth, origHeight, resizedWidth, resizedHeight };
}

type EmbeddedFrame = { embeddings: ort.Tensor; origWidth: number; origHeight: number };

export type PromptResult = { corners: Point[]; score: number };

export class SamAnnotator {
  private encoder!: ort.InferenceSession;

  private decoder!: ort.InferenceSession;

  private page: Page;

  private cache = new Map<string, EmbeddedFrame>();

  private constructor(page: Page) {
    this.page = page;
  }

  static async create(page: Page, encoderPath: string, decoderPath: string): Promise<SamAnnotator> {
    const annotator = new SamAnnotator(page);
    annotator.encoder = await ort.InferenceSession.create(encoderPath);
    annotator.decoder = await ort.InferenceSession.create(decoderPath);
    return annotator;
  }

  private async embed(frameUrl: string): Promise<EmbeddedFrame> {
    const cached = this.cache.get(frameUrl);
    if (cached) return cached;
    const prep = await this.page.evaluate(preprocessForSam, { url: frameUrl });
    const inputTensor = new ort.Tensor('float32', Float32Array.from(prep.pixels), [SAM_SIZE, SAM_SIZE, 3]);
    const result = await this.encoder.run({ input_image: inputTensor });
    const entry: EmbeddedFrame = {
      embeddings: result.image_embeddings,
      origWidth: prep.origWidth,
      origHeight: prep.origHeight,
    };
    this.cache.set(frameUrl, entry);
    return entry;
  }

  /** Pre-scalda la cache (usato per la pre-annotazione automatica in batch). */
  async preload(frameUrl: string): Promise<void> {
    await this.embed(frameUrl);
  }

  async promptPoint(frameUrl: string, x: number, y: number): Promise<PromptResult | null> {
    const frame = await this.embed(frameUrl);
    // Un solo punto su una griglia 3x3 e' ambiguo per SAM ("questo sticker" o
    // "l'intera faccia"?) e questo decoder ne restituisce una sola lettura
    // (non le 3 candidate di SAM originale) - verificato che un click singolo
    // spesso segmenta un solo sticker anche con score alto. Un piccolo
    // grappolo di punti attorno al click, tutti foreground, forza SAM a
    // segmentare l'unica regione che li contiene tutti: verificato che questo
    // recupera l'intera faccia in modo inequivocabile (misurato in pixel, non
    // solo a occhio - un errore di lettura precedente in questa stessa sessione
    // aveva scambiato per giusto un risultato che copriva lo 0.6% dell'immagine).
    const OFFSET = 50;
    const cluster = [
      [x, y], [x - OFFSET, y - OFFSET], [x + OFFSET, y - OFFSET], [x - OFFSET, y + OFFSET], [x + OFFSET, y + OFFSET],
    ];
    const pointCoords = new ort.Tensor('float32', new Float32Array(cluster.flat()), [1, cluster.length, 2]);
    const pointLabels = new ort.Tensor('float32', new Float32Array(cluster.map(() => 1)), [1, cluster.length]);
    const maskInput = new ort.Tensor('float32', new Float32Array(256 * 256), [1, 1, 256, 256]);
    const hasMaskInput = new ort.Tensor('float32', new Float32Array([0]), [1]);
    const origImSize = new ort.Tensor('float32', new Float32Array([frame.origHeight, frame.origWidth]), [2]);

    const decoded = await this.decoder.run({
      image_embeddings: frame.embeddings,
      point_coords: pointCoords,
      point_labels: pointLabels,
      mask_input: maskInput,
      has_mask_input: hasMaskInput,
      orig_im_size: origImSize,
    });

    const [, , maskH, maskW] = decoded.masks.dims as [number, number, number, number];
    const maskData = decoded.masks.data as Float32Array;
    const binary = new Uint8Array(maskH * maskW);
    for (let i = 0; i < binary.length; i += 1) binary[i] = maskData[i] > 0 ? 1 : 0;

    const quad = maskToQuad(binary, maskW, maskH);
    if (!quad) return null;
    const score = (decoded.iou_predictions.data as Float32Array)[0];
    return { corners: quad, score };
  }
}
