// Esperimento #21: replay in Node della stabilita' della finestra di ispezione.
//
//   node --experimental-strip-types bench/window-replay.ts [opzioni]
//
// Legge la cache prodotta da bench/window-cache.ts (bench/results/window-cache/)
// e, per ogni video: (1) prova di fedelta' S0 (gli eventi rigiocati devono
// coincidere ESATTAMENTE con quelli di produzione), (2) confronto della finestra
// del replay con quella di produzione, (3) prove di perturbazione con i semi del
// #20. Non avvia browser ne' server: solo calcolo.
//
// Opzioni (i default riproducono il #20):
//   --cache-dir DIR       cartella della cache (default bench/results/window-cache)
//   --out FILE            report JSON (default bench/results/window-replay.json)
//   --trials N            prove per video (default 12)
//   --noise A,B,...       ampiezze del rumore, frazioni (default 0.01; sweep: 0.003,0.01,0.02)
//   --seed-base N         seme base (default 20261013; fuori campione: 20261109)
//   --cases ID,ID         solo alcuni video (i semi usano comunque la posizione in cases.json)
//
// Codice di uscita: 0 ok; 3 se la prova di fedelta' S0 fallisce (eventi diversi).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkEventFidelity,
  computeWindow,
  detectFromSamples,
  diffWindows,
  runTrials,
  type TrialSummary,
  type VideoCache,
  type WindowDiff,
  type FidelityResult,
} from './lib/window-replay-core.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED_BASE_20 = 20261013; // lo stesso del #20
const NOMINAL_FRAME_DURATION = 1 / 30;
const SIGNIFICANT_SHIFT_S = 0.5;

function arg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

interface VideoReport {
  caseId: string;
  group: string;
  fidelity: FidelityResult;
  windowVsProduction: WindowDiff[];
  replayBaseline: TrialSummary['baseline'];
  production: VideoCache['production'];
  byNoise: Array<{ amplitude: number; significantChangeCount: number; trialCount: number; trials: TrialSummary['trials'] }>;
}

function main(): number {
  const cacheDir = path.resolve(arg('--cache-dir') ?? path.join(HERE, 'results', 'window-cache'));
  const outPath = path.resolve(arg('--out') ?? path.join(HERE, 'results', 'window-replay.json'));
  const trialCount = Number(arg('--trials') ?? 12);
  const amplitudes = (arg('--noise') ?? '0.01').split(',').map(Number);
  const seedBase = Number(arg('--seed-base') ?? SEED_BASE_20);
  const casesFilter = arg('--cases')?.split(',') ?? null;

  const raw = JSON.parse(fs.readFileSync(path.join(HERE, 'cases.json'), 'utf8')) as {
    cases: Array<{ id: string; group?: string }>;
  };
  const reports: VideoReport[] = [];
  let fidelityFailures = 0;

  console.log(`[window-replay] cache: ${cacheDir}`);
  console.log(`[window-replay] prove=${trialCount} rumore=${amplitudes.join(',')} seme base=${seedBase}`);

  raw.cases.forEach((entry, videoIndex) => {
    if (casesFilter && !casesFilter.includes(entry.id)) return;
    const file = path.join(cacheDir, `${entry.id}.json`);
    if (!fs.existsSync(file)) {
      console.log(`${entry.id}: cache mancante, salto`);
      return;
    }
    const cache = JSON.parse(fs.readFileSync(file, 'utf8')) as VideoCache;
    const fidelity = checkEventFidelity(cache);
    if (!fidelity.exact) fidelityFailures += 1;

    const replayDetected = detectFromSamples(cache.samples, cache.meta.sampleInterval);
    const replayBaseline = computeWindow(replayDetected.events, cache.boundarySamples, cache.meta.duration, cache.meta.scanEnd);
    const windowVsProduction = cache.production ? diffWindows(replayBaseline, cache.production) : [];

    const byNoise = amplitudes.map((amplitude) => {
      const summary = runTrials({
        samples: cache.samples,
        boundarySamples: cache.boundarySamples,
        duration: cache.meta.duration,
        sampleInterval: cache.meta.sampleInterval,
        scanEnd: cache.meta.scanEnd,
        trialCount,
        // stesso schema di semi del #20: base + posizione del video in cases.json * 1000
        seedBase: seedBase + videoIndex * 1000,
        amplitude,
        frameDuration: NOMINAL_FRAME_DURATION,
        significantShiftS: SIGNIFICANT_SHIFT_S,
      });
      return { amplitude, significantChangeCount: summary.significantChangeCount, trialCount, trials: summary.trials };
    });

    reports.push({
      caseId: entry.id,
      group: entry.group ?? '?',
      fidelity,
      windowVsProduction,
      replayBaseline,
      production: cache.production,
      byNoise,
    });

    const sig = byNoise.map((n) => `${(n.amplitude * 100).toFixed(1)}%:${n.trialCount - n.significantChangeCount}/${n.trialCount}`).join(' ');
    console.log(
      `${entry.id} [${entry.group ?? '?'}] eventi ${fidelity.exact ? 'ESATTI' : 'DIVERSI'} (${fidelity.replayEvents}/${fidelity.productionEvents})`
      + ` | finestra replay ${replayBaseline.intervalStart.toFixed(2)}-${replayBaseline.intervalEnd.toFixed(2)}s ${replayBaseline.boundarySource}`
      + ` fasi=${replayBaseline.stageCount}`
      + ` | vs produzione: ${!cache.production ? 'n/d' : windowVsProduction.length ? windowVsProduction.map((d) => `${d.field} ${d.replay}!=${d.production}`).join('; ') : 'identica'}`
      + ` | prove stabili ${sig}`,
    );
    if (!fidelity.exact) console.log(`  S0 FALLITA: ${fidelity.firstMismatch ?? 'soglia diversa'} (soglia uguale: ${fidelity.thresholdEqual})`);
  });

  // Criterio del #21: 12/12 prove stabili in almeno 12 video su 13 (rumore 1%).
  const primary = reports.map((r) => r.byNoise.find((n) => Math.abs(n.amplitude - 0.01) < 1e-9));
  if (primary.every(Boolean) && reports.length > 0) {
    const fullyStable = primary.filter((n) => n && n.significantChangeCount === 0).length;
    console.log(`\nCriterio (rumore 1%): video con tutte le prove stabili = ${fullyStable}/${reports.length} (obiettivo: >= 12/13)`);
  }
  console.log(`Fedelta' S0: ${reports.length - fidelityFailures}/${reports.length} video con eventi esatti`);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({
    meta: { createdAt: new Date().toISOString(), trialCount, amplitudes, seedBase, frameDuration: NOMINAL_FRAME_DURATION, significantShiftS: SIGNIFICANT_SHIFT_S },
    reports,
  }, null, 1));
  console.log(`salvato: ${outPath}`);
  return fidelityFailures > 0 ? 3 : 0;
}

process.exitCode = main();
