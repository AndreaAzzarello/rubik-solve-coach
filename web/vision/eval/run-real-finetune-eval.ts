// Confronto old vs new sui fotogrammi REALI di validazione annotati a mano
// (vision/annotate/), esclusi dal training: la priorita' e' questa, non il
// sintetico (che non ha mani ne' sfondo fotografico). Valuta due modelli
// ONNX sugli stessi frame (PCK + grid-cell hit-rate + recall, vedi
// vision/eval/keypoint-metrics.ts) e salva per ognuno un PNG con ground
// truth + predizioni di entrambi i modelli sovrapposte, per il controllo
// visivo.
//
//   node --experimental-strip-types vision/eval/run-real-finetune-eval.ts
//
// "val" qui e' lo split deciso in vision/annotate/frames/manifest.json (30
// fotogrammi assegnati), NON tutti annotati: 9 sono stati scartati in fase
// di annotazione (nessuna faccia visibile/utile), quindi la valutazione gira
// sui 21 che hanno davvero un'etichetta salvata (annotate/labels/*.txt) —
// sono questi la ground truth disponibile, non ce ne sono altri.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { pinnedChromeExecutable } from '../../bench/chrome-path.ts';
import { startStaticServer } from '../../bench/lib/static-server.ts';
import { FaceKeypointDetector, type FaceDetection } from '../inference/detector.ts';
import { parseYoloPoseLabels, type LabeledFace } from './yolo-label.ts';
import { accumulatePck, gridCellHitRate, matchInstances, type PckTally } from './keypoint-metrics.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, '..', '..');
const ANNOTATE_DIR = path.join(WEB_ROOT, 'vision', 'annotate');
const FRAMES_DIR = path.join(ANNOTATE_DIR, 'frames');
const LABELS_DIR = path.join(ANNOTATE_DIR, 'labels');
const MODELS_DIR = path.join(WEB_ROOT, 'vision', 'models');
const OUT_DIR = path.join(HERE, 'real-finetune-eval');
const PCK_THRESHOLD = 0.05; // 5% della diagonale faccia, stesso criterio del sintetico

type ManifestEntry = { id: string; video: string; time: number; split: 'train' | 'val' };
type RealSample = { id: string; imagePath: string; groundTruth: LabeledFace[] };

function loadRealValSamples(): RealSample[] {
  const manifest: ManifestEntry[] = JSON.parse(fs.readFileSync(path.join(FRAMES_DIR, 'manifest.json'), 'utf8'));
  const valIds = new Set(manifest.filter((e) => e.split === 'val').map((e) => e.id));

  const samples: RealSample[] = [];
  for (const id of valIds) {
    const txtPath = path.join(LABELS_DIR, `${id}.txt`);
    const jsonPath = path.join(LABELS_DIR, `${id}.json`);
    const imagePath = path.join(FRAMES_DIR, `${id}.jpg`);
    if (!fs.existsSync(txtPath) || !fs.existsSync(jsonPath) || !fs.existsSync(imagePath)) continue; // scartato in annotazione
    const meta = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as { width: number; height: number };
    const groundTruth = parseYoloPoseLabels(fs.readFileSync(txtPath, 'utf8'), meta.width, meta.height);
    samples.push({ id, imagePath, groundTruth });
  }
  return samples.sort((a, b) => a.id.localeCompare(b.id));
}

type ModelStats = {
  name: string;
  totalGt: number;
  totalMatched: number;
  totalUnmatchedPredictions: number;
  pckTallies: { overall: PckTally; visible: PckTally; occluded: PckTally };
  gridHits: number;
  gridTotal: number;
};

function emptyStats(name: string): ModelStats {
  return {
    name,
    totalGt: 0,
    totalMatched: 0,
    totalUnmatchedPredictions: 0,
    pckTallies: { overall: { correct: 0, total: 0 }, visible: { correct: 0, total: 0 }, occluded: { correct: 0, total: 0 } },
    gridHits: 0,
    gridTotal: 0,
  };
}

function pct(tally: PckTally): string {
  return tally.total ? `${((tally.correct / tally.total) * 100).toFixed(1)}%` : 'n/d';
}

function accumulate(stats: ModelStats, groundTruth: LabeledFace[], detections: FaceDetection[]): void {
  const predicted = detections.map((d) => ({ box: d.box, keypoints: d.keypoints.map(({ x, y }) => ({ x, y })) }));
  const result = matchInstances(groundTruth, predicted);
  stats.totalGt += result.groundTruthCount;
  stats.totalMatched += result.matchedCount;
  stats.totalUnmatchedPredictions += result.unmatchedPredictions;
  accumulatePck(result.instances, PCK_THRESHOLD, stats.pckTallies);
  const grid = gridCellHitRate(result.instances);
  stats.gridHits += grid.hits;
  stats.gridTotal += grid.total;
}

function printStats(stats: ModelStats): void {
  console.log(`\n  ## ${stats.name}`);
  console.log(`    recall                        ${stats.totalMatched}/${stats.totalGt} (${stats.totalGt ? ((stats.totalMatched / stats.totalGt) * 100).toFixed(1) : 'n/d'}%)`);
  console.log(`    predizioni senza riscontro     ${stats.totalUnmatchedPredictions}`);
  console.log(`    PCK@5% complessivo             ${pct(stats.pckTallies.overall)} (${stats.pckTallies.overall.correct}/${stats.pckTallies.overall.total})`);
  console.log(`    PCK@5% visibilita' alta (v=2)  ${pct(stats.pckTallies.visible)} (${stats.pckTallies.visible.correct}/${stats.pckTallies.visible.total})`);
  console.log(`    PCK@5% occlusi (v=1)           ${pct(stats.pckTallies.occluded)} (${stats.pckTallies.occluded.correct}/${stats.pckTallies.occluded.total})`);
  console.log(`    grid-cell hit-rate             ${stats.gridTotal ? ((stats.gridHits / stats.gridTotal) * 100).toFixed(1) : 'n/d'}% (${stats.gridHits}/${stats.gridTotal})`);
}

// In-browser: ricarica il fotogramma a piena risoluzione e disegna ground
// truth (giallo tratteggiato) + predizioni OLD (magenta) + NEW (ciano), cosi'
// il guadagno del fine-tuning si vede in un colpo d'occhio su una sola
// immagine invece di doverne confrontare due a schede separate.
async function renderComparison(args: {
  imageUrl: string;
  groundTruth: LabeledFace[];
  oldDetections: FaceDetection[];
  newDetections: FaceDetection[];
}): Promise<string> {
  const img = document.createElement('img');
  img.crossOrigin = 'anonymous';
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error(`impossibile caricare ${args.imageUrl}`));
    img.src = args.imageUrl;
  });
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);

  function drawQuad(points: Array<{ x: number; y: number }>, color: string, dashed: boolean) {
    ctx.beginPath();
    points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    ctx.lineWidth = 3;
    ctx.strokeStyle = color;
    ctx.setLineDash(dashed ? [10, 6] : []);
    ctx.stroke();
    ctx.setLineDash([]);
    points.forEach((p) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#0f172a';
      ctx.stroke();
    });
  }

  args.groundTruth.forEach((face) => drawQuad(face.keypoints, '#facc15', true));
  args.oldDetections.forEach((d) => drawQuad(d.keypoints, '#f472b6', false));
  args.newDetections.forEach((d) => drawQuad(d.keypoints, '#22d3ee', false));

  const legend = [
    ['#facc15', 'ground truth'],
    ['#f472b6', `OLD (best.onnx) — ${args.oldDetections.length} facce, score ${args.oldDetections.map((d) => d.score.toFixed(2)).join(', ') || 'nessuna'}`],
    ['#22d3ee', `NEW (fine-tuned) — ${args.newDetections.length} facce, score ${args.newDetections.map((d) => d.score.toFixed(2)).join(', ') || 'nessuna'}`],
  ] as const;
  legend.forEach(([color, label], index) => {
    const y = 10 + index * 22;
    ctx.fillStyle = 'rgba(15,23,42,0.75)';
    ctx.fillRect(6, y, Math.max(220, label.length * 7), 20);
    ctx.fillStyle = color;
    ctx.font = 'bold 13px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(label, 10, y + 3);
  });

  return canvas.toDataURL('image/png');
}

async function main() {
  const samples = loadRealValSamples();
  console.log(`fotogrammi reali di validazione con etichetta: ${samples.length}`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const server = await startStaticServer(FRAMES_DIR);
  const oldDetector = await FaceKeypointDetector.create(path.join(MODELS_DIR, 'best.onnx'));
  const newDetector = await FaceKeypointDetector.create(path.join(MODELS_DIR, 'cube-face-keypoints.onnx'));
  const browser = await chromium.launch({ executablePath: pinnedChromeExecutable(), headless: true });
  const page = await browser.newPage();
  await page.setContent('<!doctype html><html><body></body></html>');

  const oldStats = emptyStats('OLD · best.onnx (pre fine-tuning)');
  const newStats = emptyStats('NEW · cube-face-keypoints.onnx (fine-tuned su reale+sintetico)');

  for (const sample of samples) {
    const url = `http://127.0.0.1:${server.port}/${sample.id}.jpg`;
    const oldDetections = await oldDetector.detectFromImageUrl(url);
    const newDetections = await newDetector.detectFromImageUrl(url);

    accumulate(oldStats, sample.groundTruth, oldDetections);
    accumulate(newStats, sample.groundTruth, newDetections);

    const dataUrl = await page.evaluate(renderComparison, {
      imageUrl: url,
      groundTruth: sample.groundTruth,
      oldDetections,
      newDetections,
    });
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    fs.writeFileSync(path.join(OUT_DIR, `${sample.id}.png`), Buffer.from(base64, 'base64'));
    console.log(`${sample.id}: GT ${sample.groundTruth.length} · OLD ${oldDetections.length} · NEW ${newDetections.length}`);
  }

  await oldDetector.close();
  await newDetector.close();
  await browser.close();
  server.close();

  console.log('\n========================================================================');
  console.log(`\n# Valutazione REALE (val annotato a mano, ${samples.length} fotogrammi)`);
  printStats(oldStats);
  printStats(newStats);
  console.log(`\nimmagini con overlay salvate in ${OUT_DIR}`);
  console.log('\n========================================================================');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
