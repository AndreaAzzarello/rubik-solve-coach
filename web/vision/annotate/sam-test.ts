// Test isolato: verifica che l'encoder+decoder MobileSAM producano una
// maschera sensata su UN fotogramma reale, prima di costruire tutta la
// pipeline (mask -> quadrilatero -> strumento di annotazione) sopra
// un'integrazione che potrebbe essere sbagliata nel preprocessing.
//
//   node --experimental-strip-types vision/annotate/sam-test.ts <frame.jpg> [x] [y]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ort from 'onnxruntime-node';
import { chromium } from 'playwright';
import { pinnedChromeExecutable } from '../../bench/chrome-path.ts';
import { startStaticServer } from '../../bench/lib/static-server.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENCODER_PATH = path.join(HERE, '.cache', 'mobilesam', 'encoder.onnx');
const DECODER_PATH = path.join(HERE, '.cache', 'mobilesam', 'decoder.onnx');

// In-browser: resize (lato lungo = 1024, aspetto preservato) + pad a 1024x1024
// in alto a sinistra (convenzione ufficiale SAM), pixel HWC 0-255.
async function preprocess(args: { url: string }): Promise<{
  pixels: number[]; origWidth: number; origHeight: number; resizedWidth: number; resizedHeight: number;
}> {
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

async function main() {
  const frameArg = process.argv[2] ?? 'IMG_6107-050.jpg';
  const framesDir = path.join(HERE, 'frames');
  const framePath = path.join(framesDir, frameArg);
  if (!fs.existsSync(framePath)) throw new Error(`non trovo ${framePath}`);

  const server = await startStaticServer(framesDir);
  const browser = await chromium.launch({ executablePath: pinnedChromeExecutable(), headless: true });
  const page = await browser.newPage();
  await page.setContent('<!doctype html><html><body></body></html>');

  console.log('preprocessing...');
  const prep = await page.evaluate(preprocess, { url: `http://127.0.0.1:${server.port}/${frameArg}` });
  console.log(`immagine originale ${prep.origWidth}x${prep.origHeight}, ridimensionata a ${prep.resizedWidth}x${prep.resizedHeight} dentro 1024x1024`);
  await browser.close();
  server.close();

  console.log('carico encoder...');
  const encoder = await ort.InferenceSession.create(ENCODER_PATH);
  const inputTensor = new ort.Tensor('float32', Float32Array.from(prep.pixels), [1024, 1024, 3]);
  console.log('eseguo encoder...');
  const t0 = Date.now();
  const encoded = await encoder.run({ input_image: inputTensor });
  console.log(`encoder: ${Date.now() - t0}ms, output`, encoded.image_embeddings.dims);

  console.log('carico decoder...');
  const decoder = await ort.InferenceSession.create(DECODER_PATH);

  // Punto di prompt: centro del fotogramma ORIGINALE (in mancanza di un
  // rilevatore affidabile, la scommessa piu' semplice - nei video di
  // ispezione il cubo e' quasi sempre inquadrato al centro).
  const promptX = process.argv[3] ? Number(process.argv[3]) : prep.origWidth / 2;
  const promptY = process.argv[4] ? Number(process.argv[4]) : prep.origHeight / 2;
  console.log(`prompt point: (${promptX}, ${promptY}) su immagine ${prep.origWidth}x${prep.origHeight}`);

  const pointCoords = new ort.Tensor('float32', new Float32Array([promptX, promptY, 0, 0]), [1, 2, 2]);
  const pointLabels = new ort.Tensor('float32', new Float32Array([1, -1]), [1, 2]);
  const maskInput = new ort.Tensor('float32', new Float32Array(256 * 256), [1, 1, 256, 256]);
  const hasMaskInput = new ort.Tensor('float32', new Float32Array([0]), [1]);
  const origImSize = new ort.Tensor('float32', new Float32Array([prep.origHeight, prep.origWidth]), [2]);

  const t1 = Date.now();
  const decoded = await decoder.run({
    image_embeddings: encoded.image_embeddings,
    point_coords: pointCoords,
    point_labels: pointLabels,
    mask_input: maskInput,
    has_mask_input: hasMaskInput,
    orig_im_size: origImSize,
  });
  console.log(`decoder: ${Date.now() - t1}ms`);
  console.log('masks dims:', decoded.masks.dims);
  console.log('iou_predictions:', Array.from(decoded.iou_predictions.data as Float32Array));

  fs.writeFileSync(path.join(HERE, 'sam-test-output.json'), JSON.stringify({
    frame: frameArg,
    origWidth: prep.origWidth,
    origHeight: prep.origHeight,
    promptX,
    promptY,
    masksDims: decoded.masks.dims,
    iouPredictions: Array.from(decoded.iou_predictions.data as Float32Array),
  }, null, 2));

  // Overlay visivo: soglia a 0 (convenzione SAM: logit>0 = dentro la maschera).
  const maskData = decoded.masks.data as Float32Array;
  const [, , maskH, maskW] = decoded.masks.dims as [number, number, number, number];
  const binaryMask = new Uint8Array(maskH * maskW);
  for (let i = 0; i < binaryMask.length; i += 1) binaryMask[i] = maskData[i] > 0 ? 1 : 0;

  const server2 = await startStaticServer(framesDir);
  const browser2 = await chromium.launch({ executablePath: pinnedChromeExecutable(), headless: true });
  const page2 = await browser2.newPage();
  await page2.setContent('<!doctype html><html><body></body></html>');
  const overlayDataUrl = await page2.evaluate(
    async (args) => {
      const img = document.createElement('img');
      img.crossOrigin = 'anonymous';
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('errore caricamento'));
        img.src = args.url;
      });
      const canvas = document.createElement('canvas');
      canvas.width = args.width;
      canvas.height = args.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, args.width, args.height);
      for (let i = 0; i < args.mask.length; i += 1) {
        if (args.mask[i]) {
          imageData.data[i * 4] = Math.min(255, imageData.data[i * 4] + 100);
          imageData.data[i * 4 + 3] = 255;
        }
      }
      ctx.putImageData(imageData, 0, 0);
      ctx.fillStyle = 'lime';
      ctx.beginPath();
      ctx.arc(args.promptX, args.promptY, 6, 0, Math.PI * 2);
      ctx.fill();
      return canvas.toDataURL('image/png');
    },
    {
      url: `http://127.0.0.1:${server2.port}/${frameArg}`,
      width: prep.origWidth,
      height: prep.origHeight,
      mask: Array.from(binaryMask),
      promptX,
      promptY,
    },
  );
  await browser2.close();
  server2.close();
  const base64 = overlayDataUrl.replace(/^data:image\/png;base64,/, '');
  const overlayPath = path.join(HERE, 'sam-test-overlay.png');
  fs.writeFileSync(overlayPath, Buffer.from(base64, 'base64'));
  console.log(`\nsalvato ${overlayPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
