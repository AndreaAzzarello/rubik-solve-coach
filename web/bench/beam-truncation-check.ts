// Approfondimento dell'esperimento #13 (vedi docs/pipeline-experiments.md):
// chiarisce la
// contraddizione apparente fra la diagnosi #12 (troncamento del beam search
// = 0/82 celle) e l'esperimento #13 (lo stato vero assente dai candidati in
// 6/9 casi, attribuibile "al troncamento"). Per ciascuno dei 6 casi: il
// troncamento (sawTruncation) e' davvero accaduto? Lo stato vero e'
// compatibile con le caselle gia' impegnate (unanimi fra tutti i candidati
// trovati), o una lettura impegnata e' sbagliata e ha fatto scartare il ramo
// giusto PRIMA che il troncamento potesse mai contare? Se si rimuove solo
// quella lettura e si rilancia la ricerca, lo stato vero compare?
//
// Seconda parte: valuta la disambiguazione interattiva (chiedere
// all'utente le caselle decisive) su tutti i 9 casi ambigui
// dell'esperimento #13, con un'importante correzione al calcolo delle
// "domande medie" di #13: quella simulazione filtrava i candidati per
// colore vero SENZA controllare se il filtro azzerava l'insieme (nessun
// candidato compatibile con le risposte) - qui si distingue esplicitamente
// successo (arriva a un solo candidato, quello vero) da contraddizione
// (le risposte dell'utente non sono compatibili con NESSUNO stato
// candidato trovato dal beam search).
//
// Solo diagnosi: nessuna modifica alla pipeline. reconstructInspectionState
// (lib/inspection-state.ts) e' una funzione pura (nessuna dipendenza dal
// browser): una sola passata nel browser per video cattura l'INPUT esatto
// (osservazioni fuse + sintetiche di bilanciamento, vedi
// __benchObservationsDiag in lib/video-decoder.ts) e i candidati trovati;
// il resto - rimuovere le letture sbagliate e rilanciare la ricerca - e'
// puro Node, nessun secondo giro di bench.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { startStaticServer } from './lib/static-server.ts';
import { startDevServer } from './lib/dev-server.ts';
import { pinnedChromeExecutable, CHROME_BUILD_ID } from './chrome-path.ts';
import { referenceFromScramble } from './lib/score.ts';
import { reconstructInspectionState, type FaceGridObservation, type PartialFacelets } from '../lib/inspection-state.ts';
import { CUBE_FACES, CANONICAL_COLOR_FACE, type CubeColor, type Face } from '../lib/cube.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, '..');
const RESULTS_DIR = path.join(HERE, 'results');

// I 6 video dell'esperimento #13 con "stato vero non presente" fra i
// candidati trovati (verificato contro bench/results/beam-ambiguity-
// photometric.json: sono 6, non 5).
const TRUNCATION_TARGET_VIDEOS = ['IMG_6297', 'IMG_6298', 'IMG_6299', 'IMG_6300', 'IMG_6336', 'IMG_6341'];
// Tutti i 9 casi ambigui di #13 (i 6 sopra + i 3 dove lo stato vero era
// presente a qualche rango).
const ALL_AMBIGUOUS_VIDEOS = [...TRUNCATION_TARGET_VIDEOS, 'IMG_6260', 'IMG_6281', 'IMG_6338'];

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
};

function log(...parts: unknown[]) {
  console.log('[beam-truncation]', ...parts);
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

type GreedyOutcome = {
  outcome: 'successo' | 'contraddizione' | 'convergenza-errata' | 'ambiguo-residuo';
  questions: number;
  remainingCount: number;
  trace: Array<{ face: Face; index: number }>;
};

// Come #13, ma distingue esplicitamente "arriva a un solo candidato, quello
// vero" da "le risposte azzerano l'insieme" (nessun candidato trovato dal
// beam search e' compatibile con le risposte vere dell'utente).
function greedyQuestionsWithOutcome(
  candidates: PartialFacelets[],
  cells: Array<{ face: Face; index: number }>,
  reference: Record<Face, CubeColor[]>,
): GreedyOutcome {
  let remaining = candidates;
  let remainingCells = cells;
  let questions = 0;
  const trace: Array<{ face: Face; index: number }> = [];
  while (remaining.length > 1 && remainingCells.length > 0) {
    let bestCell = remainingCells[0];
    let bestSurvivors = remaining.length + 1;
    remainingCells.forEach((cell) => {
      const trueColor = reference[cell.face][cell.index];
      const survivors = remaining.filter((c) => c[cell.face][cell.index] === trueColor).length;
      if (survivors < bestSurvivors) {
        bestSurvivors = survivors;
        bestCell = cell;
      }
    });
    const trueColor = reference[bestCell.face][bestCell.index];
    const next = remaining.filter((c) => c[bestCell.face][bestCell.index] === trueColor);
    remainingCells = remainingCells.filter((cell) => !(cell.face === bestCell.face && cell.index === bestCell.index));
    questions += 1;
    trace.push(bestCell);
    if (next.length === 0) {
      return { outcome: 'contraddizione', questions, remainingCount: 0, trace };
    }
    remaining = next;
  }
  if (remaining.length === 1) {
    return {
      outcome: matchesReference(remaining[0], reference) ? 'successo' : 'convergenza-errata',
      questions,
      remainingCount: 1,
      trace,
    };
  }
  return { outcome: 'ambiguo-residuo', questions, remainingCount: remaining.length, trace };
}

async function main() {
  const raw = JSON.parse(fs.readFileSync(path.join(HERE, 'cases.json'), 'utf8'));
  const videoDir = path.resolve(process.env.BENCH_VIDEO_DIR || raw.videoDir);
  const allCases = raw.cases as CaseSpec[];
  const cases = allCases.filter((c) => ALL_AMBIGUOUS_VIDEOS.includes(c.id));
  if (cases.length !== ALL_AMBIGUOUS_VIDEOS.length) {
    throw new Error(`casi non trovati in cases.json: attesi ${ALL_AMBIGUOUS_VIDEOS.join(',')}, trovati ${cases.map((c) => c.id).join(',')}`);
  }
  for (const entry of cases) {
    if (!fs.existsSync(path.join(videoDir, entry.video))) {
      throw new Error(`video mancante: ${entry.video} (imposta BENCH_VIDEO_DIR)`);
    }
  }

  const videoServer = await startStaticServer(videoDir);
  log(`server video pronto (porta ${videoServer.port})`);
  const dev = await startDevServer(WEB_ROOT, '[beam-truncation]', '/bench');
  log(`dev server pronto: ${dev.baseUrl}`);

  const chromeExecutable = pinnedChromeExecutable();
  const browser: Browser = await chromium.launch({
    headless: !process.env.BENCH_HEADFUL,
    executablePath: chromeExecutable,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu'],
  });
  log(`browser: Chrome for Testing ${CHROME_BUILD_ID} (pinnato)`);

  type TruncationReport = {
    id: string;
    truncated: boolean;
    candidateCount: number;
    wrongCommittedCells: Array<{ face: Face; index: number; got: CubeColor; truth: CubeColor }>;
    afterRemoval: null | { candidateCount: number; truePresent: boolean; trueRank: number | null };
    conclusion: string;
  };
  type InteractiveReport = { id: string; ambiguousCellCount: number } & GreedyOutcome;
  const truncationReports: TruncationReport[] = [];
  const interactiveReports: InteractiveReport[] = [];

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
    });
    page.on('console', (message) => {
      if (message.type() === 'error') log(`console.error: ${message.text()}`);
    });
    await page.goto(`${dev.baseUrl}/bench`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__benchReady === true, null, { timeout: 30000 });

    for (const entry of cases) {
      const videoUrl = `http://127.0.0.1:${videoServer.port}/${encodeURIComponent(entry.video)}`;
      log(`${entry.id} · ricostruzione in corso …`);
      await page.evaluate(() => {
        const w = window as unknown as Record<string, unknown>;
        w.__benchCandidateStatesDiag = [];
        w.__benchAlignmentFilteredObservations = [];
        w.__benchObservationsDiag = { observations: [], balancedInfo: { observedCells: 0, usable: false } };
      });
      const result: HarnessResult = await page.evaluate((url) => window.__benchReconstruct!(url), videoUrl);
      if (!result.ok || !result.candidateStates || !result.observationsDiag) {
        log(`  ✗ ${entry.id}: ${result.error || 'dati diagnostici assenti'}`);
        continue;
      }
      const reference = referenceFromScramble(entry.scramble);
      const candidates = result.candidateStates;

      // --- parte interattiva (tutti i 9 casi) ---
      const cells = ambiguousCells(candidates);
      const greedy = greedyQuestionsWithOutcome(candidates, cells, reference);
      log(`  → candidati: ${candidates.length} · celle ambigue: ${cells.length} · disambiguazione: ${greedy.outcome} in ${greedy.questions} domande`);
      interactiveReports.push({ id: entry.id, ambiguousCellCount: cells.length, ...greedy });

      // --- parte troncamento (solo i 6 target) ---
      if (!TRUNCATION_TARGET_VIDEOS.includes(entry.id)) continue;
      const committed = unanimousCells(candidates);
      const wrongCommittedCells = committed
        .filter((cell) => cell.color !== reference[cell.face][cell.index])
        .map((cell) => ({ face: cell.face, index: cell.index, got: cell.color, truth: reference[cell.face][cell.index] }));

      log(`    troncato: ${result.truncated} · caselle impegnate sbagliate: ${wrongCommittedCells.length}`);
      wrongCommittedCells.forEach((cell) => log(`        ${cell.face}#${cell.index}: letto ${cell.got}, vero ${cell.truth}`));

      let afterRemoval: TruncationReport['afterRemoval'] = null;
      const conclusion = result.truncated && !wrongCommittedCells.length
        ? 'troncamento'
        : !result.truncated && wrongCommittedCells.length
          ? 'caselle impegnate sbagliate'
          : result.truncated && wrongCommittedCells.length
            ? 'entrambi (troncamento + caselle impegnate sbagliate)'
            : 'nessuno dei due (da investigare)';

      if (wrongCommittedCells.length) {
        const modifiedObservations = removeReading(
          result.observationsDiag.observations,
          wrongCommittedCells.map((cell) => ({ face: cell.face, index: cell.index, color: cell.got })),
        );
        (globalThis as unknown as Record<string, unknown>).__benchCandidateStatesDiag = [];
        const rerun = reconstructInspectionState(modifiedObservations, result.observationsDiag.balancedInfo);
        const newCandidates = ((globalThis as unknown as Record<string, unknown>).__benchCandidateStatesDiag ?? []) as PartialFacelets[];
        const truePresent = newCandidates.some((c) => matchesReference(c, reference));
        let trueRank: number | null = null;
        if (truePresent && newCandidates.length > 1) {
          const rerunCells = ambiguousCells(newCandidates);
          const qualifying = qualifyingObservations(result.alignmentFilteredObservations ?? []);
          const scored = newCandidates
            .map((candidate) => ({ candidate, score: scoreCandidate(candidate, rerunCells, qualifying) }))
            .sort((a, b) => b.score - a.score);
          trueRank = scored.findIndex((entry2) => matchesReference(entry2.candidate, reference)) + 1;
        } else if (truePresent) {
          trueRank = 1;
        }
        afterRemoval = { candidateCount: rerun.candidateCount, truePresent, trueRank };
        log(`    dopo rimozione: candidati=${rerun.candidateCount}, stato vero presente=${truePresent}, rango=${trueRank ?? '-'}`);
      }

      truncationReports.push({
        id: entry.id,
        truncated: result.truncated ?? false,
        candidateCount: result.candidateCount ?? 0,
        wrongCommittedCells,
        afterRemoval,
        conclusion,
      });
    }
  } finally {
    await browser.close();
    await dev.close();
    videoServer.close();
  }

  console.log('\n' + '='.repeat(72));
  console.log('PARTE 1 - troncamento vs caselle impegnate sbagliate (6 casi)');
  truncationReports.forEach((r) => {
    console.log(`\n# ${r.id}`);
    console.log(`  troncato (sawTruncation): ${r.truncated}`);
    console.log(`  caselle impegnate che contraddicono la verità: ${r.wrongCommittedCells.length}`);
    r.wrongCommittedCells.forEach((cell) => console.log(`    ${cell.face}#${cell.index}: letto ${cell.got}, vero ${cell.truth}`));
    if (r.afterRemoval) {
      console.log(`  dopo rimozione di quelle letture: candidati=${r.afterRemoval.candidateCount}, stato vero presente=${r.afterRemoval.truePresent}, rango=${r.afterRemoval.trueRank ?? '-'}`);
    }
    console.log(`  conclusione: ${r.conclusion}`);
  });

  console.log('\n' + '='.repeat(72));
  console.log('PARTE 2 - disambiguazione interattiva (9 casi)');
  interactiveReports.forEach((r) => {
    console.log(`  ${r.id}: ${r.outcome} in ${r.questions} domande (celle ambigue: ${r.ambiguousCellCount}, candidati residui: ${r.remainingCount}), tracciato: ${r.trace.map((c) => `${c.face}#${c.index}`).join(', ')}`);
  });
  const successCount = interactiveReports.filter((r) => r.outcome === 'successo').length;
  const contradictionCount = interactiveReports.filter((r) => r.outcome === 'contraddizione').length;
  console.log(`\n  successo (arriva allo stato vero): ${successCount}/${interactiveReports.length}`);
  console.log(`  contraddizione (risposte vere incompatibili con ogni candidato trovato): ${contradictionCount}/${interactiveReports.length}`);
  console.log('='.repeat(72));

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const outPath = path.join(RESULTS_DIR, 'beam-truncation-check.json');
  fs.writeFileSync(outPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    truncationReports,
    interactiveReports,
    totals: { successCount, contradictionCount, total: interactiveReports.length },
  }, null, 2));
  log(`report salvato: ${path.relative(WEB_ROOT, outPath)}`);
}

main().catch((error) => {
  console.error('\n[beam-truncation] errore fatale:', error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
