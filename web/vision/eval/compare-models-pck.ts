// Confronta due modelli ONNX qualsiasi sul PCK dei fotogrammi di TEST
// (split: 'test' in annotate/frames/manifest.json - mai entrati in
// training), separato per video. Il bench end-to-end e' tutto-o-niente
// (una faccia sbagliata rompe l'intero cubo): questa e' la metrica per
// decidere se un riaddestramento ha davvero migliorato il rilevatore,
// indipendente dal crollo a valle della fusione.
//
//   node --experimental-strip-types vision/eval/compare-models-pck.ts <modelloA.onnx> <modelloB.onnx>
//
// I nomi si risolvono dentro vision/models/ se non contengono uno slash,
// altrimenti sono presi come percorso (assoluto o relativo alla cwd).

import path from 'node:path';
import { startStaticServer } from '../../bench/lib/static-server.ts';
import { FaceKeypointDetector } from '../inference/detector.ts';
import type { LabeledFace } from './yolo-label.ts';
import { accumulatePck, gridCellHitRate, matchInstances, type PckTally } from './keypoint-metrics.ts';
import { FRAMES_DIR, loadTestSamples, resolveModelPath, type Sample } from './test-samples.ts';

const PCK_THRESHOLD = 0.05;

type ModelStats = {
  totalGt: number;
  totalMatched: number;
  totalUnmatchedPredictions: number;
  pckTallies: { overall: PckTally; visible: PckTally; occluded: PckTally };
  gridHits: number;
  gridTotal: number;
};

function emptyStats(): ModelStats {
  return {
    totalGt: 0,
    totalMatched: 0,
    totalUnmatchedPredictions: 0,
    pckTallies: { overall: { correct: 0, total: 0 }, visible: { correct: 0, total: 0 }, occluded: { correct: 0, total: 0 } },
    gridHits: 0,
    gridTotal: 0,
  };
}

function addStats(target: ModelStats, source: ModelStats): void {
  target.totalGt += source.totalGt;
  target.totalMatched += source.totalMatched;
  target.totalUnmatchedPredictions += source.totalUnmatchedPredictions;
  target.gridHits += source.gridHits;
  target.gridTotal += source.gridTotal;
  (['overall', 'visible', 'occluded'] as const).forEach((bucket) => {
    target.pckTallies[bucket].correct += source.pckTallies[bucket].correct;
    target.pckTallies[bucket].total += source.pckTallies[bucket].total;
  });
}

function pct(tally: PckTally): string {
  return tally.total ? `${((tally.correct / tally.total) * 100).toFixed(1)}%` : 'n/d';
}

async function accumulate(stats: ModelStats, groundTruth: LabeledFace[], detector: FaceKeypointDetector, imageUrl: string): Promise<void> {
  const detections = await detector.detectFromImageUrl(imageUrl);
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

function printStats(label: string, stats: ModelStats): void {
  console.log(`  ${label}`);
  console.log(`    recall                 ${stats.totalMatched}/${stats.totalGt} (${stats.totalGt ? ((stats.totalMatched / stats.totalGt) * 100).toFixed(1) : 'n/d'}%)`);
  console.log(`    falsi positivi          ${stats.totalUnmatchedPredictions}`);
  console.log(`    PCK@5%                  ${pct(stats.pckTallies.overall)} (${stats.pckTallies.overall.correct}/${stats.pckTallies.overall.total})`);
  console.log(`    grid-cell hit-rate      ${stats.gridTotal ? ((stats.gridHits / stats.gridTotal) * 100).toFixed(1) : 'n/d'}% (${stats.gridHits}/${stats.gridTotal})`);
}

async function main() {
  const [argA, argB] = process.argv.slice(2);
  if (!argA || !argB) {
    console.error('uso: node --experimental-strip-types vision/eval/compare-models-pck.ts <modelloA.onnx> <modelloB.onnx>');
    console.error('(nomi senza slash si risolvono dentro vision/models/)');
    process.exit(1);
  }
  const pathA = resolveModelPath(argA);
  const pathB = resolveModelPath(argB);
  const labelA = path.basename(pathA);
  const labelB = path.basename(pathB);

  const samples = loadTestSamples();
  if (samples.length === 0) {
    console.error("nessun fotogramma di test etichettato (split:'test' in annotate/frames/manifest.json)");
    process.exit(1);
  }
  const byVideo = new Map<string, Sample[]>();
  samples.forEach((sample) => {
    byVideo.set(sample.video, [...(byVideo.get(sample.video) ?? []), sample]);
  });
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
