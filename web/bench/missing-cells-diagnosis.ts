// Diagnosi delle caselle non corrette (esperimento #11): classifica, per ogni
// video sotto 54/54 e per ciascuna faccia, le 8 caselle non centrali in 7
// categorie causali, per capire DOVE intervenire dopo l'esperimento #10
// (soglia di allineamento griglia, vedi docs/pipeline-experiments.md).
//
// Solo diagnosi: nessuna modifica alla pipeline di produzione. Usa la STESSA
// pipeline del bench normale (bench/run-bench.ts), a soglia di produzione
// (nessun override), con due strumentazioni solo-bench aggiuntive giA
// esistenti nello stesso schema lazy (no-op se il global non e' predisposto):
//   - lib/video-decoder.ts: __benchGridAlignmentSafeguardColors (quali colori-
//     faccia hanno fatto scattare la salvaguardia dell'esperimento #10)
//   - lib/inspection-state.ts: __benchFaceObservationDiag (la "migliore"
//     osservazione per faccia PRIMA della beam search di completamento:
//     colori letti e, se da modello, indice di allineamento griglia)
//
// Metodologia di classificazione (mutuamente esclusiva, verificata: la somma
// delle 7 categorie per video deve dare 48):
//
//   Casella VUOTA nello schema finale (facelets[face][i] === null):
//     diag === null (nessuna osservazione ha mai superato il gate di
//       rilevamento modello / visibleCells>=5 per QUESTA faccia)         -> 2
//     diag.colors[i] === null e la salvaguardia e' scattata per il colore
//       di questa faccia (l'osservazione tenuta a forza e' degradata e non
//       copriva questa casella)                                         -> 3
//     diag.colors[i] === null altrimenti (nessuna salvaguardia, ma questa
//       casella specifica non e' mai stata letta nella migliore
//       osservazione, es. occlusione/riflesso locale)                   -> 2
//     diag.colors[i] !== null (un colore valido esisteva per questa casella
//       nella migliore osservazione) ma la casella finale e' comunque nulla
//       -> la ricostruzione (vincoli dei pezzi / troncamento beam search)
//       non l'ha impegnata                                              -> 4
//
//   Casella SBAGLIATA (non nulla, colore diverso dalla verita'):
//     si cerca, per la faccia, la rotazione a passi di 90 gradi (1,2,3) del
//     solo anello esterno (il centro non ruota: e' l'ancora di faccia) che
//     massimizza le caselle corrette contro la verita'; se batte l'identita'
//     di almeno 2 caselle, le caselle sbagliate che quella rotazione
//     spiegherebbe (coinciderebbero con la verita' alla posizione ruotata)
//     vanno in                                                          -> 6
//     altrimenti, se l'osservazione usata e' da modello con indice di
//     allineamento griglia >= 6 (soglia di produzione)                  -> 5
//     altrimenti (indice sotto soglia o non disponibile, es. letture da
//     pairs/silhouette/bilanciamento sintetico)                         -> 7
//
// Limiti onesti di questa diagnosi (da leggere insieme al report):
//   - "tempo nel video" per gli esempi e' l'intervallo di ispezione usato
//     dalla pipeline (window.__benchReconstruct -> result.interval), non un
//     timestamp per-casella: il pipeline non traccia QUALE fotogramma ha
//     vinto per singola casella.
//   - la rotazione e' verificata sulla faccia nel suo complesso (anello di 8
//     caselle), non sulle singole celle: una faccia con 2 caselle "genuinamente"
//     sbagliate e 2 spiegabili da rotazione puo' comunque superare la soglia
//     se la rotazione netta e' positiva - il report lo segnala quando conta.

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

type CaseSpec = {
  id: string;
  video: string;
  scramble: string;
  group?: 'test' | 'integration' | 'seen';
};

type FaceDiag = { colors: Array<CubeColor | null>; gridAlignmentIndex?: number } | null;

type HarnessResult = {
  ok: boolean;
  status?: string;
  error?: string;
  facelets?: Record<Face, Array<CubeColor | null>>;
  interval?: { start: number; end: number };
  faceObservationDiag?: Record<Face, FaceDiag>;
  gridAlignmentSafeguardColors?: CubeColor[];
};

const CATEGORY_LABELS: Record<number, string> = {
  1: 'corrette',
  2: 'vuote - nessuna osservazione/gate modello',
  3: 'vuote - salvaguardia filtro allineamento',
  4: 'vuote - non impegnate dalla ricostruzione (vincoli/beam)',
  5: 'sbagliate - colore su griglia ben allineata (indice>=6)',
  6: 'sbagliate - orientamento/rotazione faccia',
  7: 'sbagliate - altro',
};

// Rotazione di 90 gradi in senso orario di una griglia 3x3 (indici 0..8,
// riga-maggiore); l'indice 4 (centro) resta fisso.
const ROT90 = [6, 3, 0, 7, 4, 1, 8, 5, 2];
function rotateFace(colors: Array<CubeColor | null>, turns: number): Array<CubeColor | null> {
  let result = colors;
  for (let t = 0; t < turns; t += 1) {
    result = ROT90.map((src) => result[src]);
  }
  return result;
}

type CellClass = { category: number; note?: string };

type FaceClassification = {
  face: Face;
  counts: Record<number, number>;
  cells: Array<CellClass & { index: number }>;
  rotationTurns: number | null; // null = nessuna rotazione spiega la faccia
  colorConfusions: Array<{ expected: CubeColor; got: CubeColor }>;
};

function classifyFace(
  face: Face,
  candidate: Array<CubeColor | null>,
  reference: CubeColor[],
  diag: FaceDiag,
  safeguardColors: CubeColor[],
  faceColor: CubeColor,
): FaceClassification {
  const counts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 };
  const cells: Array<CellClass & { index: number }> = [];
  const safeguardFired = safeguardColors.includes(faceColor);

  // Rotazione: quale turn (1,2,3) massimizza i match contro la verita',
  // confrontato con l'identita' (turn 0). Solo sulle celle non nulle.
  const matchesAt = (turns: number) => {
    const rotated = rotateFace(candidate, turns);
    let matches = 0;
    rotated.forEach((color, index) => {
      if (index === 4 || color === null) return;
      if (color === reference[index]) matches += 1;
    });
    return matches;
  };
  const identityMatches = matchesAt(0);
  let bestTurns = 0;
  let bestMatches = identityMatches;
  [1, 2, 3].forEach((turns) => {
    const matches = matchesAt(turns);
    if (matches > bestMatches) {
      bestMatches = matches;
      bestTurns = turns;
    }
  });
  const rotationExplains = bestTurns !== 0 && bestMatches - identityMatches >= 2;
  const rotatedCandidate = rotationExplains ? rotateFace(candidate, bestTurns) : candidate;

  const colorConfusions: Array<{ expected: CubeColor; got: CubeColor }> = [];

  for (let index = 0; index < 9; index += 1) {
    if (index === 4) continue; // centro: sempre corretto per costruzione
    const got = candidate[index];
    const expected = reference[index];
    if (got === expected) {
      counts[1] += 1;
      cells.push({ index, category: 1 });
      continue;
    }
    if (got === null) {
      let category: number;
      if (!diag) {
        category = 2;
      } else if (diag.colors[index] === null) {
        category = safeguardFired ? 3 : 2;
      } else {
        category = 4;
      }
      counts[category] += 1;
      cells.push({ index, category });
      continue;
    }
    // casella sbagliata (got !== expected, got !== null)
    if (rotationExplains && rotatedCandidate[index] === expected) {
      counts[6] += 1;
      cells.push({ index, category: 6, note: `ruotando di ${bestTurns * 90} gradi coincide con la verita'` });
      continue;
    }
    const wellAligned = diag?.gridAlignmentIndex !== undefined && diag.gridAlignmentIndex >= 6;
    if (wellAligned) {
      counts[5] += 1;
      colorConfusions.push({ expected, got });
      cells.push({ index, category: 5, note: `${expected}->${got}` });
    } else {
      counts[7] += 1;
      cells.push({
        index,
        category: 7,
        note: diag?.gridAlignmentIndex === undefined
          ? `${expected}->${got}, indice di allineamento non disponibile`
          : `${expected}->${got}, indice ${diag.gridAlignmentIndex} sotto soglia`,
      });
    }
  }

  return {
    face,
    counts,
    cells,
    rotationTurns: rotationExplains ? bestTurns : null,
    colorConfusions,
  };
}

function log(...parts: unknown[]) {
  console.log('[missing-cells]', ...parts);
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
  const dev = await startDevServer(WEB_ROOT, '[missing-cells]', '/bench');
  log(`dev server pronto: ${dev.baseUrl}`);

  const chromeExecutable = pinnedChromeExecutable();
  const browser: Browser = await chromium.launch({
    headless: !process.env.BENCH_HEADFUL,
    executablePath: chromeExecutable,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu'],
  });
  log(`browser: Chrome for Testing ${CHROME_BUILD_ID} (pinnato)`);

  type VideoReport = {
    id: string;
    group?: string;
    correct: number;
    faces: FaceClassification[];
    interval?: { start: number; end: number };
  };
  const videoReports: VideoReport[] = [];

  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      (window as unknown as { __benchFaceObservationDiag?: unknown }).__benchFaceObservationDiag = {};
      (window as unknown as { __benchGridAlignmentSafeguardColors?: unknown }).__benchGridAlignmentSafeguardColors = [];
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
        (window as unknown as { __benchFaceObservationDiag?: unknown }).__benchFaceObservationDiag = {};
        (window as unknown as { __benchGridAlignmentSafeguardColors?: unknown }).__benchGridAlignmentSafeguardColors = [];
      });
      const result: HarnessResult = await page.evaluate(
        (url) => window.__benchReconstruct!(url),
        videoUrl,
      );
      if (!result.ok || !result.facelets) {
        log(`  ✗ ${entry.id}: ${result.error || 'esito non valido'}`);
        continue;
      }
      const reference = referenceFromScramble(entry.scramble);
      let correct = 0;
      CUBE_FACES.forEach((face) => {
        result.facelets![face].forEach((color, index) => {
          if (color === reference[face][index]) correct += 1;
        });
      });
      log(`  → ${correct}/54 giuste`);
      if (correct >= 54) {
        log(`  ${entry.id} già completo (54/54): escluso dalla classificazione per casella.`);
        videoReports.push({ id: entry.id, group: entry.group, correct, faces: [], interval: result.interval });
        continue;
      }
      const faces = CUBE_FACES.map((face) => classifyFace(
        face,
        result.facelets![face],
        reference[face],
        result.faceObservationDiag?.[face] ?? null,
        result.gridAlignmentSafeguardColors ?? [],
        face === 'U' ? 'white' : face === 'R' ? 'red' : face === 'F' ? 'green'
          : face === 'D' ? 'yellow' : face === 'L' ? 'orange' : 'blue',
      ));
      const videoTotal = faces.reduce((sum, f) => sum + Object.values(f.counts).reduce((s, v) => s + v, 0), 0);
      if (videoTotal !== 48) {
        throw new Error(`${entry.id}: somma categorie = ${videoTotal}, atteso 48 (bug nella classificazione)`);
      }
      faces.forEach((f) => {
        const line = Object.entries(f.counts)
          .filter(([, count]) => count > 0)
          .map(([category, count]) => `${CATEGORY_LABELS[Number(category)]}=${count}`)
          .join(', ');
        log(`    ${entry.id}/${f.face}: ${line}`);
      });
      videoReports.push({ id: entry.id, group: entry.group, correct, faces, interval: result.interval });
    }
  } finally {
    await browser.close();
    await dev.close();
    videoServer.close();
  }

  // --- aggregazione ---
  const grandTotals: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 };
  videoReports.forEach((v) => v.faces.forEach((f) => {
    Object.entries(f.counts).forEach(([category, count]) => {
      grandTotals[Number(category)] += count;
    });
  }));

  console.log('\n' + '='.repeat(72));
  console.log('TABELLA PER VIDEO (sotto 54/54), per faccia, 7 categorie');
  videoReports.filter((v) => v.faces.length).forEach((v) => {
    console.log(`\n# ${v.id} (${v.group}) · ${v.correct}/54 · intervallo ispezione analizzato: ${v.interval?.start.toFixed(2)}s–${v.interval?.end.toFixed(2)}s`);
    v.faces.forEach((f) => {
      const row = [1, 2, 3, 4, 5, 6, 7].map((c) => f.counts[c]).join('  ');
      console.log(`  ${f.face}  [1..7]= ${row}${f.rotationTurns ? `   (rotazione ${f.rotationTurns * 90}° applicata)` : ''}`);
    });
  });

  console.log('\n' + '='.repeat(72));
  console.log('TOTALI PER CATEGORIA (su tutti i video sotto 54/54)');
  [1, 2, 3, 4, 5, 6, 7].forEach((c) => {
    console.log(`  ${c}. ${CATEGORY_LABELS[c].padEnd(55)} ${grandTotals[c]}`);
  });
  const nonCorrectTotal = [2, 3, 4, 5, 6, 7].reduce((sum, c) => sum + grandTotals[c], 0);
  console.log(`  totale non corrette: ${nonCorrectTotal}`);
  console.log('='.repeat(72));

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const outPath = path.join(RESULTS_DIR, 'missing-cells-diagnosis.json');
  fs.writeFileSync(outPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    categoryLabels: CATEGORY_LABELS,
    grandTotals,
    videos: videoReports,
  }, null, 2));
  log(`report salvato: ${path.relative(WEB_ROOT, outPath)}`);
}

main().catch((error) => {
  console.error('\n[missing-cells] errore fatale:', error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
