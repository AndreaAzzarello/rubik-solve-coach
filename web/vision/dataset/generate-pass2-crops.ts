// Genera, per ogni fotogramma reale annotato (train/val, mai test), un
// ritaglio in stile "passaggio 2" (crop+zoom sul cubo, vedi
// lib/face-keypoint-model.ts) a partire dalle facce annotate a mano - zero
// nuove annotazioni, le coordinate dei vertici si derivano geometricamente.
//
// Riusa computeTwoPassCrop (stessa funzione, stessa matematica della
// produzione) per il ritaglio "canonico" (margine fisso), poi applica
// variazione casuale (margine 2.0-3.0, spostamento centro ±15% del lato) con
// seed fisso per riproducibilita' - senza variazione il modello vedrebbe
// sempre lo stesso identico ritaglio per fotogramma, poco utile come
// augmentation.
//
// Un vertice che cade fuori dal ritaglio dopo lo spostamento viene marcato
// non visibile (YOLO visibility=0) invece di scartare la faccia. Se TUTTI e
// 4 i vertici di una faccia cadono fuori, quella faccia viene scartata (zero
// segnale utile) - il fotogramma stesso viene saltato se nessuna faccia
// resta con almeno un vertice visibile.
//
//   node --experimental-strip-types vision/dataset/generate-pass2-crops.ts

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { computeTwoPassCrop } from '../../lib/face-keypoint-model.ts';
import { pinnedChromeExecutable } from '../../bench/chrome-path.ts';
import { startStaticServer } from '../../bench/lib/static-server.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANNOTATE_DIR = path.join(HERE, '..', 'annotate');
const FRAMES_DIR = path.join(ANNOTATE_DIR, 'frames');
const LABELS_DIR = path.join(ANNOTATE_DIR, 'labels');
const MANIFEST_PATH = path.join(FRAMES_DIR, 'manifest.json');

// Mai usati come sorgente, anche per errore: sono il test honest del bench.
const NEVER_IN_TRAINING = ['IMG_6258', 'IMG_6260', 'IMG_6281'];

const SEED = 20261006;
const MARGIN_MIN = 2.0;
const MARGIN_MAX = 3.0;
const SHIFT_FRACTION = 0.15;

type ManifestEntry = { id: string; video: string; time: number; split: 'train' | 'val' | 'test' };
type Corner = { x: number; y: number; visibility: 0 | 1 | 2 };
type FaceLabel = { corners: Corner[] };
type FrameLabel = { faces: FaceLabel[]; width: number; height: number };

// PRNG deterministico (mulberry32): riproducibile a prescindere da
// piattaforma/versione Node, a differenza di Math.random().
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function log(...parts: unknown[]) {
  console.log('[pass2-crops]', ...parts);
}

function loadEligibleEntries(): ManifestEntry[] {
  const manifest: ManifestEntry[] = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const labelTxts = new Set(fs.readdirSync(LABELS_DIR).filter((f) => f.endsWith('.txt')).map((f) => f.replace(/\.txt$/, '')));
  return manifest.filter((entry) => {
    if (entry.split === 'test') return false;
    if (NEVER_IN_TRAINING.some((id) => entry.id.startsWith(id))) {
      throw new Error(`sicurezza: ${entry.id} appartiene a un video di test, non deve mai generare crop di training`);
    }
    if (!labelTxts.has(entry.id)) return false;
    if (!fs.existsSync(path.join(FRAMES_DIR, `${entry.id}.jpg`))) return false;
    return true;
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

type Crop = { x: number; y: number; size: number };

function jitteredCrop(faces: FaceLabel[], width: number, height: number, rand: () => number): Crop | null {
  const detections = faces.map((face) => ({ score: 1, keypoints: face.corners.map((c) => ({ x: c.x, y: c.y })) }));
  const margin = MARGIN_MIN + rand() * (MARGIN_MAX - MARGIN_MIN);
  const base = computeTwoPassCrop(detections, width, height, margin);
  if (!base) return null;
  const shiftX = (rand() * 2 - 1) * SHIFT_FRACTION * base.width;
  const shiftY = (rand() * 2 - 1) * SHIFT_FRACTION * base.height;
  const x = clamp(base.x + shiftX, 0, Math.max(0, width - base.width));
  const y = clamp(base.y + shiftY, 0, Math.max(0, height - base.height));
  return { x, y, size: base.width };
}

/** Rimappa le facce nel sistema di coordinate del ritaglio; vertici fuori -> visibility 0. Scarta facce interamente invisibili. */
function remapFaces(faces: FaceLabel[], crop: Crop): FaceLabel[] {
  return faces
    .map((face) => {
      const corners = face.corners.map((corner): Corner => {
        const localX = corner.x - crop.x;
        const localY = corner.y - crop.y;
        const inside = localX >= 0 && localX <= crop.size && localY >= 0 && localY <= crop.size;
        if (!inside || corner.visibility === 0) {
          return { x: clamp(localX, 0, crop.size), y: clamp(localY, 0, crop.size), visibility: 0 };
        }
        return { x: localX, y: localY, visibility: corner.visibility };
      });
      return { corners };
    })
    .filter((face) => face.corners.some((c) => c.visibility > 0));
}

function toYoloLine(face: FaceLabel, size: number): string {
  const xs = face.corners.map((c) => c.x);
  const ys = face.corners.map((c) => c.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const cx = (minX + maxX) / 2 / size;
  const cy = (minY + maxY) / 2 / size;
  const w = (maxX - minX) / size;
  const h = (maxY - minY) / size;
  const keypoints = face.corners.flatMap((c) => [
    (c.x / size).toFixed(6),
    (c.y / size).toFixed(6),
    String(c.visibility),
  ]);
  return ['0', cx.toFixed(6), cy.toFixed(6), w.toFixed(6), h.toFixed(6), ...keypoints].join(' ');
}

async function main() {
  const entries = loadEligibleEntries();
  log(`fotogrammi eleggibili: ${entries.length}`);
  entries.sort((a, b) => a.id.localeCompare(b.id));
  const rand = mulberry32(SEED);

  const server = await startStaticServer(FRAMES_DIR);
  const browser = await chromium.launch({ headless: true, executablePath: pinnedChromeExecutable() });
  const page = await browser.newPage();
  await page.setContent('<!doctype html><html><body></body></html>');

  let written = 0;
  let skippedDegenerate = 0;
  let skippedAllInvisible = 0;
  const manifestAdditions: ManifestEntry[] = [];

  for (const entry of entries) {
    const label: FrameLabel = JSON.parse(fs.readFileSync(path.join(LABELS_DIR, `${entry.id}.json`), 'utf8'));
    const crop = jitteredCrop(label.faces, label.width, label.height, rand);
    if (!crop) { skippedDegenerate += 1; continue; }

    const remapped = remapFaces(label.faces, crop);
    if (remapped.length === 0) { skippedAllInvisible += 1; continue; }

    const newId = `${entry.id}-p2crop`;
    const srcImageUrl = `http://127.0.0.1:${server.port}/${entry.id}.jpg`;
    const dataUrl: string = await page.evaluate(async ({ url, cropX, cropY, size }) => {
      const img = document.createElement('img');
      img.crossOrigin = 'anonymous';
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error(`impossibile caricare ${url}`));
        img.src = url;
      });
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, cropX, cropY, size, size, 0, 0, size, size);
      return canvas.toDataURL('image/jpeg', 0.92);
    }, { url: srcImageUrl, cropX: crop.x, cropY: crop.y, size: crop.size });

    const base64 = dataUrl.replace(/^data:image\/jpeg;base64,/, '');
    fs.writeFileSync(path.join(FRAMES_DIR, `${newId}.jpg`), Buffer.from(base64, 'base64'));
    fs.writeFileSync(path.join(LABELS_DIR, `${newId}.json`), JSON.stringify({
      faces: remapped,
      width: crop.size,
      height: crop.size,
      derivedFrom: entry.id,
    }, null, 2));
    fs.writeFileSync(
      path.join(LABELS_DIR, `${newId}.txt`),
      remapped.map((face) => toYoloLine(face, crop.size)).join('\n') + '\n',
    );
    manifestAdditions.push({ id: newId, video: entry.video, time: entry.time, split: entry.split });
    written += 1;
  }

  await browser.close();
  server.close();

  if (manifestAdditions.length > 0) {
    const manifest: ManifestEntry[] = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    const byId = new Map(manifest.map((e) => [e.id, e]));
    manifestAdditions.forEach((e) => byId.set(e.id, e)); // idempotente: rigenerare sovrascrive le proprie entry derivate
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify([...byId.values()], null, 2));
  }

  log(`scritti ${written} ritagli (saltati: ${skippedDegenerate} crop degenere, ${skippedAllInvisible} tutte le facce fuori ritaglio)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
