// Variante di compare-models-pck.ts senza bias di selezione: il PCK normale
// conta solo le facce ABBINATE a una predizione, quindi un modello che perde
// recall sulle facce difficili puo' apparire piu' preciso (il denominatore si
// restringe alle facce facili). Qui ogni faccia etichettata non rilevata
// conta come 4 keypoint sbagliati, cosi' il totale e' sempre le 28 facce
// annotate, per entrambi i modelli.
//
//   node --experimental-strip-types vision/eval/compare-models-pck-unbiased.ts <modelloA.onnx> <modelloB.onnx>

import path from 'node:path';
import { startStaticServer } from '../../bench/lib/static-server.ts';
import { FaceKeypointDetector } from '../inference/detector.ts';
import type { LabeledFace } from './yolo-label.ts';
import { matchInstances, type PckTally } from './keypoint-metrics.ts';
import { FRAMES_DIR, loadTestSamples, resolveModelPath, type Sample } from './test-samples.ts';

const PCK_THRESHOLD = 0.05;

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

async function accumulate(stats: ModelStats, groundTruth: LabeledFace[], detector: FaceKeypointDetector, imageUrl: string, twoPassMargin?: number): Promise<void> {
  const detections = typeof twoPassMargin === 'number'
    ? await detector.detectTwoPassRefineFromImageUrl(imageUrl, twoPassMargin)
    : await detector.detectFromImageUrl(imageUrl);
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
  const twoPassMargin = process.env.TWO_PASS_MARGIN ? Number(process.env.TWO_PASS_MARGIN) : undefined;
  console.log(`A = ${labelA}\nB = ${labelB}${typeof twoPassMargin === 'number' ? ` (entrambi a 2 passaggi, margine ${twoPassMargin})` : ''}`);

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
      await accumulate(videoA, sample.groundTruth, detectorA, imageUrl, twoPassMargin);
      await accumulate(videoB, sample.groundTruth, detectorB, imageUrl, twoPassMargin);
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
