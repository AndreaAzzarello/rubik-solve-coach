// Diagnosi puntuale (non un esperimento numerato): perche' IMG_6299 peggiora
// dopo l'adozione dell'esperimento #16 (corrette 14->8, precisione 38,9%->32%).
// Solo diagnosi, nessuna modifica alla pipeline. Usa la pipeline di
// produzione reale (soglia 6, con la correzione #16 gia' in main) su
// IMG_6299 e legge gli hook solo-bench per classificare ogni casella
// cambiata: osservazione diretta, inferenza forzata dai pezzi, o
// sovrascrittura "stableRaw" (il blocco che prova a riempire con letture
// grezze affidabili quando lo stato non e' completo).

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

type CaseSpec = { id: string; video: string; scramble: string };
type PartialFacelets = Record<Face, Array<CubeColor | null>>;
type ChoicesDiag = Record<Face, Array<{ grid: Array<CubeColor | null>; score: number }>>;

type HarnessResult = {
  ok: boolean;
  error?: string;
  facelets?: Record<Face, Array<CubeColor | null>>;
  status?: string;
  partialDiag?: { bestObservedPartial: PartialFacelets; bestPartial: PartialFacelets };
  choicesDiag?: ChoicesDiag;
};

function log(...parts: unknown[]) {
  console.log('[img6299]', ...parts);
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
  const entry = (raw.cases as CaseSpec[]).find((c) => c.id === 'IMG_6299')!;
  if (!fs.existsSync(path.join(videoDir, entry.video))) {
    throw new Error(`video mancante: ${entry.video} (imposta BENCH_VIDEO_DIR)`);
  }

  const videoServer = await startStaticServer(videoDir);
  log(`server video pronto (porta ${videoServer.port})`);
  const dev = await startDevServer(WEB_ROOT, '[img6299]', '/bench');
  log(`dev server pronto: ${dev.baseUrl}`);

  const chromeExecutable = pinnedChromeExecutable();
  const browser: Browser = await chromium.launch({
    headless: !process.env.BENCH_HEADFUL,
    executablePath: chromeExecutable,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu'],
  });
  log(`browser: Chrome for Testing ${CHROME_BUILD_ID} (pinnato)`);

  let result: HarnessResult;
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      const w = window as unknown as Record<string, unknown>;
      w.__benchChoicesDiag = {};
      w.__benchPartialDiag = { bestObservedPartial: {}, bestPartial: {} };
    });
    page.on('console', (message) => {
      if (message.type() === 'error') log(`console.error: ${message.text()}`);
    });
    await page.goto(`${dev.baseUrl}/bench`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__benchReady === true, null, { timeout: 30000 });
    const videoUrl = `http://127.0.0.1:${videoServer.port}/${encodeURIComponent(entry.video)}`;
    log('ricostruzione in corso …');
    result = await page.evaluate((url) => window.__benchReconstruct!(url), videoUrl);
  } finally {
    await browser.close();
    await dev.close();
    videoServer.close();
  }

  if (!result.ok || !result.facelets || !result.partialDiag || !result.choicesDiag) {
    throw new Error(`risultato incompleto: ${result.error || 'dati diagnostici assenti'}`);
  }
  const reference = referenceFromScramble(entry.scramble);
  const { bestObservedPartial, bestPartial } = result.partialDiag;

  console.log('\n' + '='.repeat(72));
  console.log(`IMG_6299 · stato finale: ${result.status}`);
  console.log('='.repeat(72));

  CUBE_FACES.forEach((face) => {
    for (let index = 0; index < 9; index += 1) {
      if (index === 4) continue;
      const finalColor = result.facelets![face][index];
      const trueColor = reference[face][index];
      const observed = bestObservedPartial[face][index];
      const forced = bestPartial[face][index];
      let source: string;
      if (finalColor === null) source = '-';
      else if (observed === finalColor) source = 'osservazione diretta';
      else if (forced === finalColor) source = 'inferenza forzata dai pezzi';
      else source = 'sovrascrittura stableRaw (override finale)';
      if (finalColor !== null || observed !== null || forced !== null) {
        const flag = finalColor === null ? '' : finalColor === trueColor ? '✓' : '✗';
        console.log(`  ${face}#${index}: finale=${String(finalColor).padEnd(8)} vero=${trueColor.padEnd(8)} ${flag.padEnd(1)} fonte=${source} (osservato=${observed}, forzato=${forced})`);
      }
    }
  });

  console.log('\n' + '-'.repeat(72));
  console.log('Rotazioni per faccia (choicesDiag), top-2 per punteggio:');
  CUBE_FACES.forEach((face) => {
    const rotations = result.choicesDiag![face];
    if (!rotations || !rotations.length) return;
    const top = rotations[0];
    const runnerUp = rotations[1];
    const topMatches = matches(top.grid, reference[face]);
    console.log(`  ${face}: 1° punteggio=${top.score.toFixed(1)} match-con-verità=${topMatches}/8 grid=${top.grid.map((c) => c?.[0] ?? '_').join('')}`);
    if (runnerUp) {
      const runnerMatches = matches(runnerUp.grid, reference[face]);
      console.log(`     2° punteggio=${runnerUp.score.toFixed(1)} (margine ${(top.score - runnerUp.score).toFixed(1)}) match-con-verità=${runnerMatches}/8 grid=${runnerUp.grid.map((c) => c?.[0] ?? '_').join('')}`);
    } else {
      console.log('     (nessuna alternativa trovata)');
    }
  });
  console.log('='.repeat(72));
}

main().catch((error) => {
  console.error('\n[img6299] errore fatale:', error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
