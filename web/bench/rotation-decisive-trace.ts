// Esperimento #18, Parte 1 (vedi docs/pipeline-experiments.md): traccia,
// per 5 delle 39 facce sbagliate dell'esperimento #17, il percorso
// dall'osservazione allo stato finale - in quale punto l'orientamento
// diventa definitivo e con quale criterio. Solo diagnosi, nessuna modifica
// alla pipeline. Riusa gli hook solo-bench gia' in lib/inspection-state.ts
// (__benchChoicesDiag, __benchCandidateStatesDiag, __benchPartialDiag,
// __benchBudgetTelemetry), nessuna nuova strumentazione.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { startStaticServer } from './lib/static-server.ts';
import { startDevServer } from './lib/dev-server.ts';
import { pinnedChromeExecutable, CHROME_BUILD_ID } from './chrome-path.ts';
import { referenceFromScramble } from './lib/score.ts';
import type { CubeColor, Face } from '../lib/cube.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, '..');

// 5 facce sbagliate scelte dal rapporto dell'esperimento #17
// (bench/results/rotation-tie-check.json, branch exp/rotation-tie-break),
// diverse per video/gruppo/faccia.
const TARGETS: Array<{ video: string; face: Face }> = [
  { video: 'IMG_6258', face: 'U' },
  { video: 'IMG_6281', face: 'L' },
  { video: 'IMG_6299', face: 'U' },
  { video: 'IMG_6338', face: 'F' },
  { video: 'IMG_6108', face: 'R' },
];

type CaseSpec = { id: string; video: string; scramble: string };
type PartialFacelets = Record<Face, Array<CubeColor | null>>;
type ChoicesDiag = Record<Face, Array<{ grid: Array<CubeColor | null>; score: number }>>;
type BudgetTelemetry = { beamWidthHitCount: number; mainLoopStopReason: string };

type HarnessResult = {
  ok: boolean;
  error?: string;
  facelets?: Record<Face, Array<CubeColor | null>>;
  status?: string;
  candidateCount?: number;
  truncated?: boolean;
  choicesDiag?: ChoicesDiag;
  partialDiag?: { bestObservedPartial: PartialFacelets; bestPartial: PartialFacelets };
  candidateStates?: PartialFacelets[];
  budgetTelemetry?: BudgetTelemetry;
};

function log(...parts: unknown[]) {
  console.log('[rotation-trace]', ...parts);
}

function matches(grid: Array<CubeColor | null>, reference: CubeColor[]): number {
  let m = 0;
  grid.forEach((color, index) => {
    if (index === 4 || color === null) return;
    if (color === reference[index]) m += 1;
  });
  return m;
}

async function main() {
  const raw = JSON.parse(fs.readFileSync(path.join(HERE, 'cases.json'), 'utf8'));
  const videoDir = path.resolve(process.env.BENCH_VIDEO_DIR || raw.videoDir);
  const targetIds = [...new Set(TARGETS.map((t) => t.video))];
  const cases = (raw.cases as CaseSpec[]).filter((c) => targetIds.includes(c.id));
  for (const entry of cases) {
    if (!fs.existsSync(path.join(videoDir, entry.video))) {
      throw new Error(`video mancante: ${entry.video} (imposta BENCH_VIDEO_DIR)`);
    }
  }

  const videoServer = await startStaticServer(videoDir);
  log(`server video pronto (porta ${videoServer.port})`);
  const dev = await startDevServer(WEB_ROOT, '[rotation-trace]', '/bench');
  log(`dev server pronto: ${dev.baseUrl}`);

  const chromeExecutable = pinnedChromeExecutable();
  const browser: Browser = await chromium.launch({
    headless: !process.env.BENCH_HEADFUL,
    executablePath: chromeExecutable,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu'],
  });
  log(`browser: Chrome for Testing ${CHROME_BUILD_ID} (pinnato)`);

  const results = new Map<string, HarnessResult & { reference: Record<Face, CubeColor[]> }>();

  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      const w = window as unknown as Record<string, unknown>;
      w.__benchChoicesDiag = {};
      w.__benchPartialDiag = { bestObservedPartial: {}, bestPartial: {} };
      w.__benchCandidateStatesDiag = [];
      w.__benchBudgetTelemetry = {};
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
        w.__benchChoicesDiag = {};
        w.__benchPartialDiag = { bestObservedPartial: {}, bestPartial: {} };
        w.__benchCandidateStatesDiag = [];
        w.__benchBudgetTelemetry = {};
      });
      const result: HarnessResult = await page.evaluate((url) => window.__benchReconstruct!(url), videoUrl);
      if (!result.ok || !result.facelets || !result.partialDiag || !result.choicesDiag) {
        log(`  ✗ ${entry.id}: ${result.error || 'dati diagnostici assenti'}`);
        continue;
      }
      results.set(entry.id, { ...result, reference: referenceFromScramble(entry.scramble) });
    }
  } finally {
    await browser.close();
    await dev.close();
    videoServer.close();
  }

  console.log('\n' + '='.repeat(72));
  console.log('ESPERIMENTO #18, PARTE 1 - tracciato delle 5 facce sbagliate');
  console.log('='.repeat(72));

  for (const { video, face } of TARGETS) {
    const r = results.get(video);
    if (!r) { console.log(`\n# ${video}/${face}: dati assenti`); continue; }
    const reference = r.reference;
    const rotations = r.choicesDiag![face] ?? [];
    const topScore = rotations[0]?.score;
    const tiedCount = rotations.filter((x) => Math.abs(x.score - topScore) <= 1e-9).length;

    const candidates = r.candidateStates ?? [];
    const candidateValuesForFace = candidates.map((c) => c[face].map((x) => x ?? '_').join(''));
    const distinctForFace = new Set(candidateValuesForFace).size;

    const finalFacelet = r.facelets![face];
    const observedFace = r.partialDiag!.bestObservedPartial[face];
    const forcedFace = r.partialDiag!.bestPartial[face];

    console.log(`\n# ${video}/${face}`);
    console.log(`  candidati pari merito nel builder choices: ${tiedCount}/${rotations.length} (punteggio top ${topScore?.toFixed(1)})`);
    console.log(`  stato finale: ${r.status}, candidateCount=${r.candidateCount}, truncated=${r.truncated}`);
    console.log(`  telemetria budget: beamWidthHitCount=${r.budgetTelemetry?.beamWidthHitCount}, mainLoopStopReason=${r.budgetTelemetry?.mainLoopStopReason}`);

    if (candidates.length === 0) {
      console.log('  → nessun candidato completo trovato: orientamento deciso da bestPartial direttamente (vedi sotto)');
    } else if (distinctForFace === 1) {
      console.log(`  → TUTTI i ${candidates.length} candidati completi sono D'ACCORDO su questa faccia (vincoli dei pezzi delle ALTRE facce la determinano univocamente, anche se la faccia da sola era in pareggio)`);
    } else {
      console.log(`  → i ${candidates.length} candidati completi DISACCORDANO su questa faccia (${distinctForFace} varianti sopravvissute ai vincoli): la scelta finale avviene a valle, in bestPartial/display`);
    }

    console.log(`  bestObservedPartial[${face}] (osservazione diretta, criterio: punteggio piu' alto nel builder choices + ordine di inserimento sui pareggi): ${observedFace.join(',')}`);
    console.log(`  bestPartial[${face}] (+ inferenza forzata dai pezzi): ${forcedFace.join(',')}`);
    console.log(`  facelets[${face}] finale mostrato: ${finalFacelet.join(',')}`);
    console.log(`  verita': ${reference[face].join(',')}`);
    const finalMatches = matches(finalFacelet, reference[face]);
    console.log(`  match finale: ${finalMatches}/8`);
  }
  console.log('='.repeat(72));
}

main().catch((error) => {
  console.error('\n[rotation-trace] errore fatale:', error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
