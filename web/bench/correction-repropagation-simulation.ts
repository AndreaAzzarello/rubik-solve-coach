// Fase interfaccia, passo 1 (analisi, nessuna implementazione nell'app):
// simula sui 13 video del bench, con la verità come utente, i tap
// necessari per 4 flussi di correzione:
//   A. attuale (2 tap per casella sbagliata o vuota, nessuna ripropagazione)
//   B. ripropagazione (ogni correzione confermata è un vincolo certo,
//      rilancia inferForcedPieceFacelets; strategia ottimale "sblocca di
//      più" vs ordine casuale)
//   C. conferma per faccia ("è giusta?" 1 tap, altrimenti correzioni + 1 tap
//      di conferma) + ripropagazione dopo ogni faccia
//   D. come B, ma il tap costa 1 se la palette (colori ancora ammessi dai
//      vincoli per quella casella) si riduce a un solo colore
// Caso peggiore: se una casella già impegnata (non confermata) contraddice
// una confermata, la ripropagazione dà precedenza all'utente e nulla la
// casella committed in conflitto (le meno affidabili per confidenza prima),
// segnalandola.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { startStaticServer } from './lib/static-server.ts';
import { startDevServer } from './lib/dev-server.ts';
import { pinnedChromeExecutable, CHROME_BUILD_ID } from './chrome-path.ts';
import { referenceFromScramble } from './lib/score.ts';
import { admissibleColors, confirmCellAndPropagate, type PartialFacelets } from '../lib/inspection-state.ts';
import { CUBE_FACES, type CubeColor, type Face } from '../lib/cube.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, '..');
const REPROP_SEED = 20261012;

function mulberry32(seed: number) {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FACES = CUBE_FACES;
const CELL_POSITIONS = FACES.flatMap((face) => [0, 1, 2, 3, 5, 6, 7, 8].map((index) => ({ face, index })));

function cloneFacelets(source: PartialFacelets): PartialFacelets {
  return Object.fromEntries(FACES.map((face) => [face, [...source[face]]])) as PartialFacelets;
}

function cellKey(face: Face, index: number) { return `${face}#${index}`; }

function isComplete(grid: PartialFacelets, reference: Record<Face, CubeColor[]>): boolean {
  return CELL_POSITIONS.every(({ face, index }) => grid[face][index] === reference[face][index]);
}

function correctCount(grid: PartialFacelets, reference: Record<Face, CubeColor[]>): number {
  return CELL_POSITIONS.filter(({ face, index }) => grid[face][index] === reference[face][index]).length;
}

function blankFacelets(): PartialFacelets {
  return Object.fromEntries(FACES.map((face) => [face, Array<CubeColor | null>(9).fill(null)])) as PartialFacelets;
}

function confirmedGridFrom(confirmed: Map<string, CubeColor>): PartialFacelets {
  const grid = blankFacelets();
  confirmed.forEach((color, key) => {
    const [face, indexText] = key.split('#');
    grid[face as Face][Number(indexText)] = color;
  });
  return grid;
}

// Ripropagazione: wrapper leggero attorno alla funzione di produzione
// confirmCellAndPropagate (lib/inspection-state.ts), non una copia - questo
// script misura esattamente il comportamento che finisce nell'app.
function propagate(
  working: PartialFacelets,
  confirmed: Map<string, CubeColor>,
  confidence: Record<Face, number[]>,
): { facelets: PartialFacelets; conflicts: Array<{ face: Face; index: number }> } {
  return confirmCellAndPropagate(working, confirmedGridFrom(confirmed), confidence);
}

function pickNextCell(
  working: PartialFacelets,
  confirmed: Map<string, CubeColor>,
  confidence: Record<Face, number[]>,
  reference: Record<Face, CubeColor[]>,
  remaining: Array<{ face: Face; index: number }>,
  strategy: 'optimal' | 'random',
  random: () => number,
): { face: Face; index: number } {
  if (strategy === 'random') return remaining[Math.floor(random() * remaining.length)];
  const baseline = correctCount(working, reference);
  let best = remaining[0];
  let bestGain = -1;
  remaining.forEach((cell) => {
    const trialConfirmed = new Map(confirmed);
    trialConfirmed.set(cellKey(cell.face, cell.index), reference[cell.face][cell.index]);
    const { facelets } = propagate(working, trialConfirmed, confidence);
    const gain = correctCount(facelets, reference) - baseline;
    if (gain > bestGain) { bestGain = gain; best = cell; }
  });
  return best;
}

function flowA(today: PartialFacelets, reference: Record<Face, CubeColor[]>): number {
  let taps = 0;
  CELL_POSITIONS.forEach(({ face, index }) => {
    const color = today[face][index];
    if (color === null || color !== reference[face][index]) taps += 2;
  });
  return taps;
}

function flowB(
  today: PartialFacelets,
  confidence: Record<Face, number[]>,
  reference: Record<Face, CubeColor[]>,
  strategy: 'optimal' | 'random',
  random: () => number,
): { taps: number; conflicts: number; success: boolean; steps: number } {
  let working = cloneFacelets(today);
  const confirmed = new Map<string, CubeColor>();
  let taps = 0;
  let conflicts = 0;
  let steps = 0;
  while (!isComplete(working, reference) && steps < 48) {
    const remaining = CELL_POSITIONS.filter(({ face, index }) => working[face][index] !== reference[face][index]);
    if (!remaining.length) break;
    const chosen = pickNextCell(working, confirmed, confidence, reference, remaining, strategy, random);
    confirmed.set(cellKey(chosen.face, chosen.index), reference[chosen.face][chosen.index]);
    taps += 2;
    const result = propagate(working, confirmed, confidence);
    conflicts += result.conflicts.length;
    working = result.facelets;
    steps += 1;
  }
  return { taps, conflicts, success: isComplete(working, reference), steps };
}

function flowC(
  today: PartialFacelets,
  confidence: Record<Face, number[]>,
  reference: Record<Face, CubeColor[]>,
): { taps: number; conflicts: number; success: boolean } {
  let working = cloneFacelets(today);
  const confirmed = new Map<string, CubeColor>();
  let taps = 0;
  let conflicts = 0;
  FACES.forEach((face) => {
    const cellsOfFace = [0, 1, 2, 3, 5, 6, 7, 8].map((index) => ({ face, index }));
    const faceCorrect = cellsOfFace.every(({ index }) => working[face][index] === reference[face][index]);
    if (faceCorrect) {
      taps += 1; // "e' giusta" -> si conferma l'intera faccia in un tap
    } else {
      const wrongOrMissing = cellsOfFace.filter(({ index }) => working[face][index] !== reference[face][index]);
      taps += 2 * wrongOrMissing.length + 1; // correzioni + conferma finale della faccia
    }
    cellsOfFace.forEach(({ index }) => confirmed.set(cellKey(face, index), reference[face][index]));
    const result = propagate(working, confirmed, confidence);
    conflicts += result.conflicts.length;
    working = result.facelets;
  });
  return { taps, conflicts, success: isComplete(working, reference) };
}

function admissibleColorCount(
  working: PartialFacelets,
  confirmed: Map<string, CubeColor>,
  face: Face,
  index: number,
): number {
  return admissibleColors(working, confirmedGridFrom(confirmed), face, index).length;
}

function flowD(
  today: PartialFacelets,
  confidence: Record<Face, number[]>,
  reference: Record<Face, CubeColor[]>,
  strategy: 'optimal' | 'random',
  random: () => number,
): { taps: number; conflicts: number; success: boolean; paletteHistogram: Record<number, number> } {
  let working = cloneFacelets(today);
  const confirmed = new Map<string, CubeColor>();
  let taps = 0;
  let conflicts = 0;
  const paletteHistogram: Record<number, number> = {};
  let steps = 0;
  while (!isComplete(working, reference) && steps < 48) {
    const remaining = CELL_POSITIONS.filter(({ face, index }) => working[face][index] !== reference[face][index]);
    if (!remaining.length) break;
    const chosen = pickNextCell(working, confirmed, confidence, reference, remaining, strategy, random);
    const admissible = admissibleColorCount(working, confirmed, chosen.face, chosen.index);
    paletteHistogram[admissible] = (paletteHistogram[admissible] ?? 0) + 1;
    // 0 ammessi significa che il contesto non confermato contiene già una
    // casella sbagliata altrove (non questa): la palette filtrata non
    // sarebbe utile (mostrerebbe comunque tutti i colori, o segnalerebbe un
    // conflitto prima ancora di chiedere), quindi costa come il caso
    // generico, non come l'unico-colore.
    taps += admissible === 1 ? 1 : 2;
    confirmed.set(cellKey(chosen.face, chosen.index), reference[chosen.face][chosen.index]);
    const result = propagate(working, confirmed, confidence);
    conflicts += result.conflicts.length;
    working = result.facelets;
    steps += 1;
  }
  return { taps, conflicts, success: isComplete(working, reference), paletteHistogram };
}

type CaseSpec = { id: string; video: string; scramble: string; group: string };
type HarnessResult = {
  ok: boolean;
  error?: string;
  facelets?: PartialFacelets;
  cellConfidence?: Record<Face, number[]>;
};

function log(...parts: unknown[]) { console.log('[repropagation]', ...parts); }

type Captured = { id: string; group: string; today: PartialFacelets; confidence: Record<Face, number[]>; reference: Record<Face, CubeColor[]> };

// Cache locale (solo dati derivati, nessun percorso) per rilanciare la
// sola simulazione pura senza i ~25-30 minuti di ricostruzione video a
// ogni modifica dei flussi B/C/D. CORRECTION_REPROP_NO_CACHE=1 la ignora.
const CACHE_PATH = path.join(HERE, 'results', '_correction-repropagation-cache.json');

async function captureFromVideos(): Promise<Captured[]> {
  const raw = JSON.parse(fs.readFileSync(path.join(HERE, 'cases.json'), 'utf8'));
  const videoDir = path.resolve(process.env.BENCH_VIDEO_DIR || raw.videoDir);
  const cases = raw.cases as CaseSpec[];
  for (const entry of cases) {
    if (!fs.existsSync(path.join(videoDir, entry.video))) throw new Error(`video mancante: ${entry.video}`);
  }

  const videoServer = await startStaticServer(videoDir);
  log(`server video pronto (porta ${videoServer.port})`);
  const dev = await startDevServer(WEB_ROOT, '[repropagation]', '/bench');
  log(`dev server pronto: ${dev.baseUrl}`);
  const browser: Browser = await chromium.launch({
    headless: !process.env.BENCH_HEADFUL,
    executablePath: pinnedChromeExecutable(),
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu'],
  });
  log(`browser: Chrome for Testing ${CHROME_BUILD_ID} (pinnato)`);

  const captured: Captured[] = [];

  try {
    const page = await browser.newPage();
    page.on('console', (message) => { if (message.type() === 'error') log(`console.error: ${message.text()}`); });
    await page.goto(`${dev.baseUrl}/bench`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__benchReady === true, null, { timeout: 30000 });

    for (const entry of cases) {
      const videoUrl = `http://127.0.0.1:${videoServer.port}/${encodeURIComponent(entry.video)}`;
      log(`${entry.id} · ricostruzione in corso …`);
      const result: HarnessResult = await page.evaluate((url) => window.__benchReconstruct!(url), videoUrl);
      if (!result.ok || !result.facelets || !result.cellConfidence) {
        log(`  ✗ ${entry.id}: ${result.error || 'dati assenti'}`);
        continue;
      }
      captured.push({
        id: entry.id, group: entry.group,
        today: result.facelets, confidence: result.cellConfidence,
        reference: referenceFromScramble(entry.scramble),
      });
    }
  } finally {
    await browser.close();
    await dev.close();
    videoServer.close();
  }
  return captured;
}

async function main() {
  let captured: Captured[];
  if (!process.env.CORRECTION_REPROP_NO_CACHE && fs.existsSync(CACHE_PATH)) {
    log(`cache trovata (${CACHE_PATH}), salto la ricostruzione video`);
    captured = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  } else {
    captured = await captureFromVideos();
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(captured));
  }

  log('fase video chiusa, simulazione pura (nessun browser) in corso …');

  // Lo stesso seed per bRandom e dRandom (ricreato da zero per ciascuno)
  // fa scegliere alle due simulazioni la STESSA sequenza casuale di
  // caselle: così il confronto D-vs-B a parità di ordine è leale (D non
  // può costare più di B, visto che la sua unica differenza è il costo
  // per tap quando la palette si restringe), non sporcato da due ordini
  // casuali diversi pescati dallo stesso generatore condiviso.
  const rows = captured.map((entry, caseIndex) => {
    const seed = REPROP_SEED + caseIndex;
    const a = flowA(entry.today, entry.reference);
    const bOptimal = flowB(entry.today, entry.confidence, entry.reference, 'optimal', mulberry32(seed));
    const bRandom = flowB(entry.today, entry.confidence, entry.reference, 'random', mulberry32(seed));
    const c = flowC(entry.today, entry.confidence, entry.reference);
    const dOptimal = flowD(entry.today, entry.confidence, entry.reference, 'optimal', mulberry32(seed));
    const dRandom = flowD(entry.today, entry.confidence, entry.reference, 'random', mulberry32(seed));
    return { id: entry.id, group: entry.group, a, bOptimal, bRandom, c, dOptimal, dRandom };
  });

  function stats(values: number[]) {
    const sorted = [...values].sort((left, right) => left - right);
    const mean = values.reduce((total, value) => total + value, 0) / values.length;
    const median = sorted.length % 2
      ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    return { mean, median, max: sorted[sorted.length - 1] };
  }

  console.log('\n' + '='.repeat(100));
  console.log('TAP PER VIDEO');
  console.log('='.repeat(100));
  console.log('video'.padEnd(10), 'gruppo'.padEnd(12), 'A'.padEnd(6), 'B-ott'.padEnd(7), 'B-rnd'.padEnd(7), 'C'.padEnd(6), 'D-ott'.padEnd(7), 'D-rnd'.padEnd(7));
  rows.forEach((r) => {
    console.log(
      r.id.padEnd(10), r.group.padEnd(12),
      String(r.a).padEnd(6), String(r.bOptimal.taps).padEnd(7), String(r.bRandom.taps).padEnd(7),
      String(r.c.taps).padEnd(6), String(r.dOptimal.taps).padEnd(7), String(r.dRandom.taps).padEnd(7),
    );
  });

  const successCount = (key: 'bOptimal' | 'bRandom' | 'c' | 'dOptimal' | 'dRandom') => rows.filter((r) => r[key].success).length;
  const conflictTotal = (key: 'bOptimal' | 'bRandom' | 'c' | 'dOptimal' | 'dRandom') => rows.reduce((total, r) => total + r[key].conflicts, 0);

  console.log('\n' + '='.repeat(100));
  console.log('STATISTICHE (tap: media / mediana / massimo)');
  console.log('='.repeat(100));
  const aStats = stats(rows.map((r) => r.a));
  console.log(`A (attuale)        : ${aStats.mean.toFixed(1)} / ${aStats.median.toFixed(1)} / ${aStats.max}   successo 13/13 (per costruzione)`);
  (['bOptimal', 'bRandom'] as const).forEach((key) => {
    const s = stats(rows.map((r) => r[key].taps));
    console.log(`B ${key === 'bOptimal' ? 'ottimale' : 'casuale '}     : ${s.mean.toFixed(1)} / ${s.median.toFixed(1)} / ${s.max}   successo ${successCount(key)}/13   segnalazioni totali ${conflictTotal(key)}`);
  });
  {
    const s = stats(rows.map((r) => r.c.taps));
    console.log(`C (conferma faccia) : ${s.mean.toFixed(1)} / ${s.median.toFixed(1)} / ${s.max}   successo ${successCount('c')}/13   segnalazioni totali ${conflictTotal('c')}`);
  }
  (['dOptimal', 'dRandom'] as const).forEach((key) => {
    const s = stats(rows.map((r) => r[key].taps));
    console.log(`D ${key === 'dOptimal' ? 'ottimale' : 'casuale '}     : ${s.mean.toFixed(1)} / ${s.median.toFixed(1)} / ${s.max}   successo ${successCount(key)}/13   segnalazioni totali ${conflictTotal(key)}`);
  });

  console.log('\nDIFFERENZA OTTIMALE vs CASUALE (tap medi):');
  console.log(`  B: ottimale ${stats(rows.map((r) => r.bOptimal.taps)).mean.toFixed(1)} vs casuale ${stats(rows.map((r) => r.bRandom.taps)).mean.toFixed(1)}`);
  console.log(`  D: ottimale ${stats(rows.map((r) => r.dOptimal.taps)).mean.toFixed(1)} vs casuale ${stats(rows.map((r) => r.dRandom.taps)).mean.toFixed(1)}`);

  function paletteHistogramTotal(key: 'dOptimal' | 'dRandom') {
    const total: Record<number, number> = {};
    rows.forEach((r) => {
      Object.entries(r[key].paletteHistogram).forEach(([size, count]) => {
        total[Number(size)] = (total[Number(size)] ?? 0) + count;
      });
    });
    return total;
  }
  console.log('\nISTOGRAMMA DIMENSIONE PALETTE (D):');
  console.log('  ottimale:', JSON.stringify(paletteHistogramTotal('dOptimal')));
  console.log('  casuale :', JSON.stringify(paletteHistogramTotal('dRandom')));
  console.log('='.repeat(100));

  fs.mkdirSync(path.join(HERE, 'results'), { recursive: true });
  fs.writeFileSync(path.join(HERE, 'results', 'correction-repropagation-simulation.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    rows,
  }, null, 2));
}

main().catch((error) => {
  console.error('\n[repropagation] errore fatale:', error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
