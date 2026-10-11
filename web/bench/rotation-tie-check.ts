// Esperimento #17, Passo 1 (vedi docs/pipeline-experiments.md): misura, su
// tutti i 13 video del bench, il margine di punteggio fra la 1a e la 2a
// rotazione candidata per ciascuna faccia (choicesDiag, lib/inspection-state.ts)
// e se la rotazione scelta (la 1a in classifica) e' quella che massimizza
// l'accordo con la verita' fra le rotazioni effettivamente candidate per
// quella faccia. Solo diagnosi, nessuna modifica alla pipeline.

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
const RESULTS_DIR = path.join(HERE, 'results');
const TIE_EPSILON = 1e-9;

type CaseSpec = { id: string; video: string; scramble: string; group?: 'test' | 'integration' | 'seen' };
type ChoicesDiag = Record<Face, Array<{ grid: Array<CubeColor | null>; score: number }>>;

type HarnessResult = {
  ok: boolean;
  error?: string;
  choicesDiag?: ChoicesDiag;
};

function log(...parts: unknown[]) {
  console.log('[rotation-tie]', ...parts);
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
  const cases = raw.cases as CaseSpec[];
  for (const entry of cases) {
    if (!fs.existsSync(path.join(videoDir, entry.video))) {
      throw new Error(`video mancante: ${entry.video} (imposta BENCH_VIDEO_DIR)`);
    }
  }

  const videoServer = await startStaticServer(videoDir);
  log(`server video pronto (porta ${videoServer.port})`);
  const dev = await startDevServer(WEB_ROOT, '[rotation-tie]', '/bench');
  log(`dev server pronto: ${dev.baseUrl}`);

  const chromeExecutable = pinnedChromeExecutable();
  const browser: Browser = await chromium.launch({
    headless: !process.env.BENCH_HEADFUL,
    executablePath: chromeExecutable,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu'],
  });
  log(`browser: Chrome for Testing ${CHROME_BUILD_ID} (pinnato)`);

  type FaceReport = {
    video: string; group?: string; face: Face;
    margin: number; tie: boolean; chosenMatches: number; maxMatches: number; wrongChoice: boolean;
  };
  const reports: FaceReport[] = [];

  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__benchChoicesDiag = {};
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
        (window as unknown as Record<string, unknown>).__benchChoicesDiag = {};
      });
      const result: HarnessResult = await page.evaluate((url) => window.__benchReconstruct!(url), videoUrl);
      if (!result.ok || !result.choicesDiag) {
        log(`  ✗ ${entry.id}: ${result.error || 'dati diagnostici assenti'}`);
        continue;
      }
      const reference = referenceFromScramble(entry.scramble);
      CUBE_FACES.forEach((face) => {
        const rotations = result.choicesDiag![face];
        if (!rotations || !rotations.length) return;
        const margin = rotations.length >= 2 ? rotations[0].score - rotations[1].score : Infinity;
        const tie = margin <= TIE_EPSILON;
        const chosenMatches = matches(rotations[0].grid, reference[face]);
        const maxMatches = Math.max(...rotations.map((r) => matches(r.grid, reference[face])));
        const wrongChoice = chosenMatches < maxMatches;
        reports.push({ video: entry.id, group: entry.group, face, margin, tie, chosenMatches, maxMatches, wrongChoice });
        log(`  ${face}: margine=${margin === Infinity ? '∞' : margin.toFixed(2)} pareggio=${tie} scelta=${chosenMatches}/8 massimo=${maxMatches}/8 ${wrongChoice ? '✗ SBAGLIATA' : '✓'}`);
      });
    }
  } finally {
    await browser.close();
    await dev.close();
    videoServer.close();
  }

  console.log('\n' + '='.repeat(72));
  console.log('TOTALI');
  const ties = reports.filter((r) => r.tie);
  const tiesWrong = ties.filter((r) => r.wrongChoice);
  const nonTiesWrong = reports.filter((r) => !r.tie && r.wrongChoice);
  console.log(`  facce totali misurate: ${reports.length}`);
  console.log(`  facce in pareggio (margine <= ${TIE_EPSILON}): ${ties.length}`);
  console.log(`  di queste, con scelta sbagliata (non il massimo disponibile): ${tiesWrong.length}`);
  console.log(`  facce SENZA pareggio ma con scelta comunque sbagliata: ${nonTiesWrong.length}`);
  console.log('\n  Dettaglio pareggi con scelta sbagliata:');
  tiesWrong.forEach((r) => console.log(`    ${r.video}/${r.face}: scelta ${r.chosenMatches}/8, disponibile ${r.maxMatches}/8`));
  console.log('='.repeat(72));

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const outPath = path.join(RESULTS_DIR, 'rotation-tie-check.json');
  fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), reports }, null, 2));
  log(`report salvato: ${path.relative(WEB_ROOT, outPath)}`);
}

main().catch((error) => {
  console.error('\n[rotation-tie] errore fatale:', error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
