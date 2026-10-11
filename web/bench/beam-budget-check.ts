// Esperimento #14 (vedi docs/pipeline-experiments.md): la ricerca del beam
// search si ferma prima di trovare lo stato vero per mancanza di budget, o
// per le caselle impegnate sbagliate identificate nell'approfondimento
// dell'esperimento #13 (bench/beam-truncation-check.ts)?
//
// Parte 1: catalogo di tutti i limiti di budget della ricostruzione (vedi
// lib/inspection-state.ts), con quali sono stati raggiunti nei 6 casi
// (misurato via __benchBudgetTelemetry).
// Parte 2: sui 6 casi, DOPO aver rimosso le caselle impegnate sbagliate,
// rilancia reconstructInspectionState con budget x1/x4/x16/illimitato
// (timeout 10 minuti a caso, in un worker thread separato perche' la
// funzione e' sincrona e un timeout lato chiamante non la interromperebbe).
// Parte 3: come la parte 2 ma SENZA rimuovere le caselle sbagliate (sugli
// input di produzione reali).
//
// Solo diagnosi: nessuna modifica alla pipeline di produzione.
// reconstructInspectionState resta la stessa funzione pura usata in
// produzione; il moltiplicatore di budget (vedi benchBudgetMultiplier in
// lib/inspection-state.ts) e' letto da un global assente in produzione
// (default 1, comportamento bit-identico). Una sola passata nel browser per
// video cattura l'input esatto; tutto il resto (rimozione letture, rilancio
// a budget diversi) e' puro Node nei worker, nessun secondo giro di bench.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { chromium, type Browser } from 'playwright';
import { startStaticServer } from './lib/static-server.ts';
import { startDevServer } from './lib/dev-server.ts';
import { pinnedChromeExecutable, CHROME_BUILD_ID } from './chrome-path.ts';
import { referenceFromScramble } from './lib/score.ts';
import type { BenchBudgetTelemetry, FaceGridObservation, PartialFacelets } from '../lib/inspection-state.ts';
import { CUBE_FACES, CANONICAL_COLOR_FACE, type CubeColor, type Face } from '../lib/cube.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, '..');
const RESULTS_DIR = path.join(HERE, 'results');
const WORKER_TIMEOUT_MS = 10 * 60 * 1000;

const TARGET_VIDEOS = ['IMG_6297', 'IMG_6298', 'IMG_6299', 'IMG_6300', 'IMG_6336', 'IMG_6341'];
const BUDGETS: Array<{ label: string; multiplier: number }> = [
  { label: 'x1', multiplier: 1 },
  { label: 'x4', multiplier: 4 },
  { label: 'x16', multiplier: 16 },
  { label: 'illimitato', multiplier: Number.POSITIVE_INFINITY },
];

type CaseSpec = { id: string; video: string; scramble: string; group?: 'test' | 'integration' | 'seen' };
type ObservationDiag = FaceGridObservation;

type HarnessResult = {
  ok: boolean;
  error?: string;
  candidateCount?: number;
  truncated?: boolean;
  candidateStates?: PartialFacelets[];
  alignmentFilteredObservations?: ObservationDiag[];
  observationsDiag?: { observations: ObservationDiag[]; balancedInfo: { observedCells: number; usable: boolean } };
  budgetTelemetry?: BenchBudgetTelemetry;
  durationMs?: number;
};

function log(...parts: unknown[]) {
  console.log('[beam-budget]', ...parts);
}

function unanimousCells(candidates: PartialFacelets[]): Array<{ face: Face; index: number; color: CubeColor }> {
  const cells: Array<{ face: Face; index: number; color: CubeColor }> = [];
  CUBE_FACES.forEach((face) => {
    for (let index = 0; index < 9; index += 1) {
      if (index === 4) continue;
      const values = new Set(candidates.map((c) => c[face][index]));
      if (values.size === 1) cells.push({ face, index, color: [...values][0] as CubeColor });
    }
  });
  return cells;
}

function ambiguousCells(candidates: PartialFacelets[]): Array<{ face: Face; index: number }> {
  const cells: Array<{ face: Face; index: number }> = [];
  CUBE_FACES.forEach((face) => {
    for (let index = 0; index < 9; index += 1) {
      if (index === 4) continue;
      const values = new Set(candidates.map((c) => c[face][index]));
      if (values.size > 1) cells.push({ face, index });
    }
  });
  return cells;
}

function qualifyingObservations(observations: ObservationDiag[]): ObservationDiag[] {
  return observations.filter((o) => o.gridSource === 'model' && o.gridAlignmentIndex !== undefined && o.gridAlignmentIndex >= 6);
}

function scoreCandidate(
  candidate: PartialFacelets,
  cells: Array<{ face: Face; index: number }>,
  observations: ObservationDiag[],
): number {
  let score = 0;
  observations.forEach((observation) => {
    const face = CANONICAL_COLOR_FACE[observation.centerColor];
    cells.forEach((cell) => {
      if (cell.face !== face) return;
      const obsColor = observation.colors[cell.index];
      if (!obsColor) return;
      const confidence = observation.cellConfidences?.[cell.index] ?? observation.confidence;
      score += obsColor === candidate[cell.face][cell.index] ? confidence : -confidence;
    });
  });
  return score;
}

function matchesReference(candidate: PartialFacelets, reference: Record<Face, CubeColor[]>): boolean {
  return CUBE_FACES.every((face) => candidate[face].every((color, index) => color === reference[face][index]));
}

function removeReading(
  observations: ObservationDiag[],
  wrongCells: Array<{ face: Face; index: number; color: CubeColor }>,
): ObservationDiag[] {
  return observations.map((observation) => {
    const face = CANONICAL_COLOR_FACE[observation.centerColor];
    const toRemove = wrongCells.filter((cell) => cell.face === face && observation.colors[cell.index] === cell.color);
    if (!toRemove.length) return observation;
    const colors = [...observation.colors];
    const cellConfidences = observation.cellConfidences ? [...observation.cellConfidences] : undefined;
    const rawColors = observation.rawColors ? [...observation.rawColors] : undefined;
    let visibleCells = observation.visibleCells;
    toRemove.forEach((cell) => {
      colors[cell.index] = null;
      if (cellConfidences) cellConfidences[cell.index] = 0;
      if (rawColors) rawColors[cell.index] = null;
      visibleCells -= 1;
    });
    return { ...observation, colors, cellConfidences, rawColors, visibleCells };
  });
}

type WorkerOutput = {
  candidateCount: number;
  truncated: boolean;
  candidates: PartialFacelets[];
  budgetTelemetry: BenchBudgetTelemetry;
  elapsedMs: number;
};

function runInWorker(
  observations: ObservationDiag[],
  balancedInfo: { observedCells: number; usable: boolean },
  multiplier: number,
): Promise<WorkerOutput | { timeout: true }> {
  return new Promise((resolve, reject) => {
    const workerPath = path.join(HERE, 'beam-budget-worker.ts');
    const worker = new Worker(workerPath, {
      workerData: { observations, balancedInfo, multiplier },
      execArgv: process.execArgv,
    });
    const timer = setTimeout(() => {
      worker.terminate();
      resolve({ timeout: true });
    }, WORKER_TIMEOUT_MS);
    worker.once('message', (message: WorkerOutput) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(message);
    });
    worker.once('error', (error) => {
      clearTimeout(timer);
      worker.terminate();
      reject(error);
    });
  });
}

async function main() {
  const raw = JSON.parse(fs.readFileSync(path.join(HERE, 'cases.json'), 'utf8'));
  const videoDir = path.resolve(process.env.BENCH_VIDEO_DIR || raw.videoDir);
  const allCases = raw.cases as CaseSpec[];
  const cases = allCases.filter((c) => TARGET_VIDEOS.includes(c.id));
  if (cases.length !== TARGET_VIDEOS.length) {
    throw new Error(`casi non trovati in cases.json: attesi ${TARGET_VIDEOS.join(',')}, trovati ${cases.map((c) => c.id).join(',')}`);
  }
  for (const entry of cases) {
    if (!fs.existsSync(path.join(videoDir, entry.video))) {
      throw new Error(`video mancante: ${entry.video} (imposta BENCH_VIDEO_DIR)`);
    }
  }

  const videoServer = await startStaticServer(videoDir);
  log(`server video pronto (porta ${videoServer.port})`);
  const dev = await startDevServer(WEB_ROOT, '[beam-budget]', '/bench');
  log(`dev server pronto: ${dev.baseUrl}`);

  const chromeExecutable = pinnedChromeExecutable();
  const browser: Browser = await chromium.launch({
    headless: !process.env.BENCH_HEADFUL,
    executablePath: chromeExecutable,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu'],
  });
  log(`browser: Chrome for Testing ${CHROME_BUILD_ID} (pinnato)`);

  type VideoInput = {
    id: string;
    reference: Record<Face, CubeColor[]>;
    observations: ObservationDiag[];
    balancedInfo: { observedCells: number; usable: boolean };
    qualifying: ObservationDiag[];
    wrongCommittedCells: Array<{ face: Face; index: number; color: CubeColor }>;
    baselineTelemetry?: BenchBudgetTelemetry;
    baselineDurationMs?: number;
  };
  const inputs: VideoInput[] = [];

  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      const w = window as unknown as Record<string, unknown>;
      w.__benchFaceObservationDiag = {};
      w.__benchGridAlignmentSafeguardColors = [];
      w.__benchStableRawDiag = {};
      w.__benchModelGateAttempts = {};
      w.__benchCandidateStatesDiag = [];
      w.__benchAlignmentFilteredObservations = [];
      w.__benchObservationsDiag = { observations: [], balancedInfo: { observedCells: 0, usable: false } };
      w.__benchBudgetTelemetry = {};
    });
    page.on('console', (message) => {
      if (message.type() === 'error') log(`console.error: ${message.text()}`);
    });
    await page.goto(`${dev.baseUrl}/bench`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__benchReady === true, null, { timeout: 30000 });

    for (const entry of cases) {
      const videoUrl = `http://127.0.0.1:${videoServer.port}/${encodeURIComponent(entry.video)}`;
      log(`${entry.id} · catturo osservazioni e stato di base …`);
      await page.evaluate(() => {
        const w = window as unknown as Record<string, unknown>;
        w.__benchCandidateStatesDiag = [];
        w.__benchAlignmentFilteredObservations = [];
        w.__benchObservationsDiag = { observations: [], balancedInfo: { observedCells: 0, usable: false } };
        w.__benchBudgetTelemetry = {};
      });
      const result: HarnessResult = await page.evaluate((url) => window.__benchReconstruct!(url), videoUrl);
      if (!result.ok || !result.candidateStates || !result.observationsDiag) {
        log(`  ✗ ${entry.id}: ${result.error || 'dati diagnostici assenti'}`);
        continue;
      }
      const reference = referenceFromScramble(entry.scramble);
      const committed = unanimousCells(result.candidateStates);
      const wrongCommittedCells = committed.filter((cell) => cell.color !== reference[cell.face][cell.index]);
      log(`  → budget x1 (produzione): candidati=${result.candidateCount}, troncato=${result.truncated}, caselle impegnate sbagliate=${wrongCommittedCells.length}, tempo=${result.durationMs}ms`);
      log(`    telemetria budget: ${JSON.stringify(result.budgetTelemetry)}`);
      inputs.push({
        id: entry.id,
        reference,
        observations: result.observationsDiag.observations,
        balancedInfo: result.observationsDiag.balancedInfo,
        qualifying: qualifyingObservations(result.alignmentFilteredObservations ?? []),
        wrongCommittedCells,
        baselineTelemetry: result.budgetTelemetry,
        baselineDurationMs: result.durationMs,
      });
    }
  } finally {
    await browser.close();
    await dev.close();
    videoServer.close();
  }

  type BudgetRunReport = {
    video: string;
    variant: 'produzione' | 'senza-letture-sbagliate';
    budget: string;
    candidateCount: number;
    truncated: boolean;
    truePresent: boolean;
    trueRank: number | null;
    elapsedMs: number;
    timedOut: boolean;
  };
  const budgetReports: BudgetRunReport[] = [];

  for (const input of inputs) {
    for (const variant of ['produzione', 'senza-letture-sbagliate'] as const) {
      const observations = variant === 'produzione'
        ? input.observations
        : removeReading(input.observations, input.wrongCommittedCells);
      for (const { label, multiplier } of BUDGETS) {
        log(`${input.id} · ${variant} · budget ${label} · in esecuzione (timeout ${WORKER_TIMEOUT_MS / 60000} min) …`);
        const output = await runInWorker(observations, input.balancedInfo, multiplier);
        if ('timeout' in output) {
          log(`  ⏱ timeout`);
          budgetReports.push({
            video: input.id, variant, budget: label, candidateCount: 0, truncated: true,
            truePresent: false, trueRank: null, elapsedMs: WORKER_TIMEOUT_MS, timedOut: true,
          });
          continue;
        }
        const truePresent = output.candidates.some((c) => matchesReference(c, input.reference));
        let trueRank: number | null = null;
        if (truePresent) {
          if (output.candidates.length > 1) {
            const cells = ambiguousCells(output.candidates);
            const scored = output.candidates
              .map((candidate) => ({ candidate, score: scoreCandidate(candidate, cells, input.qualifying) }))
              .sort((a, b) => b.score - a.score);
            trueRank = scored.findIndex((entry) => matchesReference(entry.candidate, input.reference)) + 1;
          } else {
            trueRank = 1;
          }
        }
        log(`  → candidati=${output.candidateCount}, troncato=${output.truncated}, stato vero presente=${truePresent}, rango=${trueRank ?? '-'}, tempo=${output.elapsedMs.toFixed(0)}ms`);
        budgetReports.push({
          video: input.id, variant, budget: label, candidateCount: output.candidateCount,
          truncated: output.truncated, truePresent, trueRank, elapsedMs: output.elapsedMs, timedOut: false,
        });
      }
    }
  }

  // --- cross-reference con la diagnosi #12 per le categorie 5/6/7 ---
  type Cat12Lookup = { category: number; note?: string } | null;
  let diagnosis12: { videos: Array<{ id: string; faces: Array<{ face: Face; cells: Array<{ index: number; category: number; note?: string }> }> }> } | null = null;
  const diag12Path = path.join(RESULTS_DIR, 'missing-cells-diagnosis.json');
  if (fs.existsSync(diag12Path)) {
    diagnosis12 = JSON.parse(fs.readFileSync(diag12Path, 'utf8'));
  }
  function lookupCat12(videoId: string, face: Face, index: number): Cat12Lookup {
    const video = diagnosis12?.videos.find((v) => v.id === videoId);
    const faceEntry = video?.faces.find((f) => f.face === face);
    const cell = faceEntry?.cells.find((c) => c.index === index);
    return cell ? { category: cell.category, note: cell.note } : null;
  }

  console.log('\n' + '='.repeat(72));
  console.log('PARTE 1 - catalogo dei limiti di budget (file lib/inspection-state.ts)');
  console.log('  seedPool (fuseFaceObservationCandidates): riga 552-557, base 72');
  console.log('  hypotheses per faccia (chiamata con limit=18): riga 1445, base 18');
  console.log('  beamWidth / maximumRotationCombinations: riga 1557-1558, base 1600');
  console.log('  validStates cap nel loop principale: riga 1652 (validStatesMainCap), base 256');
  console.log('  enumeratePieceAssignments corners/edges (via completePartialFacelets): riga 995, base 768');
  console.log('  completePartialFacelets limit principale: riga 980 (default), base 96');
  console.log('  (ramo di rilassamento, non attivo nei 6 casi: diversifiedSources>=14 r.1598(circa),');
  console.log('   removable.slice(0,18) r.1616(circa), relaxations.slice(0,520) r.1637(circa),');
  console.log('   sourceSuccesses>=3/successfulRelaxations>=36/validStates>=320 r.1667-1669(circa))');
  console.log('\n  Quali limiti sono stati raggiunti nei 6 casi (telemetria budget x1):');
  inputs.forEach((input) => {
    console.log(`  ${input.id}: ${JSON.stringify(input.baselineTelemetry)}`);
  });

  console.log('\n' + '='.repeat(72));
  console.log('PARTE 2 e 3 - rilancio a budget diversi (produzione vs senza letture sbagliate)');
  for (const input of inputs) {
    console.log(`\n# ${input.id} (tempo di analisi attuale: ${input.baselineDurationMs}ms)`);
    for (const variant of ['produzione', 'senza-letture-sbagliate'] as const) {
      console.log(`  ${variant}:`);
      budgetReports.filter((r) => r.video === input.id && r.variant === variant).forEach((r) => {
        console.log(`    budget ${r.budget.padEnd(10)} candidati=${String(r.candidateCount).padEnd(6)} troncato=${String(r.truncated).padEnd(6)} vero presente=${String(r.truePresent).padEnd(6)} rango=${String(r.trueRank ?? '-').padEnd(4)} tempo=${r.timedOut ? 'TIMEOUT' : `${r.elapsedMs.toFixed(0)}ms`}`);
      });
    }
  }

  // --- esito ---
  console.log('\n' + '='.repeat(72));
  console.log('ESITO');
  const productionSuccessByBudget = BUDGETS.map(({ label }) => ({
    label,
    cases: budgetReports.filter((r) => r.variant === 'produzione' && r.budget === label && r.truePresent).map((r) => r.video),
  }));
  productionSuccessByBudget.forEach(({ label, cases: successCases }) => {
    console.log(`  produzione, budget ${label}: stato vero compare in ${successCases.length}/6 casi (${successCases.join(', ') || 'nessuno'})`);
  });
  const removedSuccessByBudget = BUDGETS.map(({ label }) => ({
    label,
    cases: budgetReports.filter((r) => r.variant === 'senza-letture-sbagliate' && r.budget === label && r.truePresent).map((r) => r.video),
  }));
  removedSuccessByBudget.forEach(({ label, cases: successCases }) => {
    console.log(`  senza letture sbagliate, budget ${label}: stato vero compare in ${successCases.length}/6 casi (${successCases.join(', ') || 'nessuno'})`);
  });

  const anyProductionSuccess = productionSuccessByBudget.some((b) => b.cases.length > 0);
  const anyRemovedSuccess = removedSuccessByBudget.some((b) => b.cases.length > 0);
  if (anyProductionSuccess) {
    console.log('\n  Il budget piu alto fa comparire lo stato vero gia sulla produzione reale.');
  } else if (anyRemovedSuccess) {
    console.log('\n  Compare SOLO dopo aver tolto le letture sbagliate: il collo di bottiglia sono');
    console.log('  le letture sbagliate, non il budget della ricerca. Da quali categorie #12 provengono:');
    inputs.forEach((input) => {
      console.log(`    ${input.id} (${input.wrongCommittedCells.length} caselle impegnate sbagliate):`);
      const byCategory: Record<number, number> = {};
      input.wrongCommittedCells.forEach((cell) => {
        const found = lookupCat12(input.id, cell.face, cell.index);
        const category = found?.category ?? -1;
        byCategory[category] = (byCategory[category] ?? 0) + 1;
        console.log(`      ${cell.face}#${cell.index}: categoria #12 = ${category === -1 ? 'non trovata (cella corretta o non classificata)' : category}${found?.note ? ` (${found.note})` : ''}`);
      });
      console.log(`      totali per categoria: ${JSON.stringify(byCategory)}`);
    });
  } else {
    console.log('\n  Lo stato vero non compare MAI, nemmeno a budget illimitato dopo aver tolto le');
    console.log('  letture sbagliate identificate. Ipotesi con dato a supporto: vedi telemetria');
    console.log('  budget sopra e docs/pipeline-experiments.md per l\'interpretazione.');
  }
  console.log('='.repeat(72));

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const outPath = path.join(RESULTS_DIR, 'beam-budget-check.json');
  fs.writeFileSync(outPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    baseline: inputs.map((input) => ({
      id: input.id,
      baselineTelemetry: input.baselineTelemetry,
      baselineDurationMs: input.baselineDurationMs,
      wrongCommittedCellCount: input.wrongCommittedCells.length,
      wrongCommittedCells: input.wrongCommittedCells.map((cell) => ({
        ...cell,
        cat12: lookupCat12(input.id, cell.face, cell.index),
      })),
    })),
    budgetReports,
  }, null, 2));
  log(`report salvato: ${path.relative(WEB_ROOT, outPath)}`);
}

main().catch((error) => {
  console.error('\n[beam-budget] errore fatale:', error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
