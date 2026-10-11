// Diagnosi delle caselle non corrette (esperimento #12): classifica, per ogni
// video sotto 54/54 e per ciascuna faccia, le 8 caselle non centrali in 7
// categorie causali, per capire DOVE intervenire dopo l'esperimento #10
// (soglia di allineamento griglia, vedi docs/pipeline-experiments.md).
// L'esperimento #11 e' la variante A (selezione per indice), gia' scartata.
//
// Solo diagnosi: nessuna modifica alla pipeline di produzione. Usa la STESSA
// pipeline del bench normale (bench/run-bench.ts), a soglia di produzione
// (nessun override), con strumentazioni solo-bench aggiuntive nello stesso
// schema lazy (no-op se il global non e' predisposto dalla pagina bench):
//   - lib/video-decoder.ts: __benchGridAlignmentSafeguardColors (quali colori-
//     faccia hanno fatto scattare la salvaguardia dell'esperimento #10)
//   - lib/inspection-state.ts: __benchFaceObservationDiag (la "migliore"
//     osservazione per faccia PRIMA della beam search di completamento) e
//     __benchStableRawDiag (la lettura e la soglia minima di confidenza usate
//     dal blocco di "rilassamento" finale - parte B)
//   - lib/face-keypoint-model.ts: __benchModelGateAttempts (tentativi di
//     rilevamento per colore-centro, prima e dopo il gate >=6 celle - parte C)
//
// Metodologia di classificazione base (mutuamente esclusiva, verificata: la
// somma delle 7 categorie per video deve dare 48):
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
//     rotazione a passi di 90 gradi (1,2,3) dell'anello esterno che batte
//     l'identita' di almeno 2 caselle                                   -> 6
//     altrimenti, osservazione da modello con indice >= 6 (soglia prod.)  -> 5
//     altrimenti (indice sotto soglia, non disponibile, o sintetica)     -> 7
//
// Parte A (categoria 7): per ciascuna cella, il percorso della lettura
// usata (gridSource/syntheticFusion della migliore osservazione per
// faccia), se quel percorso salta applyGridAlignmentFilter e perche', e un
// conteggio controfattuale "se anche quel percorso rispettasse la soglia 6"
// — simulabile SOLO per il percorso modello protetto dalla salvaguardia
// (unico caso con un indice su cui applicare la soglia).
//
// Parte B (categoria 4): sotto-causa per cella usando candidateCount/
// truncated (globali del run) e __benchStableRawDiag (il blocco di
// rilassamento finale, stessi valori esatti, non un'approssimazione).
//
// Parte C (categoria 2): per faccia, finestra sbagliata (presenza del
// colore altrove nel video, segnale fotometrico grezzo di
// decodeVideoMotion) vs non rilevata dal modello vs rilevata ma scartata
// dal gate, usando __benchModelGateAttempts + la presenza di colore dentro/
// fuori dalla finestra d'ispezione individuata.
//
// Limiti onesti di questa diagnosi:
//   - "tempo nel video" per gli esempi e' l'intervallo di ispezione usato
//     dalla pipeline, non un timestamp per-casella.
//   - la rotazione (cat. 6) e' verificata sull'intera faccia, non sulla
//     singola cella.
//   - la parte C usa un segnale di presenza-colore a bassa risoluzione
//     (lo stesso di detectedColors/coverage), non una lettura di griglia:
//     indica plausibilita', non certezza geometrica.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { startStaticServer } from './lib/static-server.ts';
import { startDevServer } from './lib/dev-server.ts';
import { pinnedChromeExecutable, CHROME_BUILD_ID } from './chrome-path.ts';
import { referenceFromScramble } from './lib/score.ts';
import { CUBE_FACES, CANONICAL_FACE_COLOR, type CubeColor, type Face } from '../lib/cube.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, '..');
const RESULTS_DIR = path.join(HERE, 'results');

type CaseSpec = {
  id: string;
  video: string;
  scramble: string;
  group?: 'test' | 'integration' | 'seen';
};

type FaceDiag = {
  colors: Array<CubeColor | null>;
  gridAlignmentIndex?: number;
  gridSource?: 'silhouette' | 'pairs' | 'model';
  syntheticFusion?: boolean;
  cellConfidences?: number[];
} | null;

type StableRawDiag = {
  colors: Array<CubeColor | null>;
  confidences: number[];
  minimumCellConfidence: number;
} | null;

type ColorPresence = { maxInsideWindow: number; maxBeforeWindow: number; samplesBeforeWindow: number };

type HarnessResult = {
  ok: boolean;
  status?: string;
  error?: string;
  facelets?: Record<Face, Array<CubeColor | null>>;
  interval?: { start: number; end: number };
  faceObservationDiag?: Record<Face, FaceDiag>;
  gridAlignmentSafeguardColors?: CubeColor[];
  stableRawDiag?: Record<Face, StableRawDiag>;
  modelGateAttempts?: Record<string, { attempts: number; passed: number }>;
  candidateCount?: number;
  truncated?: boolean;
  videoDuration?: number;
  colorPresence?: Record<CubeColor, ColorPresence>;
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

const B_SUBCAUSE_LABELS: Record<number, string> = {
  1: 'piu candidati ugualmente validi, nessuno unico',
  2: 'troncamento del beam search',
  3: 'confidenza sotto il minimo nel ramo di rilassamento',
  4: 'altro',
};

const C_BUCKET_LABELS: Record<number, string> = {
  1: 'finestra sbagliata (visibile altrove, non nella finestra)',
  2: 'nella finestra ma non rilevata dal modello',
  3: 'rilevata ma scartata dal gate >=6 celle',
  0: 'anomalia (gate superato ma la faccia e comunque vuota - da investigare)',
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

function pathInfoFor(diag: FaceDiag): { label: string; fn: string; skipsFilter: boolean; why: string; modelSafeguarded: boolean } {
  if (!diag) return { label: 'nessuna osservazione', fn: '-', skipsFilter: false, why: '-', modelSafeguarded: false };
  if (diag.syntheticFusion) {
    return {
      label: 'bilanciamento globale (sintetica)',
      fn: 'classifyBalancedCubeFacelets (lib/video-decoder.ts)',
      skipsFilter: true,
      modelSafeguarded: false,
      why: "costruita DOPO applyGridAlignmentFilter da letture gia' filtrate: non ha una propria silhouette/geometria su cui calcolare un indice, quindi il filtro non le si applica per costruzione - voluto nel design, ma e' un gap: la qualita' per-cella del blend non e' garantita a valle",
    };
  }
  if (diag.gridSource === 'model') {
    const safeguarded = diag.gridAlignmentIndex !== undefined && diag.gridAlignmentIndex < 6;
    return {
      label: safeguarded ? 'modello, salvaguardia (indice sotto soglia)' : 'modello',
      fn: 'fuseFaceObservations / selectSingleBestModelObservationPerFace (lib/video-decoder.ts)',
      skipsFilter: false,
      modelSafeguarded: safeguarded,
      why: safeguarded
        ? "il filtro SI applica: tutte le osservazioni di questo colore erano sotto soglia 6, la salvaguardia ha tenuto la singola migliore per non perdere la faccia - voluto (esperimento #10)"
        : 'il filtro si applica normalmente (indice >= 6)',
    };
  }
  if (diag.gridSource === 'pairs' || diag.gridSource === 'silhouette') {
    return {
      label: `geometrico (${diag.gridSource})`,
      fn: 'detectFaceGrids (lib/geometric-sticker-detection.ts)',
      skipsFilter: true,
      modelSafeguarded: false,
      why: "applyGridAlignmentFilter tocca solo gridSource==='model' per costruzione: questo percorso e' dormiente di default in produzione (serve solo forzando BENCH_FACE_SOURCE=geometric) - se compare qui e' degno di nota",
    };
  }
  return { label: 'ignoto', fn: '-', skipsFilter: true, modelSafeguarded: false, why: 'gridSource non impostato' };
}

type CellClass = { category: number; note?: string; bSubcause?: number };

type FaceClassification = {
  face: Face;
  counts: Record<number, number>;
  cells: Array<CellClass & { index: number }>;
  rotationTurns: number | null;
  colorConfusions: Array<{ expected: CubeColor; got: CubeColor }>;
  pathInfo: ReturnType<typeof pathInfoFor>;
  cCategoryInfo: { bucket: number; detail: string } | null;
};

function classifyB(
  index: number,
  stableRaw: StableRawDiag,
  candidateCount: number,
  truncated: boolean,
): { subcause: number; note: string } {
  if (stableRaw && stableRaw.colors[index] !== null) {
    const confidence = stableRaw.confidences[index];
    if (confidence < stableRaw.minimumCellConfidence) {
      return { subcause: 3, note: `confidenza ${confidence} < minimo ${stableRaw.minimumCellConfidence}` };
    }
    return { subcause: 4, note: `confidenza ${confidence} >= minimo ${stableRaw.minimumCellConfidence} ma bloccata da altri vincoli (limite 9 occorrenze/colore o punteggio di rotazione negativo)` };
  }
  if (candidateCount > 1) return { subcause: 1, note: `${candidateCount} stati candidati in disaccordo su questa casella` };
  if (candidateCount === 0 && truncated) return { subcause: 2, note: 'nessuno stato completo trovato, ricerca troncata' };
  if (candidateCount === 0 && !truncated) return { subcause: 4, note: 'nessuno stato fisicamente valido trovato, non per troncamento' };
  return { subcause: 4, note: `caso residuo (candidateCount=${candidateCount}, truncated=${truncated})` };
}

function classifyC(
  faceColor: CubeColor,
  modelGateAttempts: Record<string, { attempts: number; passed: number }> | undefined,
  colorPresence: Record<CubeColor, ColorPresence> | undefined,
): { bucket: number; detail: string } {
  const gate = modelGateAttempts?.[faceColor] ?? { attempts: 0, passed: 0 };
  const presence = colorPresence?.[faceColor] ?? { maxInsideWindow: 0, maxBeforeWindow: 0, samplesBeforeWindow: 0 };
  const PRESENCE_THRESHOLD = 0.04;
  const insidePct = (presence.maxInsideWindow * 100).toFixed(1);
  const beforePct = (presence.maxBeforeWindow * 100).toFixed(1);
  if (presence.maxInsideWindow < PRESENCE_THRESHOLD && presence.maxBeforeWindow >= PRESENCE_THRESHOLD) {
    return { bucket: 1, detail: `presenza max dentro finestra ${insidePct}%, fuori finestra (prima) ${beforePct}% su ${presence.samplesBeforeWindow} campioni` };
  }
  if (gate.attempts === 0) {
    return { bucket: 2, detail: `0 tentativi di rilevamento con questo centro-colore (presenza dentro finestra ${insidePct}%, fuori ${beforePct}%)` };
  }
  if (gate.attempts > 0 && gate.passed === 0) {
    return { bucket: 3, detail: `${gate.attempts} tentativi, 0 hanno superato il gate >=6 celle (presenza dentro finestra ${insidePct}%)` };
  }
  return { bucket: 0, detail: `gate.passed=${gate.passed}>0 ma la faccia e' comunque categoria 2 (presenza dentro finestra ${insidePct}%) - anomalia da investigare` };
}

function classifyFace(
  face: Face,
  candidate: Array<CubeColor | null>,
  reference: CubeColor[],
  diag: FaceDiag,
  safeguardColors: CubeColor[],
  faceColor: CubeColor,
  stableRaw: StableRawDiag,
  candidateCount: number,
  truncated: boolean,
  modelGateAttempts: Record<string, { attempts: number; passed: number }> | undefined,
  colorPresence: Record<CubeColor, ColorPresence> | undefined,
): FaceClassification {
  const counts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 };
  const cells: Array<CellClass & { index: number }> = [];
  const safeguardFired = safeguardColors.includes(faceColor);
  const pathInfo = pathInfoFor(diag);

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
  let cat2Present = false;

  for (let index = 0; index < 9; index += 1) {
    if (index === 4) continue;
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
      if (category === 2) cat2Present = true;
      const bResult = category === 4 ? classifyB(index, stableRaw, candidateCount, truncated) : null;
      counts[category] += 1;
      cells.push({ index, category, note: bResult?.note, bSubcause: bResult?.subcause });
      continue;
    }
    if (rotationExplains && rotatedCandidate[index] === expected) {
      counts[6] += 1;
      cells.push({ index, category: 6, note: `ruotando di ${bestTurns * 90} gradi coincide con la verita'` });
      continue;
    }
    const wellAligned = diag?.gridAlignmentIndex !== undefined && diag.gridAlignmentIndex >= 6 && !diag.syntheticFusion;
    if (wellAligned) {
      counts[5] += 1;
      colorConfusions.push({ expected, got });
      cells.push({ index, category: 5, note: `${expected}->${got}` });
    } else {
      counts[7] += 1;
      cells.push({
        index,
        category: 7,
        note: `${expected}->${got}, percorso: ${pathInfo.label}`,
      });
    }
  }

  const cCategoryInfo = cat2Present ? classifyC(faceColor, modelGateAttempts, colorPresence) : null;

  return {
    face,
    counts,
    cells,
    rotationTurns: rotationExplains ? bestTurns : null,
    colorConfusions,
    pathInfo,
    cCategoryInfo,
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
    videoDuration?: number;
  };
  const videoReports: VideoReport[] = [];

  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      const w = window as unknown as Record<string, unknown>;
      w.__benchFaceObservationDiag = {};
      w.__benchGridAlignmentSafeguardColors = [];
      w.__benchStableRawDiag = {};
      w.__benchModelGateAttempts = {};
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
        w.__benchFaceObservationDiag = {};
        w.__benchGridAlignmentSafeguardColors = [];
        w.__benchStableRawDiag = {};
        w.__benchModelGateAttempts = {};
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
      log(`  → ${correct}/54 giuste · finestra ${result.interval?.start.toFixed(2)}-${result.interval?.end.toFixed(2)}s · video ${result.videoDuration?.toFixed(2)}s`);
      if (correct >= 54) {
        log(`  ${entry.id} già completo (54/54): escluso dalla classificazione per casella.`);
        videoReports.push({
          id: entry.id, group: entry.group, correct, faces: [],
          interval: result.interval, videoDuration: result.videoDuration,
        });
        continue;
      }
      const faces = CUBE_FACES.map((face) => classifyFace(
        face,
        result.facelets![face],
        reference[face],
        result.faceObservationDiag?.[face] ?? null,
        result.gridAlignmentSafeguardColors ?? [],
        CANONICAL_FACE_COLOR[face],
        result.stableRawDiag?.[face] ?? null,
        result.candidateCount ?? 0,
        result.truncated ?? false,
        result.modelGateAttempts,
        result.colorPresence,
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
      videoReports.push({
        id: entry.id, group: entry.group, correct, faces,
        interval: result.interval, videoDuration: result.videoDuration,
      });
    }
  } finally {
    await browser.close();
    await dev.close();
    videoServer.close();
  }

  // --- aggregazione base ---
  const grandTotals: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 };
  videoReports.forEach((v) => v.faces.forEach((f) => {
    Object.entries(f.counts).forEach(([category, count]) => {
      grandTotals[Number(category)] += count;
    });
  }));

  console.log('\n' + '='.repeat(72));
  console.log('TABELLA PER VIDEO (sotto 54/54), per faccia, 7 categorie');
  videoReports.filter((v) => v.faces.length).forEach((v) => {
    console.log(`\n# ${v.id} (${v.group}) · ${v.correct}/54 · finestra: ${v.interval?.start.toFixed(2)}s–${v.interval?.end.toFixed(2)}s · durata video: ${v.videoDuration?.toFixed(2)}s`);
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

  // --- parte A: categoria 7 ---
  console.log('\n' + '='.repeat(72));
  console.log('PARTE A - categoria 7: percorso della lettura e controfattuale soglia-6');
  const pathTally: Record<string, number> = {};
  let wouldEmptyWrong = 0;
  let wouldEmptyCorrect = 0;
  let nonSimulableWrong = 0;
  videoReports.forEach((v) => v.faces.forEach((f) => {
    if (f.counts[7] > 0) {
      pathTally[f.pathInfo.label] = (pathTally[f.pathInfo.label] ?? 0) + f.counts[7];
      if (f.pathInfo.modelSafeguarded) {
        wouldEmptyWrong += f.counts[7];
        wouldEmptyCorrect += f.counts[1];
      } else {
        nonSimulableWrong += f.counts[7];
      }
    }
  }));
  console.log('  Percorsi delle 41 caselle di categoria 7:');
  Object.entries(pathTally).forEach(([label, count]) => console.log(`    ${label}: ${count}`));
  console.log(`  Controfattuale "soglia 6 ovunque" (solo simulabile per il percorso modello+salvaguardia):`);
  console.log(`    diventerebbero vuote invece di sbagliate: ${wouldEmptyWrong}`);
  console.log(`    caselle oggi CORRETTE sulle stesse facce che diventerebbero vuote: ${wouldEmptyCorrect}`);
  console.log(`    non simulabile (bilanciamento/geometrico, nessun indice su cui applicare una soglia): ${nonSimulableWrong}`);

  // --- parte B: categoria 4 ---
  console.log('\n' + '='.repeat(72));
  console.log('PARTE B - categoria 4: sotto-causa');
  const bTotals: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  const bByVideo: Record<string, Record<number, number>> = {};
  videoReports.forEach((v) => {
    const perVideo: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
    v.faces.forEach((f) => f.cells.forEach((cell) => {
      if (cell.category === 4 && cell.bSubcause) {
        bTotals[cell.bSubcause] += 1;
        perVideo[cell.bSubcause] += 1;
      }
    }));
    if (Object.values(perVideo).some((n) => n > 0)) bByVideo[v.id] = perVideo;
  });
  console.log('  Totali per sotto-causa:');
  [1, 2, 3, 4].forEach((s) => console.log(`    ${s}. ${B_SUBCAUSE_LABELS[s].padEnd(55)} ${bTotals[s]}`));
  console.log('  Per video:');
  Object.entries(bByVideo).forEach(([id, counts]) => {
    console.log(`    ${id}: ${[1, 2, 3, 4].map((s) => `${s}=${counts[s]}`).join(', ')}`);
  });

  // --- parte C: categoria 2 ---
  console.log('\n' + '='.repeat(72));
  console.log('PARTE C - categoria 2: finestra sbagliata / non rilevata / scartata dal gate');
  const cTotals: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
  videoReports.forEach((v) => {
    v.faces.forEach((f) => {
      if (f.cCategoryInfo) {
        cTotals[f.cCategoryInfo.bucket] += f.counts[2];
        console.log(`  ${v.id}/${f.face} (${f.counts[2]} celle cat.2): ${C_BUCKET_LABELS[f.cCategoryInfo.bucket]} — ${f.cCategoryInfo.detail}`);
      }
    });
  });
  console.log('  Totali per bucket:');
  [1, 2, 3, 0].forEach((b) => console.log(`    ${C_BUCKET_LABELS[b].padEnd(65)} ${cTotals[b]}`));

  console.log('='.repeat(72));

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const outPath = path.join(RESULTS_DIR, 'missing-cells-diagnosis.json');
  fs.writeFileSync(outPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    categoryLabels: CATEGORY_LABELS,
    bSubcauseLabels: B_SUBCAUSE_LABELS,
    cBucketLabels: C_BUCKET_LABELS,
    grandTotals,
    partA: { pathTally, wouldEmptyWrong, wouldEmptyCorrect, nonSimulableWrong },
    partB: { totals: bTotals, byVideo: bByVideo },
    partC: { totals: cTotals },
    videos: videoReports,
  }, null, 2));
  log(`report salvato: ${path.relative(WEB_ROOT, outPath)}`);
}

main().catch((error) => {
  console.error('\n[missing-cells] errore fatale:', error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
