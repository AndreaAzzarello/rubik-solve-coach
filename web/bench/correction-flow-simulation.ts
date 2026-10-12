// Analisi (nessuna modifica alla produzione): simula, sui 13 video del
// bench, il costo in interazioni della correzione manuale attuale (tap su
// ogni casella sbagliata o vuota) confrontato con un flusso "domande
// decisive" proposto (l'app chiede il colore di 1-3 caselle scelte per
// scindere al massimo i candidati fisicamente validi già trovati dalla
// ricerca, poi usa le risposte come vincoli certi). La verità (dallo
// scramble) gioca il ruolo dell'utente nel rispondere - usata SOLO per
// rispondere, non per scegliere quale casella chiedere (altrimenti il
// confronto sarebbe falsato).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { startStaticServer } from './lib/static-server.ts';
import { startDevServer } from './lib/dev-server.ts';
import { pinnedChromeExecutable, CHROME_BUILD_ID } from './chrome-path.ts';
import { referenceFromScramble } from './lib/score.ts';
import { CUBE_FACES, type CubeColor, type Face } from '../lib/cube.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, '..');

type CaseSpec = { id: string; video: string; scramble: string; group: string };
type PartialFacelets = Record<Face, Array<CubeColor | null>>;
type HarnessResult = {
  ok: boolean;
  error?: string;
  facelets?: PartialFacelets;
  status?: string;
  candidateStates?: PartialFacelets[];
};

function log(...parts: unknown[]) { console.log('[correction-flow]', ...parts); }

const CELL_POSITIONS = CUBE_FACES.flatMap((face) => [0, 1, 2, 3, 5, 6, 7, 8].map((index) => ({ face, index })));

function currentManualTaps(facelets: PartialFacelets, reference: Record<Face, CubeColor[]>): { taps: number; wrong: number; missing: number } {
  let wrong = 0;
  let missing = 0;
  CELL_POSITIONS.forEach(({ face, index }) => {
    const color = facelets[face][index];
    if (color === null) missing += 1;
    else if (color !== reference[face][index]) wrong += 1;
  });
  return { taps: 2 * (wrong + missing), wrong, missing };
}

// Scelta minimax della casella "decisiva": fra le posizioni non ancora
// chieste, quella il cui valore fra i candidati attuali è più equilibrato
// (il gruppo di candidati più grande per quella casella è il più piccolo
// possibile) - questo limita il numero massimo di candidati che
// sopravviveranno QUALUNQUE sia la risposta, senza sbirciare la verità.
function pickDecisiveCell(
  candidates: PartialFacelets[],
  asked: Set<string>,
): { face: Face; index: number } | null {
  let best: { face: Face; index: number; worstGroup: number } | null = null;
  CELL_POSITIONS.forEach(({ face, index }) => {
    const key = `${face}#${index}`;
    if (asked.has(key)) return;
    const groups = new Map<string, number>();
    candidates.forEach((candidate) => {
      const value = candidate[face][index] ?? '_';
      groups.set(value, (groups.get(value) ?? 0) + 1);
    });
    if (groups.size < 2) return; // tutti d'accordo qui: non e' decisiva
    const worstGroup = Math.max(...groups.values());
    if (!best || worstGroup < best.worstGroup) best = { face, index, worstGroup };
  });
  return best;
}

function consensusOf(candidates: PartialFacelets[]): PartialFacelets {
  const consensus: PartialFacelets = Object.fromEntries(
    CUBE_FACES.map((face) => [face, Array<CubeColor | null>(9).fill(null)]),
  ) as PartialFacelets;
  CELL_POSITIONS.forEach(({ face, index }) => {
    const first = candidates[0][face][index];
    if (first !== null && candidates.every((c) => c[face][index] === first)) consensus[face][index] = first;
  });
  return consensus;
}

function simulateDecisiveQuestions(
  candidateStates: PartialFacelets[],
  todayFacelets: PartialFacelets,
  reference: Record<Face, CubeColor[]>,
): { questions: number; taps: number; toVerify: number; finalWrong: number; finalMissing: number; truthMissingFromCandidates: boolean } {
  if (!candidateStates.length) {
    // Nessun candidato fisicamente completo trovato (es. IMG_6108/R nella
    // diagnosi dell'esperimento #18): nessuna domanda decisiva possibile da
    // questo meccanismo, resta la correzione manuale sulle caselle di oggi.
    const { taps, wrong, missing } = currentManualTaps(todayFacelets, reference);
    return { questions: 0, taps, toVerify: 0, finalWrong: wrong, finalMissing: missing, truthMissingFromCandidates: false };
  }
  let remaining = candidateStates;
  const asked = new Set<string>();
  const answers: Array<{ face: Face; index: number; color: CubeColor }> = [];
  let questions = 0;
  let truthMissingFromCandidates = false;
  while (remaining.length > 1 && questions < 3) {
    const cell = pickDecisiveCell(remaining, asked);
    if (!cell) break;
    asked.add(`${cell.face}#${cell.index}`);
    const truth = reference[cell.face][cell.index];
    const filtered = remaining.filter((candidate) => candidate[cell.face][cell.index] === truth);
    if (!filtered.length) {
      // Il campione di candidati trovato dalla ricerca (troncata, come
      // documentato dall'esperimento #16) non contiene nemmeno lo stato
      // vero: la domanda sarebbe stata inutile, si ferma qui senza di lei.
      truthMissingFromCandidates = true;
      break;
    }
    answers.push({ face: cell.face, index: cell.index, color: truth });
    remaining = filtered;
    questions += 1;
  }
  // Caselle "da verificare": caselle impegnate OGGI che non coincidono con
  // la risposta certa data dall'utente a una domanda decisiva.
  let toVerify = 0;
  answers.forEach(({ face, index, color }) => {
    const committedToday = todayFacelets[face][index];
    if (committedToday !== null && committedToday !== color) toVerify += 1;
  });

  const finalFacelets = remaining.length === 1 ? remaining[0] : consensusOf(remaining);
  // Le risposte stesse sono vincoli certi, sempre impegnati.
  answers.forEach(({ face, index, color }) => { finalFacelets[face][index] = color; });
  const { taps, wrong, missing } = currentManualTaps(finalFacelets, reference);
  return { questions, taps, toVerify, finalWrong: wrong, finalMissing: missing, truthMissingFromCandidates };
}

async function main() {
  const raw = JSON.parse(fs.readFileSync(path.join(HERE, 'cases.json'), 'utf8'));
  const videoDir = path.resolve(process.env.BENCH_VIDEO_DIR || raw.videoDir);
  const cases = raw.cases as CaseSpec[];
  for (const entry of cases) {
    if (!fs.existsSync(path.join(videoDir, entry.video))) throw new Error(`video mancante: ${entry.video}`);
  }

  const videoServer = await startStaticServer(videoDir);
  log(`server video pronto (porta ${videoServer.port})`);
  const dev = await startDevServer(WEB_ROOT, '[correction-flow]', '/bench');
  log(`dev server pronto: ${dev.baseUrl}`);
  const browser: Browser = await chromium.launch({
    headless: !process.env.BENCH_HEADFUL,
    executablePath: pinnedChromeExecutable(),
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu'],
  });
  log(`browser: Chrome for Testing ${CHROME_BUILD_ID} (pinnato)`);

  const rows: Array<{
    id: string; group: string;
    currentTaps: number; currentWrong: number; currentMissing: number;
    candidateCount: number; questions: number; decisiveTaps: number; toVerify: number; finalWrong: number; finalMissing: number;
    truthMissingFromCandidates: boolean;
  }> = [];

  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__benchCandidateStatesDiag = [];
    });
    page.on('console', (message) => { if (message.type() === 'error') log(`console.error: ${message.text()}`); });
    await page.goto(`${dev.baseUrl}/bench`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__benchReady === true, null, { timeout: 30000 });

    for (const entry of cases) {
      const videoUrl = `http://127.0.0.1:${videoServer.port}/${encodeURIComponent(entry.video)}`;
      log(`${entry.id} · ricostruzione in corso …`);
      await page.evaluate(() => {
        (window as unknown as Record<string, unknown>).__benchCandidateStatesDiag = [];
      });
      const result: HarnessResult = await page.evaluate((url) => window.__benchReconstruct!(url), videoUrl);
      if (!result.ok || !result.facelets) {
        log(`  ✗ ${entry.id}: ${result.error || 'dati assenti'}`);
        continue;
      }
      const reference = referenceFromScramble(entry.scramble);
      const todayFacelets = result.facelets;
      const candidateStates = result.candidateStates ?? [];
      const current = currentManualTaps(todayFacelets, reference);
      const decisive = simulateDecisiveQuestions(candidateStates, todayFacelets, reference);
      rows.push({
        id: entry.id, group: entry.group,
        currentTaps: current.taps, currentWrong: current.wrong, currentMissing: current.missing,
        candidateCount: candidateStates.length,
        questions: decisive.questions, decisiveTaps: decisive.taps, toVerify: decisive.toVerify,
        finalWrong: decisive.finalWrong, finalMissing: decisive.finalMissing,
        truthMissingFromCandidates: decisive.truthMissingFromCandidates,
      });
    }
  } finally {
    await browser.close();
    await dev.close();
    videoServer.close();
  }

  console.log('\n' + '='.repeat(100));
  console.log('CONFRONTO: correzione manuale oggi  vs  domande decisive (proposta)');
  console.log('='.repeat(100));
  console.log(
    'video'.padEnd(10), 'gruppo'.padEnd(12), 'tap-oggi'.padEnd(9), 'candidati'.padEnd(10),
    'domande'.padEnd(8), 'tap-dopo'.padEnd(9), 'daVerificare'.padEnd(13), 'residuoSbagl+Vuote'.padEnd(20), 'veritaFuoriCampione',
  );
  rows.forEach((r) => {
    console.log(
      r.id.padEnd(10), r.group.padEnd(12), String(r.currentTaps).padEnd(9), String(r.candidateCount).padEnd(10),
      String(r.questions).padEnd(8), String(r.decisiveTaps).padEnd(9), String(r.toVerify).padEnd(13),
      `${r.finalWrong}+${r.finalMissing}`.padEnd(20), r.truthMissingFromCandidates ? 'SI' : '',
    );
  });
  const avg = (key: keyof typeof rows[number]) => rows.reduce((total, r) => total + (r[key] as number), 0) / rows.length;
  console.log('\nMEDIE:');
  console.log(`  tap oggi: ${avg('currentTaps').toFixed(1)}`);
  console.log(`  domande decisive: ${avg('questions').toFixed(2)}`);
  console.log(`  tap dopo le domande decisive: ${avg('decisiveTaps').toFixed(1)}`);
  console.log(`  caselle da verificare (per video): ${avg('toVerify').toFixed(2)}`);
  console.log(`  video dove la verita' non e' nel campione di candidati: ${rows.filter((r) => r.truthMissingFromCandidates).length}/${rows.length}`);
  console.log('='.repeat(100));

  fs.mkdirSync(path.join(HERE, 'results'), { recursive: true });
  fs.writeFileSync(path.join(HERE, 'results', 'correction-flow-simulation.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    rows,
    averages: {
      currentTaps: avg('currentTaps'),
      questions: avg('questions'),
      decisiveTaps: avg('decisiveTaps'),
      toVerify: avg('toVerify'),
    },
  }, null, 2));
}

main().catch((error) => {
  console.error('\n[correction-flow] errore fatale:', error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
