// Esperimento #13 (vedi docs/pipeline-experiments.md): per le caselle vuote
// per ambiguita' del beam search (categoria 4, sotto-causa 1 della diagnosi
// #12 - piu' stati-cubo completi e fisicamente validi, nessuno unico),
// verifica se le letture fotometriche grezze bastano a scegliere quale
// candidato e' quello vero.
//
// NON e' la variante A (#11, scartata): la' si forzava l'uso
// dell'osservazione di un singolo fotogramma al posto della fusione
// multi-frame. Qui gli stati candidati sono gia' tutti fisicamente validi
// (passano i vincoli dei pezzi); si tratta solo di SCEGLIERE fra loro con
// l'evidenza fotometrica sulle celle dove differiscono - non di impegnare
// celle che oggi restano vuote per mancanza di lettura.
//
// Solo diagnosi: nessuna modifica alla pipeline. Usa la stessa pipeline del
// bench normale, a soglia di produzione (nessun override), con due
// strumentazioni solo-bench aggiuntive (stesso schema lazy, no-op se il
// global non e' predisposto dalla pagina bench):
//   - lib/inspection-state.ts: __benchCandidateStatesDiag (TUTTI gli stati-
//     cubo completi trovati dal beam search, non solo il primo)
//   - lib/video-decoder.ts: __benchAlignmentFilteredObservations (le
//     osservazioni-modello grezze per fotogramma sopravvissute al filtro di
//     allineamento, salvaguardia compresa - distinguibile dal proprio
//     gridAlignmentIndex)
//
// Formula del punteggio di coerenza fotometrica (per candidato, sulle sole
// celle dove i candidati differiscono): per ogni osservazione-modello che ha
// SUPERATO il filtro di allineamento con indice >= 6 (NON la salvaguardia:
// quella tiene letture sotto soglia per non perdere la faccia, non e' una
// lettura "passata"), e per ogni cella ambigua che quell'osservazione ha
// letto: +confidenza (0-100, derivata da CIEDE2000 in classifyCalibratedColor,
// vedi lib/color-calibration.ts) se il colore dell'osservazione coincide con
// quello del candidato in quella cella, -la stessa confidenza se non
// coincide. Il punteggio del candidato e' la somma su tutte le osservazioni
// e tutte le celle ambigue.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { startStaticServer } from './lib/static-server.ts';
import { startDevServer } from './lib/dev-server.ts';
import { pinnedChromeExecutable, CHROME_BUILD_ID } from './chrome-path.ts';
import { referenceFromScramble } from './lib/score.ts';
import { CUBE_FACES, CANONICAL_COLOR_FACE, type CubeColor, type Face } from '../lib/cube.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, '..');
const RESULTS_DIR = path.join(HERE, 'results');

type CaseSpec = { id: string; video: string; scramble: string; group?: 'test' | 'integration' | 'seen' };

type PartialFacelets = Record<Face, Array<CubeColor | null>>;

type ObservationDiag = {
  centerColor: CubeColor;
  colors: Array<CubeColor | null>;
  cellConfidences?: number[];
  confidence: number;
  gridSource?: 'silhouette' | 'pairs' | 'model';
  gridAlignmentIndex?: number;
};

type HarnessResult = {
  ok: boolean;
  error?: string;
  facelets?: Record<Face, Array<CubeColor | null>>;
  candidateCount?: number;
  truncated?: boolean;
  candidateStates?: PartialFacelets[];
  alignmentFilteredObservations?: ObservationDiag[];
};

function log(...parts: unknown[]) {
  console.log('[beam-ambiguity]', ...parts);
}

// Celle (face,index) dove non tutti i candidati sono d'accordo (centro
// escluso). NOTA: e' un soprainsieme delle 77 celle di sotto-causa 1 della
// diagnosi #12 (bench/missing-cells-diagnosis.ts) - quella richiedeva anche
// una lettura diretta pre-beam-search sulla cella (diag.colors[index] non
// nullo), qui si conta ogni disaccordo fra candidati completi, compresi
// quelli dove nessuna singola osservazione aveva mai letto quella casella.
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

// Simulazione greedy: quante domande (quale cella chiedere) servono per
// arrivare a un solo candidato, chiedendo sempre la cella che su questo
// sottoinsieme di candidati massimizza la riduzione SE l'utente risponde
// con il colore vero (quello della verita' dello scramble - l'utente guarda
// il cubo reale, non indovina).
function greedyQuestions(
  candidates: PartialFacelets[],
  cells: Array<{ face: Face; index: number }>,
  reference: Record<Face, CubeColor[]>,
): { questions: number; firstBestCell: { face: Face; index: number } | null } {
  let remaining = candidates;
  let remainingCells = cells;
  let questions = 0;
  let firstBestCell: { face: Face; index: number } | null = null;
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
    if (questions === 0) firstBestCell = bestCell;
    const trueColor = reference[bestCell.face][bestCell.index];
    remaining = remaining.filter((c) => c[bestCell.face][bestCell.index] === trueColor);
    remainingCells = remainingCells.filter((cell) => !(cell.face === bestCell.face && cell.index === bestCell.index));
    questions += 1;
  }
  return { questions, firstBestCell };
}

async function main() {
  const raw = JSON.parse(fs.readFileSync(path.join(HERE, 'cases.json'), 'utf8'));
  const videoDir = path.resolve(process.env.BENCH_VIDEO_DIR || raw.videoDir);
  const cases = raw.cases as CaseSpec[];
  for (const entry of cases) {
    if (!fs.existsSync(path.join(videoDir, entry.video))) {
      throw new Error(`video mancante: ${entry.video} (imposta BENCH_VIDEO_DIR)`);
    }
  }

  const videoServer = await startStaticServer(videoDir);
  log(`server video pronto (porta ${videoServer.port})`);
  const dev = await startDevServer(WEB_ROOT, '[beam-ambiguity]', '/bench');
  log(`dev server pronto: ${dev.baseUrl}`);

  const chromeExecutable = pinnedChromeExecutable();
  const browser: Browser = await chromium.launch({
    headless: !process.env.BENCH_HEADFUL,
    executablePath: chromeExecutable,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu'],
  });
  log(`browser: Chrome for Testing ${CHROME_BUILD_ID} (pinnato)`);

  type CaseReport = {
    id: string;
    group?: string;
    ambiguousCellCount: number;
    candidateCount: number;
    truncated: boolean;
    trueRank: number | null;
    margin: number | null;
    recoveredCorrect: number;
    newlyWrong: number;
    questions: number | null;
    firstBestCell: string | null;
  };
  const reports: CaseReport[] = [];

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
      });
      const result: HarnessResult = await page.evaluate((url) => window.__benchReconstruct!(url), videoUrl);
      if (!result.ok || !result.facelets) {
        log(`  ✗ ${entry.id}: ${result.error || 'esito non valido'}`);
        continue;
      }
      const candidates = result.candidateStates ?? [];
      const cells = candidates.length > 1 ? ambiguousCells(candidates) : [];
      log(`  → candidati: ${result.candidateCount ?? 0} (troncato: ${result.truncated ?? false}) · celle ambigue: ${cells.length}`);
      if (!cells.length) {
        reports.push({
          id: entry.id, group: entry.group, ambiguousCellCount: 0,
          candidateCount: result.candidateCount ?? 0, truncated: result.truncated ?? false,
          trueRank: null, margin: null, recoveredCorrect: 0, newlyWrong: 0, questions: null, firstBestCell: null,
        });
        continue;
      }
      const reference = referenceFromScramble(entry.scramble);
      const qualifying = qualifyingObservations(result.alignmentFilteredObservations ?? []);
      const scored = candidates.map((candidate) => ({
        candidate,
        score: scoreCandidate(candidate, cells, qualifying),
      })).sort((a, b) => b.score - a.score);

      const trueIndex = scored.findIndex((entry2) => matchesReference(entry2.candidate, reference));
      const trueRank = trueIndex >= 0 ? trueIndex + 1 : null;
      const margin = scored.length >= 2 ? scored[0].score - scored[1].score : null;

      const topCandidate = scored[0].candidate;
      let recoveredCorrect = 0;
      let newlyWrong = 0;
      cells.forEach((cell) => {
        if (topCandidate[cell.face][cell.index] === reference[cell.face][cell.index]) recoveredCorrect += 1;
        else newlyWrong += 1;
      });

      const { questions, firstBestCell } = greedyQuestions(candidates, cells, reference);

      log(`    candidati ordinati: ${scored.length} · rango stato vero: ${trueRank ?? 'non presente'} · margine 1°-2°: ${margin?.toFixed(1) ?? '-'}`);
      log(`    scegliendo il 1°: ${recoveredCorrect} recuperate, ${newlyWrong} diventerebbero sbagliate`);
      log(`    domande necessarie (greedy, verso lo stato vero): ${questions}, prima domanda: ${firstBestCell ? `${firstBestCell.face}#${firstBestCell.index}` : '-'}`);

      reports.push({
        id: entry.id,
        group: entry.group,
        ambiguousCellCount: cells.length,
        candidateCount: result.candidateCount ?? 0,
        truncated: result.truncated ?? false,
        trueRank,
        margin,
        recoveredCorrect,
        newlyWrong,
        questions,
        firstBestCell: firstBestCell ? `${firstBestCell.face}#${firstBestCell.index}` : null,
      });
    }
  } finally {
    await browser.close();
    await dev.close();
    videoServer.close();
  }

  // --- aggregazione ---
  const ambiguousCases = reports.filter((r) => r.ambiguousCellCount > 0);
  console.log('\n' + '='.repeat(72));
  console.log('CASI AMBIGUI PER VIDEO');
  ambiguousCases.forEach((r) => {
    console.log(`  ${r.id}: celle=${r.ambiguousCellCount}, candidati=${r.candidateCount}, troncato=${r.truncated}, rango vero=${r.trueRank ?? 'non presente'}, margine=${r.margin?.toFixed(1) ?? '-'}, recuperate=${r.recoveredCorrect}, sbagliate=${r.newlyWrong}, domande=${r.questions}, prima domanda=${r.firstBestCell}`);
  });

  const totalCells = ambiguousCases.reduce((sum, r) => sum + r.ambiguousCellCount, 0);
  const trueFirstCount = ambiguousCases.filter((r) => r.trueRank === 1).length;
  const totalRecovered = ambiguousCases.reduce((sum, r) => sum + r.recoveredCorrect, 0);
  const totalNewlyWrong = ambiguousCases.reduce((sum, r) => sum + r.newlyWrong, 0);
  const avgQuestions = ambiguousCases.reduce((sum, r) => sum + (r.questions ?? 0), 0) / Math.max(1, ambiguousCases.length);

  console.log('\nTOTALI');
  console.log(`  casi ambigui: ${ambiguousCases.length}/13 video · celle ambigue totali: ${totalCells}`);
  console.log(`  stato vero al 1° posto: ${trueFirstCount}/${ambiguousCases.length}`);
  console.log(`  scegliendo sempre il 1°: ${totalRecovered} recuperate, ${totalNewlyWrong} diventerebbero sbagliate`);
  console.log(`  domande medie (greedy) per arrivare a un candidato unico: ${avgQuestions.toFixed(2)}`);

  // --- margine vs correttezza ---
  console.log('\nMARGINE 1°-2° vs CORRETTEZZA DEL 1°');
  const withMargin = ambiguousCases.filter((r) => r.margin !== null).sort((a, b) => (b.margin ?? 0) - (a.margin ?? 0));
  const distinctMargins = [...new Set(withMargin.map((r) => r.margin ?? 0))].sort((a, b) => b - a);
  const marginThresholds = distinctMargins.map((threshold) => {
    const atOrAbove = withMargin.filter((r) => (r.margin ?? 0) >= threshold);
    const correct = atOrAbove.filter((r) => r.trueRank === 1).length;
    const accuracy = correct / atOrAbove.length;
    const cells = atOrAbove.reduce((sum, r) => sum + r.recoveredCorrect, 0);
    const wrong = atOrAbove.reduce((sum, r) => sum + r.newlyWrong, 0);
    console.log(`  soglia margine >= ${threshold.toFixed(1)}: ${atOrAbove.length} casi, accuratezza 1°=${(accuracy * 100).toFixed(0)}%, celle recuperate=${cells}, sbagliate=${wrong}`);
    return { threshold, accuracy, n: atOrAbove.length, cells };
  });
  const best95 = marginThresholds
    .filter((entry) => entry.accuracy >= 0.95)
    .sort((a, b) => a.threshold - b.threshold)[0] ?? null;
  if (best95) {
    console.log(`  soglia minima con accuratezza >=95%: margine >= ${best95.threshold.toFixed(1)} (${best95.n} casi, ${best95.cells} celle recuperabili)`);
  } else {
    console.log('  nessuna soglia di margine raggiunge il 95% di accuratezza su questo campione.');
  }

  console.log('='.repeat(72));

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const outPath = path.join(RESULTS_DIR, 'beam-ambiguity-photometric.json');
  fs.writeFileSync(outPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    reports,
    totals: {
      ambiguousCases: ambiguousCases.length,
      totalCells,
      trueFirstCount,
      totalRecovered,
      totalNewlyWrong,
      avgQuestions,
      best95,
    },
  }, null, 2));
  log(`report salvato: ${path.relative(WEB_ROOT, outPath)}`);
}

main().catch((error) => {
  console.error('\n[beam-ambiguity] errore fatale:', error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
