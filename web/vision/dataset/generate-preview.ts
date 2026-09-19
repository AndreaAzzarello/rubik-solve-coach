// Controllo di correttezza dell'annotazione, PRIMA di generare il dataset
// sintetico vero. Genera N immagini con cubi scramblati a caso, ci disegna
// sopra i 4 keypoint per faccia calcolati da scene.ts (che a sua volta usa
// SOLO la geometria derivata da lib/cube.ts, vedi cube-geometry.ts), e salva
// PNG + annotazione JSON. Nessun training qui: e' solo il gate visivo del
// piano ("mostrami alcune immagini con i keypoint sovrapposti").
//
//   node --experimental-strip-types vision/dataset/generate-preview.ts [N]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { pinnedChromeExecutable } from '../../bench/chrome-path.ts';
import { CubeState, parseAlgorithm, CUBE_FACES, type Face } from '../../lib/cube.ts';
import { buildScene, type SceneRender } from './scene.ts';
import type { CameraParams } from './camera.ts';

type PaintPayload = { scene: SceneRender; overlay: boolean; background: string };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, 'debug');

const WIDTH = 512;
const HEIGHT = 512;

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

// Raggio della sfera circoscritta al cubo (meta'-spigolo 1.5, angolo piu'
// lontano dal centro a distanza 1.5*sqrt(3)). Usato per garantire che
// l'intero cubo stia in cornice qualunque sia l'azimuth (vista "di spigolo"
// inclusa), invece di un range distanza/FOV indipendenti scelto a caso: il
// primo tentativo (distanza 4.5-7, FOV 35-55°) tagliava fuori dal fotogramma
// gli angoli esterni in molti campioni (verificato: gli angoli condivisi tra
// facce coincidevano correttamente, quindi non era un bug di proiezione, solo
// un inquadratura troppo stretta).
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

// Eseguita DENTRO il browser via page.evaluate: nessuna conoscenza del cubo,
// solo un pittore generico di poligoni + overlay di debug.
function paintInBrowser(payload: PaintPayload): string {
  const canvas = document.getElementById('c') as HTMLCanvasElement;
  canvas.width = payload.scene.width;
  canvas.height = payload.scene.height;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = payload.background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

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

  if (payload.overlay) {
    const palette = ['#f472b6', '#22d3ee', '#facc15', '#a3e635'];
    payload.scene.faces.forEach((face, faceIndex) => {
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

      face.corners.forEach((corner, index) => {
        ctx.beginPath();
        ctx.arc(corner.x, corner.y, 6, 0, Math.PI * 2);
        ctx.fillStyle = corner.visible ? color : '#94a3b8';
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = '#0f172a';
        ctx.stroke();
        ctx.fillStyle = '#0f172a';
        ctx.font = 'bold 11px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(index), corner.x, corner.y - 11);
      });

      ctx.fillStyle = 'rgba(15,23,42,0.75)';
      ctx.fillRect(6, 6 + faceIndex * 16, 60, 14);
      ctx.fillStyle = color;
      ctx.font = 'bold 11px ui-monospace, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(face.face, 12, 13 + faceIndex * 16);
    });
  }

  return canvas.toDataURL('image/png');
}

async function main() {
  const count = Number(process.argv[2] ?? 8);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({
    executablePath: pinnedChromeExecutable(),
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
  await page.setContent(`<canvas id="c" width="${WIDTH}" height="${HEIGHT}"></canvas>`);

  const backgrounds = ['#1e293b', '#e2e8f0', '#475569', '#f8fafc'];

  for (let index = 0; index < count; index += 1) {
    const scramble = randomScramble();
    const cube = CubeState.solved().applyMoves(parseAlgorithm(scramble));
    const facelets = cube.faceletRecord();
    const camera = randomCamera();
    // Luce neutra (ambient 1 => nessuna ombreggiatura): questo script resta il
    // controllo geometrico "piatto" gia' validato; la resa con luce/sfondo/
    // occlusore vera vive in generate-dataset.ts.
    const flatLight = { direction: { x: 0, y: 1, z: 0 }, ambient: 1, intensity: 1, colorTint: [1, 1, 1] as [number, number, number] };
    const scene: SceneRender = buildScene(facelets, camera, flatLight);
    const background = backgrounds[index % backgrounds.length];

    const dataUrl: string = await page.evaluate(paintInBrowser, { scene, overlay: true, background });
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    const filename = `sample-${String(index).padStart(2, '0')}`;
    fs.writeFileSync(path.join(OUT_DIR, `${filename}.png`), Buffer.from(base64, 'base64'));
    fs.writeFileSync(
      path.join(OUT_DIR, `${filename}.json`),
      JSON.stringify({ scramble, camera, faces: scene.faces }, null, 2),
    );

    const visibleFaces: Face[] = scene.faces.map((f) => f.face);
    const missing = CUBE_FACES.filter((f) => !visibleFaces.includes(f));
    console.log(`[${filename}] facce visibili: ${visibleFaces.join(',')} (nascoste: ${missing.join(',')})`);
  }

  await browser.close();
  console.log(`\nsalvati ${count} campioni in ${OUT_DIR}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
