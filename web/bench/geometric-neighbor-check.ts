// Esperimento #18, Parte 3 (vedi docs/pipeline-experiments.md): per le 39
// facce sbagliate dell'esperimento #17, misura se esiste almeno un
// fotogramma con una faccia adiacente rilevata insieme (bundleSize>=2),
// se la rotazione relativa ricavata dalla geometria (normalizeObservationOrientations,
// lib/inspection-state.ts) e' corretta rispetto alla verita', e se questa
// informazione e' gia' usata oggi (si', e' chiamata all'inizio di
// reconstructInspectionState - qui si misura quanto spesso TROVA
// un'evidenza sufficiente, non se la funzione esiste). Solo diagnosi,
// nessuna modifica alla pipeline.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { startStaticServer } from './lib/static-server.ts';
import { startDevServer } from './lib/dev-server.ts';
import { pinnedChromeExecutable, CHROME_BUILD_ID } from './chrome-path.ts';
import { referenceFromScramble } from './lib/score.ts';
import { normalizeObservationOrientations, type FaceGridObservation } from '../lib/inspection-state.ts';
import { type CubeColor, type Face } from '../lib/cube.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, '..');
const RESULTS_DIR = path.join(HERE, 'results');

// Le 39 facce sbagliate dell'esperimento #17 (bench/results/rotation-tie-check.json,
// branch exp/rotation-tie-break), raggruppate per video.
const WRONG_FACES: Record<string, Face[]> = {
  IMG_6108: ['R', 'F'],
  IMG_6258: ['U', 'R'],
  IMG_6260: ['U', 'R', 'F', 'B'],
  IMG_6281: ['R', 'F', 'D', 'L'],
  IMG_6297: ['R', 'B'],
  IMG_6298: ['U', 'R', 'F', 'D'],
  IMG_6299: ['U', 'D'],
  IMG_6300: ['R', 'L', 'B'],
  IMG_6334: ['R', 'F', 'D', 'L', 'B'],
  IMG_6336: ['R', 'D', 'L', 'B'],
  IMG_6338: ['U', 'R', 'F', 'D'],
  IMG_6341: ['R', 'F', 'B'],
};

const ROT90 = [6, 3, 0, 7, 4, 1, 8, 5, 2];
function rotate(colors: Array<CubeColor | null>, turns: number): Array<CubeColor | null> {
  let result = colors;
  for (let t = 0; t < turns; t += 1) result = ROT90.map((i) => result[i]);
  return result;
}
function matches(a: Array<CubeColor | null>, reference: CubeColor[]): number {
  let m = 0;
  a.forEach((color, index) => { if (index !== 4 && color !== null && color === reference[index]) m += 1; });
  return m;
}

type CaseSpec = { id: string; video: string; scramble: string };
type HarnessResult = {
  ok: boolean;
  error?: string;
  observationsDiag?: { observations: FaceGridObservation[]; balancedInfo: { observedCells: number; usable: boolean } };
};

function log(...parts: unknown[]) { console.log('[geo-neighbor]', ...parts); }

async function main() {
  const raw = JSON.parse(fs.readFileSync(path.join(HERE, 'cases.json'), 'utf8'));
  const videoDir = path.resolve(process.env.BENCH_VIDEO_DIR || raw.videoDir);
  const targetIds = Object.keys(WRONG_FACES);
  const cases = (raw.cases as CaseSpec[]).filter((c) => targetIds.includes(c.id));
  for (const entry of cases) {
    if (!fs.existsSync(path.join(videoDir, entry.video))) throw new Error(`video mancante: ${entry.video}`);
  }

  const videoServer = await startStaticServer(videoDir);
  log(`server video pronto (porta ${videoServer.port})`);
  const dev = await startDevServer(WEB_ROOT, '[geo-neighbor]', '/bench');
  log(`dev server pronto: ${dev.baseUrl}`);
  const browser: Browser = await chromium.launch({
    headless: !process.env.BENCH_HEADFUL,
    executablePath: pinnedChromeExecutable(),
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu'],
  });
  log(`browser: Chrome for Testing ${CHROME_BUILD_ID} (pinnato)`);

  let hasMultiFaceFrame = 0;
  let noMultiFaceFrame = 0;
  let geometryCorrect = 0;
  let geometryWrong = 0;
  let geometryNoVerdict = 0; // multi-face frame esiste ma sotto soglia (nessuna correzione applicata)
  const details: string[] = [];

  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__benchObservationsDiag = { observations: [], balancedInfo: { observedCells: 0, usable: false } };
    });
    page.on('console', (message) => { if (message.type() === 'error') log(`console.error: ${message.text()}`); });
    await page.goto(`${dev.baseUrl}/bench`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__benchReady === true, null, { timeout: 30000 });

    for (const entry of cases) {
      const videoUrl = `http://127.0.0.1:${videoServer.port}/${encodeURIComponent(entry.video)}`;
      log(`${entry.id} · ricostruzione in corso …`);
      await page.evaluate(() => {
        (window as unknown as Record<string, unknown>).__benchObservationsDiag = { observations: [], balancedInfo: { observedCells: 0, usable: false } };
      });
      const result: HarnessResult = await page.evaluate((url) => window.__benchReconstruct!(url), videoUrl);
      if (!result.ok || !result.observationsDiag) {
        log(`  ✗ ${entry.id}: ${result.error || 'dati diagnostici assenti'}`);
        continue;
      }
      const reference = referenceFromScramble(entry.scramble);
      const allObservations = result.observationsDiag.observations;
      const normalized = normalizeObservationOrientations(allObservations);

      for (const face of WRONG_FACES[entry.id]) {
        const centerColor = ({ U: 'white', R: 'red', F: 'green', D: 'yellow', L: 'orange', B: 'blue' } as Record<Face, CubeColor>)[face];
        const faceObservations = allObservations.filter((o) => o.centerColor === centerColor);
        const multiFace = faceObservations.filter((o) => (o.bundleSize ?? 1) >= 2);
        if (!multiFace.length) {
          noMultiFaceFrame += 1;
          details.push(`${entry.id}/${face}: nessun fotogramma multi-faccia (bundleSize>=2) per questo centro-colore`);
          continue;
        }
        hasMultiFaceFrame += 1;

        // verifica se normalizeObservationOrientations ha applicato una correzione
        // (orientationTurns settato) a QUALCUNA delle osservazioni multi-faccia di questa faccia
        const normalizedForFace = normalized.filter((o) => o.centerColor === centerColor && (o.bundleSize ?? 1) >= 2);
        const corrected = normalizedForFace.filter((o) => o.orientationTurns !== undefined);
        if (!corrected.length) {
          geometryNoVerdict += 1;
          details.push(`${entry.id}/${face}: fotogramma multi-faccia presente (${multiFace.length}), ma nessuna correzione geometrica applicata (sotto soglia 0.35/0.12)`);
          continue;
        }
        // la correzione e' corretta se, applicata alle colors ORIGINALI (pre-rotazione),
        // porta a un match migliore o uguale al massimo possibile
        let anyCorrect = false;
        corrected.forEach((o) => {
          const original = multiFace.find((raw) => raw.time === o.time && raw.frameId === o.frameId);
          if (!original) return;
          const achieved = matches(o.colors, reference[face]);
          const best = Math.max(...[0, 1, 2, 3].map((t) => matches(rotate(original.colors, t), reference[face])));
          if (achieved >= best && achieved > matches(original.colors, reference[face])) anyCorrect = true;
        });
        if (anyCorrect) {
          geometryCorrect += 1;
          details.push(`${entry.id}/${face}: correzione geometrica applicata e CORRETTA`);
        } else {
          geometryWrong += 1;
          details.push(`${entry.id}/${face}: correzione geometrica applicata ma SBAGLIATA`);
        }
      }
    }
  } finally {
    await browser.close();
    await dev.close();
    videoServer.close();
  }

  console.log('\n' + '='.repeat(72));
  console.log('ESPERIMENTO #18, PARTE 3 - evidenza geometrica multi-faccia');
  console.log('='.repeat(72));
  console.log(`  facce sbagliate CON almeno un fotogramma multi-faccia: ${hasMultiFaceFrame}`);
  console.log(`  facce sbagliate SENZA alcun fotogramma multi-faccia: ${noMultiFaceFrame}`);
  console.log(`  di quelle con fotogramma multi-faccia:`);
  console.log(`    correzione geometrica applicata e corretta: ${geometryCorrect}`);
  console.log(`    correzione geometrica applicata ma sbagliata: ${geometryWrong}`);
  console.log(`    nessuna correzione applicata (sotto soglia): ${geometryNoVerdict}`);
  console.log('\n  dettaglio:');
  details.forEach((d) => console.log(`    ${d}`));
  console.log('='.repeat(72));

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(RESULTS_DIR, 'geometric-neighbor-check.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    totals: { hasMultiFaceFrame, noMultiFaceFrame, geometryCorrect, geometryWrong, geometryNoVerdict },
    details,
  }, null, 2));
}

main().catch((error) => {
  console.error('\n[geo-neighbor] errore fatale:', error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
