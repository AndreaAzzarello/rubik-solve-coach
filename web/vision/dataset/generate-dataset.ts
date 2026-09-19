// Genera il dataset sintetico completo (immagini + label formato Ultralytics
// YOLO-pose) per l'addestramento del rilevatore di keypoint faccia. Non fa
// training: prepara solo i dati che il notebook Colab consumera'.
//
//   node --experimental-strip-types vision/dataset/generate-dataset.ts [train] [val] [--overlay]
//
// Deterministico dato un seed (non ancora seedato esplicitamente: ogni corsa
// produce un dataset diverso ma della stessa distribuzione - va bene per il
// training, che vuole varieta', non riproducibilita' bit-per-bit). Le
// immagini NON sono committate in git (vision/dataset/output e' ignorato):
// questo script e' la fonte di verita' riproducibile, non i file prodotti.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { pinnedChromeExecutable } from '../../bench/chrome-path.ts';
import { CubeState, parseAlgorithm, type Face } from '../../lib/cube.ts';
import { buildScene, type SceneRender } from './scene.ts';
import type { CameraParams } from './camera.ts';
import type { LightParams } from './lighting.ts';
import { randomBackground, type BackgroundSpec } from './background.ts';
import { randomOccluders, type OccluderEllipse } from './occluder.ts';
import { annotateFaces, sceneBounds, toYoloLines, type AnnotatedFace } from './annotation.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, 'output');

const WIDTH = 512;
const HEIGHT = 512;
const JPEG_QUALITY = 0.92;

const MOVE_BASES = ['U', 'D', 'L', 'R', 'F', 'B'];
const MOVE_SUFFIXES = ['', "'", '2'];

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function randomScramble(length = 22): string {
  const tokens: string[] = [];
  let lastBase = '';
  for (let i = 0; i < length; i += 1) {
    let base = lastBase;
    while (base === lastBase) base = MOVE_BASES[Math.floor(Math.random() * MOVE_BASES.length)];
    lastBase = base;
    const suffix = MOVE_SUFFIXES[Math.floor(Math.random() * MOVE_SUFFIXES.length)];
    tokens.push(`${base}${suffix}`);
  }
  return tokens.join(' ');
}

const CUBE_CIRCUMSCRIBED_RADIUS = 1.5 * Math.sqrt(3);
const FRAMING_MARGIN = 1.35;

function randomCamera(): CameraParams {
  const fovY = randomBetween((35 * Math.PI) / 180, (50 * Math.PI) / 180);
  const minDistance = (CUBE_CIRCUMSCRIBED_RADIUS * FRAMING_MARGIN) / Math.tan(fovY / 2);
  return {
    azimuth: randomBetween(0, Math.PI * 2),
    elevation: randomBetween((15 * Math.PI) / 180, (60 * Math.PI) / 180),
    distance: minDistance * randomBetween(1, 1.3),
    roll: randomBetween((-8 * Math.PI) / 180, (8 * Math.PI) / 180),
    fovY,
    width: WIDTH,
    height: HEIGHT,
  };
}

function randomLight(): LightParams {
  const azimuth = randomBetween(0, Math.PI * 2);
  const elevation = randomBetween((20 * Math.PI) / 180, (80 * Math.PI) / 180);
  return {
    direction: {
      x: Math.cos(elevation) * Math.sin(azimuth),
      y: Math.sin(elevation),
      z: Math.cos(elevation) * Math.cos(azimuth),
    },
    ambient: randomBetween(0.3, 0.6),
    intensity: randomBetween(0.85, 1.2),
    colorTint: [randomBetween(0.85, 1.15), randomBetween(0.85, 1.15), randomBetween(0.85, 1.15)],
  };
}

type PaintPayload = {
  scene: SceneRender;
  background: BackgroundSpec;
  occluders: OccluderEllipse[];
  faces: AnnotatedFace[];
  overlay: boolean;
};

// Eseguita dentro il browser: nessuna conoscenza del cubo, solo un pittore
// generico (poligoni gia' colorati/ombreggiati da Node + sfondo + occlusori).
function paintInBrowser(payload: PaintPayload): string {
  const canvas = document.getElementById('c') as HTMLCanvasElement;
  canvas.width = payload.scene.width;
  canvas.height = payload.scene.height;
  const ctx = canvas.getContext('2d')!;
  const { background } = payload;

  if (background.kind === 'solid') {
    ctx.fillStyle = background.color;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  } else if (background.kind === 'gradient') {
    const angle = (background.angleDeg * Math.PI) / 180;
    const dx = Math.cos(angle) * canvas.width;
    const dy = Math.sin(angle) * canvas.height;
    const gradient = ctx.createLinearGradient(
      canvas.width / 2 - dx / 2,
      canvas.height / 2 - dy / 2,
      canvas.width / 2 + dx / 2,
      canvas.height / 2 + dy / 2,
    );
    gradient.addColorStop(0, background.from);
    gradient.addColorStop(1, background.to);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  } else {
    const gradient = ctx.createRadialGradient(
      canvas.width / 2, canvas.height / 2, 0,
      canvas.width / 2, canvas.height / 2, canvas.width * 0.75,
    );
    gradient.addColorStop(0, background.center);
    gradient.addColorStop(1, background.edge);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  payload.scene.polygons.forEach((polygon) => {
    ctx.beginPath();
    polygon.points.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });
    ctx.closePath();
    ctx.fillStyle = polygon.color;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.stroke();
  });

  payload.occluders.forEach((shape) => {
    ctx.save();
    ctx.translate(shape.cx, shape.cy);
    ctx.rotate(shape.rotation);
    ctx.beginPath();
    ctx.ellipse(0, 0, shape.rx, shape.ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = shape.color;
    ctx.fill();
    ctx.restore();
  });

  if (payload.overlay) {
    const palette = ['#f472b6', '#22d3ee', '#facc15', '#a3e635'];
    // Colore del pallino = visibilita' effettiva usata nel label: verde
    // acceso = visibile, ambra = occluso (ma etichettato), grigio = fuori
    // fotogramma. Verifica visiva che l'occlusore stia davvero abbassando la
    // visibilita' dei keypoint che copre, non solo esteticamente sopra.
    const visibilityColor = ['#94a3b8', '#f59e0b', '#22c55e'];
    payload.faces.forEach((face, faceIndex) => {
      const color = palette[faceIndex % palette.length];
      ctx.beginPath();
      face.corners.forEach((corner, index) => {
        if (index === 0) ctx.moveTo(corner.x, corner.y);
        else ctx.lineTo(corner.x, corner.y);
      });
      ctx.closePath();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = color;
      ctx.stroke();
      face.corners.forEach((corner) => {
        ctx.beginPath();
        ctx.arc(corner.x, corner.y, 5, 0, Math.PI * 2);
        ctx.fillStyle = visibilityColor[corner.visibility];
        ctx.fill();
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = '#0f172a';
        ctx.stroke();
      });
    });
  }

  return canvas.toDataURL('image/jpeg', 0.92);
}

type Sample = {
  scene: SceneRender;
  background: BackgroundSpec;
  occluders: OccluderEllipse[];
  faces: AnnotatedFace[];
  scramble: string;
  camera: CameraParams;
  light: LightParams;
};

function buildSample(): Sample {
  const scramble = randomScramble();
  const cube = CubeState.solved().applyMoves(parseAlgorithm(scramble));
  const facelets = cube.faceletRecord();
  const camera = randomCamera();
  const light = randomLight();
  const scene = buildScene(facelets, camera, light);
  const background = randomBackground();
  const occluders = scene.faces.length ? randomOccluders(sceneBounds(scene)) : [];
  const faces = annotateFaces(scene, occluders);
  return { scene, background, occluders, faces, scramble, camera, light };
}

async function generateSplit(
  page: import('playwright').Page,
  split: 'train' | 'val',
  count: number,
  overlay: boolean,
  manifest: fs.WriteStream,
) {
  const imagesDir = path.join(OUT_DIR, 'images', split);
  const labelsDir = path.join(OUT_DIR, 'labels', split);
  fs.mkdirSync(imagesDir, { recursive: true });
  fs.mkdirSync(labelsDir, { recursive: true });

  for (let index = 0; index < count; index += 1) {
    const sample = buildSample();
    const dataUrl: string = await page.evaluate(paintInBrowser, {
      scene: sample.scene,
      background: sample.background,
      occluders: sample.occluders,
      faces: sample.faces,
      overlay,
    });
    const base64 = dataUrl.replace(/^data:image\/jpeg;base64,/, '');
    const name = `${split}-${String(index).padStart(6, '0')}`;
    fs.writeFileSync(path.join(imagesDir, `${name}.jpg`), Buffer.from(base64, 'base64'));
    fs.writeFileSync(
      path.join(labelsDir, `${name}.txt`),
      toYoloLines(sample.faces, WIDTH, HEIGHT).join('\n') + (sample.faces.length ? '\n' : ''),
    );
    manifest.write(`${JSON.stringify({
      split,
      name,
      scramble: sample.scramble,
      faceCount: sample.faces.length,
      visibleFaces: sample.faces.map((f) => f.face) as Face[],
    })}\n`);

    if ((index + 1) % 200 === 0 || index === count - 1) {
      console.log(`[${split}] ${index + 1}/${count}`);
    }
  }
}

function writeDataYaml() {
  fs.writeFileSync(
    path.join(OUT_DIR, 'data.yaml'),
    [
      'path: .',
      'train: images/train',
      'val: images/val',
      'names:',
      '  0: cube_face',
      'kpt_shape: [4, 3]',
      '',
    ].join('\n'),
  );
}

async function main() {
  const trainCount = Number(process.argv[2] ?? 6000);
  const valCount = Number(process.argv[3] ?? 800);
  const overlay = process.argv.includes('--overlay');

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const manifest = fs.createWriteStream(path.join(OUT_DIR, 'manifest.jsonl'), { flags: 'w' });

  const browser = await chromium.launch({ executablePath: pinnedChromeExecutable(), headless: true });
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
  await page.setContent(`<canvas id="c" width="${WIDTH}" height="${HEIGHT}"></canvas>`);

  const startedAt = Date.now();
  await generateSplit(page, 'train', trainCount, overlay, manifest);
  await generateSplit(page, 'val', valCount, overlay, manifest);
  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);

  writeDataYaml();
  manifest.end();
  await browser.close();
  console.log(`\ntotale ${trainCount + valCount} immagini in ${elapsedSec}s -> ${OUT_DIR}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
