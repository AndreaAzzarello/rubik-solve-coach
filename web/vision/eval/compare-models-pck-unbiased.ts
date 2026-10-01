// Variante di compare-models-pck.ts senza bias di selezione: il PCK normale
// conta solo le facce ABBINATE a una predizione, quindi un modello che perde
// recall sulle facce difficili puo' apparire piu' preciso (il denominatore si
// restringe alle facce facili). Qui ogni faccia etichettata non rilevata
// conta come 4 keypoint sbagliati, cosi' il totale e' sempre le 28 facce
// annotate, per entrambi i modelli.
//
//   node --experimental-strip-types vision/eval/compare-models-pck-unbiased.ts <modelloA.onnx> <modelloB.onnx>

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer } from '../../bench/lib/static-server.ts';
import { FaceKeypointDetector } from '../inference/detector.ts';
import { parseYoloPoseLabels, type LabeledFace } from './yolo-label.ts';
import { matchInstances, type PckTally } from './keypoint-metrics.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, '..', '..');
const ANNOTATE_DIR = path.join(WEB_ROOT, 'vision', 'annotate');
const FRAMES_DIR = path.join(ANNOTATE_DIR, 'frames');
const LABELS_DIR = path.join(ANNOTATE_DIR, 'labels');
const MODELS_DIR = path.join(WEB_ROOT, 'vision', 'models');
const PCK_THRESHOLD = 0.05;

function resolveModelPath(arg: string): string {
  const resolved = arg.includes('/') || arg.includes('\\') ? path.resolve(arg) : path.join(MODELS_DIR, arg);
  if (!fs.existsSync(resolved)) throw new Error(`modello non trovato: ${resolved}`);
  return resolved;
}

type ManifestEntry = { id: string; video: string; time: number; split: 'train' | 'val' | 'test' };
type Sample = { id: string; video: string; groundTruth: LabeledFace[] };

function loadTestSamples(): Sample[] {
  const manifest: ManifestEntry[] = JSON.parse(fs.readFileSync(path.join(FRAMES_DIR, 'manifest.json'), 'utf8'));
  const testIds = new Set(manifest.filter((e) => e.split === 'test').map((e) => e.id));

  const samples: Sample[] = [];
  for (const entry of manifest) {
    if (!testIds.has(entry.id)) continue;
    const txtPath = path.join(LABELS_DIR, `${entry.id}.txt`);
    const jsonPath = path.join(LABELS_DIR, `${entry.id}.json`);
    const imagePath = path.join(FRAMES_DIR, `${entry.id}.jpg`);
    if (!fs.existsSync(txtPath) || !fs.existsSync(jsonPath) || !fs.existsSync(imagePath)) continue;
    const meta = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as { width: number; height: number };
    const groundTruth = parseYoloPoseLabels(fs.readFileSync(txtPath, 'utf8'), meta.width, meta.height);
    samples.push({ id: entry.id, video: entry.video, groundTruth });
  }
  return samples.sort((a, b) => a.id.localeCompare(b.id));
}

type ModelStats = { totalGtFaces: number; matchedFaces: number; pck: PckTally };

function emptyStats(): ModelStats {
  return { totalGtFaces: 0, matchedFaces: 0, pck: { correct: 0, total: 0 } };
}

function addStats(target: ModelStats, source: ModelStats): void {
  target.totalGtFaces += source.totalGtFaces;
  target.matchedFaces += source.matchedFaces;
  target.pck.correct += source.pck.correct;
  target.pck.total += source.pck.total;
}

async function accumulate(stats: ModelStats, groundTruth: LabeledFace[], detector: FaceKeypointDetector, imageUrl: string): Promise<void> {
  const detections = await detector.detectFromImageUrl(imageUrl);
  const predicted = detections.map((d) => ({ box: d.box, keypoints: d.keypoints.map(({ x, y }) => ({ x, y })) }));
  const result = matchInstances(groundTruth, predicted);
  stats.totalGtFaces += groundTruth.length;
  stats.matchedFaces += result.matchedCount;

  const matchedSet = new Set(result.instances.map((i) => i.groundTruth));

  // facce abbinate: keypoint visibili entro soglia come al solito
  result.instances.forEach(({ groundTruth: gt, predictedKeypoints }) => {
    const diag = Math.hypot(gt.box.w, gt.box.h);
    gt.keypoints.forEach((gtPoint, index) => {
      if (gtPoint.visibility === 0) return;
      stats.pck.total += 1;
      const d = Math.hypot(predictedKeypoints[index].x - gtPoint.x, predictedKeypoints[index].y - gtPoint.y);
      if (d <= PCK_THRESHOLD * diag) stats.pck.correct += 1;
    });
  });

  // facce NON abbinate: ogni keypoint visibile conta come sbagliato (nessun bonus al denominatore ristretto)
  groundTruth.filter((gt) => !matchedSet.has(gt)).forEach((gt) => {
    gt.keypoints.forEach((gtPoint) => {
      if (gtPoint.visibility === 0) return;
      stats.pck.total += 1;
    });
  });
}

function printStats(label: string, stats: ModelStats): void {
  const pckPct = stats.pck.total ? ((stats.pck.correct / stats.pck.total) * 100).toFixed(1) : 'n/d';
  console.log(`  ${label}`);
  console.log(`    facce rilevate           ${stats.matchedFaces}/${stats.totalGtFaces}`);
  console.log(`    PCK@5% senza bias        ${pckPct}% (${stats.pck.correct}/${stats.pck.total})`);
}

async function main() {
  const [argA, argB] = process.argv.slice(2);
  if (!argA || !argB) {
    console.error('uso: node --experimental-strip-types vision/eval/compare-models-pck-unbiased.ts <modelloA.onnx> <modelloB.onnx>');
    process.exit(1);
  }
  const pathA = resolveModelPath(argA);
  const pathB = resolveModelPath(argB);
  const labelA = path.basename(pathA);
  const labelB = path.basename(pathB);

  const samples = loadTestSamples();
  if (samples.length === 0) {
    console.error("nessun fotogramma di test etichettato");
    process.exit(1);
  }
  const byVideo = new Map<string, Sample[]>();
  samples.forEach((sample) => byVideo.set(sample.video, [...(byVideo.get(sample.video) ?? []), sample]));
  console.log(`fotogrammi di test con etichetta: ${samples.length} (${[...byVideo.entries()].map(([v, s]) => `${v}: ${s.length}`).join(', ')})`);
  console.log(`A = ${labelA}\nB = ${labelB}`);

  const server = await startStaticServer(FRAMES_DIR);
  const detectorA = await FaceKeypointDetector.create(pathA);
  const detectorB = await FaceKeypointDetector.create(pathB);

  const overallA = emptyStats();
  const overallB = emptyStats();

  for (const [video, videoSamples] of byVideo) {
    const videoA = emptyStats();
    const videoB = emptyStats();
    for (const sample of videoSamples) {
      const imageUrl = `http://127.0.0.1:${server.port}/${sample.id}.jpg`;
      await accumulate(videoA, sample.groundTruth, detectorA, imageUrl);
      await accumulate(videoB, sample.groundTruth, detectorB, imageUrl);
    }
    console.log(`\n# ${video} (${videoSamples.length} fotogrammi)`);
    printStats(`A · ${labelA}`, videoA);
    printStats(`B · ${labelB}`, videoB);
    addStats(overallA, videoA);
    addStats(overallB, videoB);
  }

  await detectorA.close();
  await detectorB.close();
  server.close();

  console.log('\n========================================================================');
  console.log(`\n# TOTALE (${samples.length} fotogrammi, ${byVideo.size} video)`);
  printStats(`A · ${labelA}`, overallA);
  printStats(`B · ${labelB}`, overallB);
  console.log('\n========================================================================');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
