// Confronta rilevamento a 1 passaggio vs 2 passaggi (crop+zoom sul cubo,
// vedi FaceKeypointDetector.detectTwoPassFromImageUrl) con LO STESSO modello,
// sui 20 fotogrammi di test. Metrica PCK senza bias di selezione: ogni faccia
// etichettata non rilevata conta come 4 keypoint sbagliati (stesso
// denominatore fisso per entrambi, vedi compare-models-pck-unbiased.ts).
//
//   node --experimental-strip-types vision/eval/compare-two-pass-pck.ts [modello.onnx]
// (default: cube-face-keypoints.onnx)

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

function accumulateFromDetections(stats: ModelStats, groundTruth: LabeledFace[], detections: Awaited<ReturnType<FaceKeypointDetector['detectFromImageUrl']>>): void {
  const predicted = detections.map((d) => ({ box: d.box, keypoints: d.keypoints.map(({ x, y }) => ({ x, y })) }));
  const result = matchInstances(groundTruth, predicted);
  stats.totalGtFaces += groundTruth.length;
  stats.matchedFaces += result.matchedCount;

  const matchedSet = new Set(result.instances.map((i) => i.groundTruth));

  result.instances.forEach(({ groundTruth: gt, predictedKeypoints }) => {
    const diag = Math.hypot(gt.box.w, gt.box.h);
    gt.keypoints.forEach((gtPoint, index) => {
      if (gtPoint.visibility === 0) return;
      stats.pck.total += 1;
      const d = Math.hypot(predictedKeypoints[index].x - gtPoint.x, predictedKeypoints[index].y - gtPoint.y);
      if (d <= PCK_THRESHOLD * diag) stats.pck.correct += 1;
    });
  });

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

const MARGINS = process.env.TWO_PASS_MARGINS
  ? process.env.TWO_PASS_MARGINS.split(',').map(Number)
  : [0.8, 1.5, 2.5];

async function main() {
  const modelArg = process.argv[2] ?? 'cube-face-keypoints.onnx';
  const modelPath = resolveModelPath(modelArg);
  const modelLabel = path.basename(modelPath);

  const samples = loadTestSamples();
  if (samples.length === 0) {
    console.error("nessun fotogramma di test etichettato");
    process.exit(1);
  }
  const byVideo = new Map<string, Sample[]>();
  samples.forEach((sample) => byVideo.set(sample.video, [...(byVideo.get(sample.video) ?? []), sample]));
  console.log(`fotogrammi di test con etichetta: ${samples.length} (${[...byVideo.entries()].map(([v, s]) => `${v}: ${s.length}`).join(', ')})`);
  console.log(`modello = ${modelLabel}`);
  console.log('A = 1 passaggio (baseline)\nB.. = 2 passaggi con refine (mai meno facce del 1 passaggio), margini diversi');

  const server = await startStaticServer(FRAMES_DIR);
  const detector = await FaceKeypointDetector.create(modelPath);

  const overallA = emptyStats();
  const overallByMargin = new Map<number, ModelStats>(MARGINS.map((m) => [m, emptyStats()]));

  for (const [video, videoSamples] of byVideo) {
    const videoA = emptyStats();
    const videoByMargin = new Map<number, ModelStats>(MARGINS.map((m) => [m, emptyStats()]));
    for (const sample of videoSamples) {
      const imageUrl = `http://127.0.0.1:${server.port}/${sample.id}.jpg`;
      const detectionsA = await detector.detectFromImageUrl(imageUrl);
      accumulateFromDetections(videoA, sample.groundTruth, detectionsA);
      for (const margin of MARGINS) {
        const detectionsB = await detector.detectTwoPassRefineFromImageUrl(imageUrl, margin);
        accumulateFromDetections(videoByMargin.get(margin)!, sample.groundTruth, detectionsB);
      }
    }
    console.log(`\n# ${video} (${videoSamples.length} fotogrammi)`);
    printStats('A · 1 passaggio', videoA);
    MARGINS.forEach((margin) => printStats(`B(${margin}) · 2 passaggi refine`, videoByMargin.get(margin)!));
    addStats(overallA, videoA);
    MARGINS.forEach((margin) => addStats(overallByMargin.get(margin)!, videoByMargin.get(margin)!));
  }

  await detector.close();
  server.close();

  console.log('\n========================================================================');
  console.log(`\n# TOTALE (${samples.length} fotogrammi, ${byVideo.size} video)`);
  printStats('A · 1 passaggio', overallA);
  MARGINS.forEach((margin) => printStats(`B(${margin}) · 2 passaggi refine`, overallByMargin.get(margin)!));
  console.log('\n========================================================================');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
