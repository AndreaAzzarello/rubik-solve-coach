// Valuta un modello ONNX (default vision/models/best.onnx) sul val set
// sintetico: PCK + grid-cell hit-rate (vision/eval/keypoint-metrics.ts) +
// recall/precisione a livello di istanza. Nessun training qui, solo misura.
//
//   node --experimental-strip-types vision/eval/run-synthetic-eval.ts [N] [modello.onnx]
//
// N opzionale: valuta solo le prime N immagini (utile per un giro rapido).
// modello.onnx opzionale: nome file dentro vision/models/ (default best.onnx).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer } from '../../bench/lib/static-server.ts';
import { FaceKeypointDetector } from '../inference/detector.ts';
import { parseYoloPoseLabels } from './yolo-label.ts';
import { accumulatePck, gridCellHitRate, matchInstances, type PckTally } from './keypoint-metrics.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, '..', '..');
const VAL_IMAGES_DIR = path.join(WEB_ROOT, 'vision', 'dataset', 'output', 'images', 'val');
const VAL_LABELS_DIR = path.join(WEB_ROOT, 'vision', 'dataset', 'output', 'labels', 'val');
const MODELS_DIR = path.join(WEB_ROOT, 'vision', 'models');
const IMAGE_SIZE = 512;
const PCK_THRESHOLD = 0.05; // 5% della diagonale faccia, vedi piano

function emptyTally(): PckTally {
  return { correct: 0, total: 0 };
}

function pct(tally: PckTally): string {
  return tally.total ? `${((tally.correct / tally.total) * 100).toFixed(1)}%` : 'n/d';
}

async function main() {
  const limit = process.argv[2] ? Number(process.argv[2]) : undefined;
  const modelName = process.argv[3] || 'best.onnx';
  const modelPath = path.join(MODELS_DIR, modelName);
  const files = fs.readdirSync(VAL_IMAGES_DIR).filter((f) => f.endsWith('.jpg')).sort();
  const selected = limit ? files.slice(0, limit) : files;

  const server = await startStaticServer(VAL_IMAGES_DIR);
  const detector = await FaceKeypointDetector.create(modelPath);

  let totalGt = 0;
  let totalMatched = 0;
  let totalUnmatchedPredictions = 0;
  let imagesWithPerfectRecall = 0;
  const pckTallies = { overall: emptyTally(), visible: emptyTally(), occluded: emptyTally() };
  let gridHits = 0;
  let gridTotal = 0;

  const startedAt = Date.now();
  for (let i = 0; i < selected.length; i += 1) {
    const file = selected[i];
    const labelPath = path.join(VAL_LABELS_DIR, file.replace(/\.jpg$/, '.txt'));
    const groundTruth = parseYoloPoseLabels(fs.readFileSync(labelPath, 'utf8'), IMAGE_SIZE, IMAGE_SIZE);

    const url = `http://127.0.0.1:${server.port}/${file}`;
    const detections = await detector.detectFromImageUrl(url);
    const predicted = detections.map((d) => ({ box: d.box, keypoints: d.keypoints.map(({ x, y }) => ({ x, y })) }));

    const result = matchInstances(groundTruth, predicted);
    totalGt += result.groundTruthCount;
    totalMatched += result.matchedCount;
    totalUnmatchedPredictions += result.unmatchedPredictions;
    if (result.matchedCount === result.groundTruthCount && result.unmatchedPredictions === 0) imagesWithPerfectRecall += 1;

    accumulatePck(result.instances, PCK_THRESHOLD, pckTallies);
    const grid = gridCellHitRate(result.instances);
    gridHits += grid.hits;
    gridTotal += grid.total;

    if ((i + 1) % 100 === 0 || i === selected.length - 1) {
      console.log(`[${i + 1}/${selected.length}] recall finora: ${totalMatched}/${totalGt}`);
    }
  }
  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);

  await detector.close();
  server.close();

  console.log('\n========================================================================\n');
  console.log(`# Valutazione sintetica · ${modelName} · ${selected.length} immagini · ${elapsedSec}s`);
  console.log(`\n  ISTANZE`);
  console.log(`    facce reali (ground truth)   ${totalGt}`);
  console.log(`    trovate (recall)             ${totalMatched}/${totalGt} (${((totalMatched / totalGt) * 100).toFixed(1)}%)`);
  console.log(`    predizioni senza riscontro    ${totalUnmatchedPredictions} (falsi positivi/facce allucinate)`);
  console.log(`    immagini con recall perfetta  ${imagesWithPerfectRecall}/${selected.length}`);
  console.log(`\n  PCK @ ${(PCK_THRESHOLD * 100).toFixed(0)}% della diagonale faccia (solo keypoint etichettati)`);
  console.log(`    complessivo                  ${pct(pckTallies.overall)} (${pckTallies.overall.correct}/${pckTallies.overall.total})`);
  console.log(`    visibilita' alta (v=2)       ${pct(pckTallies.visible)} (${pckTallies.visible.correct}/${pckTallies.visible.total})`);
  console.log(`    occlusi ma etichettati (v=1) ${pct(pckTallies.occluded)} (${pckTallies.occluded.correct}/${pckTallies.occluded.total})`);
  console.log(`\n  GRID-CELL HIT-RATE (9 celle per istanza accoppiata, tolleranza 1/6 passo cella)`);
  console.log(`    ${gridTotal ? ((gridHits / gridTotal) * 100).toFixed(1) : 'n/d'}% (${gridHits}/${gridTotal})`);
  console.log('\n========================================================================');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
