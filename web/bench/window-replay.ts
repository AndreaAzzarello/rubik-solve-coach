// Esperimento #21: replay in Node della stabilita' della finestra di ispezione.
//
//   node --experimental-strip-types bench/window-replay.ts [opzioni]
//
// Legge la cache di bench/window-cache.ts (eventi) e le scansioni strette di
// bench/window-scan.ts (bench/results/window-scans/) e, per ogni video:
// (1) S0: gli eventi rigiocati coincidono ESATTAMENTE con quelli del browser,
// (2) S0b: la finestra del replay (scansione stretta della stessa coppia) coincide
// con quella calcolata nel browser, (3) prove di perturbazione con i semi del #20.
// Non avvia browser ne' server: solo calcolo.
//
// BATCH: se mancano scansioni (coppie start/searchEnd) il replay NON le inventa:
// le scrive in --requests e termina con codice 5. Si lancia window-scan.ts, che
// le raccoglie in un solo lancio, e poi si rilancia il replay.
//
// Opzioni (i default riproducono il #20):
//   --stage baseline|full  baseline: solo S0, S0b e coppia di baseline; full: anche le prove (default)
//   --cache-dir DIR        eventi (default bench/results/window-cache)
//   --scans-dir DIR        scansioni (default bench/results/window-scans)
//   --requests FILE        coppie mancanti (default bench/results/window-scan-requests.json)
//   --out FILE             report JSON (default bench/results/window-replay.json)
//   --trials N             prove per video (default 12)
//   --noise A,B,...        ampiezze del rumore, frazioni (default 0.01; sweep: 0.003,0.01,0.02)
//   --seed-base N          seme base (default 20261013; fuori campione: 20261109)
//   --cases ID,ID          solo alcuni video (i semi usano comunque la posizione in cases.json)
//
// Codice di uscita: 0 ok; 3 S0 fallita (eventi diversi da quelli del browser);
// 5 scansioni mancanti (vedi --requests); 4 S0b scattata (finestra del replay
// diversa da quella di produzione in piu' di 1 video).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkEventFidelity,
  computeWindow,
  detectFromSamples,
  diffWindows,
  mergeRequests,
  runTrials,
  S0B_MAX_MISMATCHED_VIDEOS,
  windowMismatchVideos,
  type FidelityResult,
  type ScanRequest,
  type TrialResult,
  type VideoCache,
  type WindowDecision,
  type WindowDiff,
} from './lib/window-replay-core.ts';
import { loadScanFile, toStore, writeRequests } from './lib/scan-store-io.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED_BASE_20 = 20261013; // lo stesso del #20
const NOMINAL_FRAME_DURATION = 1 / 30;
const SIGNIFICANT_SHIFT_S = 0.5;

function arg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

interface NoiseReport {
  amplitude: number;
  significantChangeCount: number;
  completedTrials: number;
  trialCount: number;
  trials: TrialResult[];
}

interface VideoReport {
  caseId: string;
  group: string;
  fidelity: FidelityResult;
  /** Null se la scansione della coppia di baseline non e' ancora stata raccolta. */
  replayBaseline: WindowDecision | null;
  windowVsProduction: WindowDiff[];
  production: VideoCache['production'];
  byNoise: NoiseReport[];
}

function main(): number {
  const stage = arg('--stage') ?? 'full';
  if (stage !== 'baseline' && stage !== 'full') throw new Error(`--stage non valido: ${stage}`);
  const cacheDir = path.resolve(arg('--cache-dir') ?? path.join(HERE, 'results', 'window-cache'));
  const scansDir = path.resolve(arg('--scans-dir') ?? path.join(HERE, 'results', 'window-scans'));
  const requestsPath = path.resolve(arg('--requests') ?? path.join(HERE, 'results', 'window-scan-requests.json'));
  const outPath = path.resolve(arg('--out') ?? path.join(HERE, 'results', 'window-replay.json'));
  const trialCount = Number(arg('--trials') ?? 12);
  const amplitudes = (arg('--noise') ?? '0.01').split(',').map(Number);
  const seedBase = Number(arg('--seed-base') ?? SEED_BASE_20);
  const casesFilter = arg('--cases')?.split(',') ?? null;

  const raw = JSON.parse(fs.readFileSync(path.join(HERE, 'cases.json'), 'utf8')) as {
    cases: Array<{ id: string; group?: string }>;
  };
  const reports: VideoReport[] = [];
  const allMissing: ScanRequest[] = [];
  let fidelityFailures = 0;

  console.log(`[window-replay] fase=${stage} prove=${trialCount} rumore=${amplitudes.join(',')} seme base=${seedBase}`);
  console.log(`[window-replay] eventi: ${cacheDir} | scansioni: ${scansDir}`);

  raw.cases.forEach((entry, videoIndex) => {
    if (casesFilter && !casesFilter.includes(entry.id)) return;
    const file = path.join(cacheDir, `${entry.id}.json`);
    if (!fs.existsSync(file)) {
      console.log(`${entry.id}: cache eventi mancante, salto`);
      return;
    }
    const cache = JSON.parse(fs.readFileSync(file, 'utf8')) as VideoCache;
    const store = toStore(loadScanFile(scansDir, entry.id));
    const fidelity = checkEventFidelity(cache);
    if (!fidelity.exact) fidelityFailures += 1;

    const replayEvents = detectFromSamples(cache.samples, cache.meta.sampleInterval).events;
    const baselineOutcome = computeWindow(entry.id, replayEvents, cache.meta.duration, store);
    if (baselineOutcome.missing) allMissing.push(baselineOutcome.missing);
    const replayBaseline = baselineOutcome.window;
    const windowVsProduction = replayBaseline && cache.production ? diffWindows(replayBaseline, cache.production) : [];

    const byNoise: NoiseReport[] = stage === 'baseline' ? [] : amplitudes.map((amplitude) => {
      const summary = runTrials({
        caseId: entry.id,
        samples: cache.samples,
        store,
        duration: cache.meta.duration,
        sampleInterval: cache.meta.sampleInterval,
        trialCount,
        // stesso schema di semi del #20: base + posizione del video in cases.json * 1000
        seedBase: seedBase + videoIndex * 1000,
        amplitude,
        frameDuration: NOMINAL_FRAME_DURATION,
        significantShiftS: SIGNIFICANT_SHIFT_S,
      });
      allMissing.push(...summary.missing);
      return { amplitude, significantChangeCount: summary.significantChangeCount, completedTrials: summary.trials.length, trialCount, trials: summary.trials };
    });

    reports.push({ caseId: entry.id, group: entry.group ?? '?', fidelity, replayBaseline, windowVsProduction, production: cache.production, byNoise });

    const sig = byNoise.map((n) => `${(n.amplitude * 100).toFixed(1)}%:${n.completedTrials - n.significantChangeCount}/${n.completedTrials}${n.completedTrials < n.trialCount ? `(di ${n.trialCount})` : ''}`).join(' ');
    const windowText = replayBaseline
      ? `finestra replay ${replayBaseline.intervalStart.toFixed(2)}-${replayBaseline.intervalEnd.toFixed(2)}s ${replayBaseline.boundarySource} fasi=${replayBaseline.stageCount}`
      : 'finestra replay: scansione di baseline MANCANTE';
    const vsProd = !cache.production ? 'n/d' : !replayBaseline ? 'non valutabile'
      : windowVsProduction.length ? windowVsProduction.map((d) => `${d.field} ${d.replay}!=${d.production}`).join('; ') : 'identica';
    console.log(`${entry.id} [${entry.group ?? '?'}] eventi ${fidelity.exact ? 'ESATTI' : 'DIVERSI'} (${fidelity.replayEvents}/${fidelity.productionEvents}) | ${windowText} | vs produzione: ${vsProd}${sig ? ` | prove stabili ${sig}` : ''}`);
    if (!fidelity.exact) console.log(`  S0 FALLITA: ${fidelity.firstMismatch ?? 'soglia diversa'} (soglia uguale: ${fidelity.thresholdEqual})`);
  });

  console.log(`\nFedelta' S0: ${reports.length - fidelityFailures}/${reports.length} video con eventi esatti (confronto con gli eventi registrati nel browser)`);

  const missing = mergeRequests(allMissing);
  const evaluable = reports.filter((r) => r.production && r.replayBaseline).length;
  const mismatched = windowMismatchVideos(reports);
  console.log(`Finestra replay vs produzione: ${mismatched.length}/${evaluable} video con differenze (limite S0b: > ${S0B_MAX_MISMATCHED_VIDEOS}); ${reports.length - evaluable} non valutabili`);
  for (const r of mismatched) {
    console.log(`  ${r.caseId}: ${r.windowVsProduction.map((d) => `${d.field} replay=${d.replay} produzione=${d.production}`).join('; ')}`);
  }
  const s0bTriggered = mismatched.length > S0B_MAX_MISMATCHED_VIDEOS;
  if (s0bTriggered) {
    console.log("S0b SCATTATA: la finestra del replay non e' quella che l'app usa. FERMARSI e riportare al titolare prima di toccare il codice (P3).");
  }

  if (stage === 'full' && missing.length === 0) {
    // Criterio del #21: 12/12 prove stabili in almeno 12 video su 13 (rumore 1%).
    const primary = reports.map((r) => r.byNoise.find((n) => Math.abs(n.amplitude - 0.01) < 1e-9));
    if (primary.every(Boolean) && reports.length > 0) {
      const fullyStable = primary.filter((n) => n && n.significantChangeCount === 0).length;
      console.log(`Criterio (rumore 1%): video con tutte le prove stabili = ${fullyStable}/${reports.length} (obiettivo: >= 12/13)`);
    }
  }

  if (missing.length > 0) {
    writeRequests(requestsPath, missing);
    const videos = new Set(missing.map((m) => m.caseId)).size;
    console.log(`\nScansioni mancanti: ${missing.length} coppie su ${videos} video -> ${requestsPath}`);
    console.log('Lancia bench/window-scan.ts (batch) e poi rilancia il replay: i risultati sopra sono parziali.');
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({
    meta: { createdAt: new Date().toISOString(), stage, trialCount, amplitudes, seedBase, frameDuration: NOMINAL_FRAME_DURATION, significantShiftS: SIGNIFICANT_SHIFT_S, missingPairs: missing.length },
    reports,
  }, null, 1));
  console.log(`salvato: ${outPath}`);
  if (fidelityFailures > 0) return 3; // S0
  if (missing.length > 0) return 5; // scansioni mancanti
  return s0bTriggered ? 4 : 0; // S0b
}

process.exitCode = main();
