// Esperimento #20 (solo diagnosi, NESSUNA modifica alla pipeline): quanto e'
// fragile la scelta della finestra di ispezione rispetto a rumore minimo sul
// segnale di moto?
//
// Scoperta che ha motivato lo strumento: confrontando Mac e Windows sullo
// stesso codice e stesso video (IMG_6258), decoder/ridimensionamento/modello
// ONNX erano identici, ma il segnale di moto grezzo differiva di pochissimo
// (cubeDifference 4.3348 vs 4.3474 su un fotogramma) - abbastanza per
// cambiare il numero di fasi della segmentazione (3 vs 2) e quindi la
// finestra di ispezione scelta (3.78-6.87s vs 0.48-14.27s), con impatto
// drastico sul punteggio (34/54 vs 54/54).
//
// Catena delle decisioni discrete (sola lettura, nessuna qui viene
// modificata - citate per riferimento):
//   lib/video-decoder.ts
//     detectMotionEvents()        righe ~794-905    soglie di rilevamento picco
//     inferVideoSegmentation()    righe ~1723-1836   fasi scramble/inspection/solve
//     inferInspectionEnd()        righe ~1088-1182   fine della finestra di ispezione
//     denseFaceTurnStart()        righe ~1065-1081   usata da inferInspectionEnd
//   lib/inspection-pipeline.ts    righe ~94-127       orchestrazione: intervalStart/
//                                                      searchEnd/intervalEnd da cui
//                                                      nasce la finestra finale
//
// Metodo (SOLO la fase di scelta della finestra, non tutta la pipeline): per
// ciascuno dei 13 video del bench, UN solo passaggio costoso nel browser
// reale (decodeVideoMotion su tutto il video + UNA scansione ad alta
// risoluzione scanInspectionFrames su un intervallo largo, per avere le vere
// griglie-colore osservate), seguito da molte prove ECONOMICHE, pure e
// deterministiche (nessun nuovo accesso al video o al modello) che
// perturbano solo il segnale di moto gia' decodificato e rieseguono
// fuseMotionEvidence -> detectMotionEvents -> inferVideoSegmentation ->
// inferInspectionEnd con semi dichiarati. Tutto - costoso ed economico -
// gira dentro la STESSA pagina del browser, dove vivono le funzioni di
// produzione reali (nessuna copia locale della logica di decisione).
//
//   node --experimental-strip-types bench/window-sensitivity.ts [--trials 12] [--out file.json] [--cases IMG_6258,IMG_6260]
//
// BENCH_SERVER_CMD puo' forzare la porta del dev server (es.
// "pnpm exec vinext dev -p 3100" se la 3000 e' occupata su Windows).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { startStaticServer } from './lib/static-server.ts';
import { startDevServer } from './lib/dev-server.ts';
import { pinnedChromeExecutable, CHROME_BUILD_ID } from './chrome-path.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, '..');
const VENDOR_DIR = path.join(HERE, 'vendor', 'mediapipe');
const VENDOR_WASM_DIR = path.join(VENDOR_DIR, 'wasm');
const MEDIAPIPE_WASM_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm/';
const MEDIAPIPE_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

const GLOBAL_TIMEOUT_MS = 45 * 60 * 1000;
const ELEMENT_TIMEOUT_MS = 30_000;
const PER_VIDEO_TIMEOUT_MS = 6 * 60 * 1000; // decodeVideoMotion + una scanInspectionFrames larga + N prove economiche
const SEED_BASE = 20261013; // dichiarato: AAAAMMGG del giorno in cui e' stato scritto l'esperimento
const NOISE_AMPLITUDE = 0.01; // +-1% sul segnale di moto (cubeDifference), per richiesta
const NOMINAL_FRAME_DURATION = 1 / 30; // ipotesi conservativa: i video del bench sono 30 o 60 fps
const SIGNIFICANT_SHIFT_S = 0.5;

const START = Date.now();
function log(...parts: unknown[]) {
  console.log(`[window-sensitivity] [+${((Date.now() - START) / 1000).toFixed(1)}s]`, ...parts);
}

interface WindowDecision {
  intervalStart: number;
  segmentationHint: number | null;
  searchEnd: number;
  searchEndClamped: boolean;
  boundaryTime: number;
  boundarySource: string;
  intervalEnd: number;
  stageCount: number;
  windowCount: number;
}
interface TrialResult extends WindowDecision {
  trial: number;
  seed: number;
  shiftFrames: -1 | 0 | 1;
  significant: boolean;
  significantReason: string[];
}
interface VideoProbeResult {
  duration: number;
  sampleInterval: number;
  scanEnd: number;
  threshold: number;
  peakMargin: { absolute: number; relative: number; sampleTime: number } | null;
  baseline: WindowDecision;
  trials: TrialResult[];
  significantChangeCount: number;
}
interface VideoReport extends VideoProbeResult {
  caseId: string;
  videoFile: string;
  trialCount: number;
}

// --------------------------------------------- funzione eseguita in pagina
// Fa TUTTO per un video: carica il video, decodeVideoMotion, UNA
// scanInspectionFrames larga, poi la base + le prove di perturbazione, tutte
// chiamando le funzioni di produzione reali importate dal dev server
// (lib/video-decoder.ts). Nessuna copia locale della logica di decisione.
async function probeVideo(args: {
  baseUrl: string; videoUrl: string; trialCount: number; seedBase: number;
  noiseAmplitude: number; frameDuration: number; significantShiftS: number;
}): Promise<VideoProbeResult> {
  const vdm = await import(/* @vite-ignore */ `${args.baseUrl}/lib/video-decoder.ts`);

  const video = document.createElement('video');
  video.crossOrigin = 'anonymous'; video.muted = true; video.playsInline = true;
  video.preload = 'auto'; video.src = args.videoUrl;
  document.body.appendChild(video);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('video non pronto entro 30s')), 30000);
    const ready = () => { if (video.readyState >= 2 && Number.isFinite(video.duration) && video.duration > 0) { clearTimeout(t); resolve(); } };
    video.addEventListener('canplay', ready); video.addEventListener('loadeddata', ready); ready();
  });
  const duration = video.duration;

  const motion = await vdm.decodeVideoMotion(video, { startTime: 0, endTime: duration });
  const sampleInterval = motion.sampleInterval as number;
  const samples = (motion.samples as Array<Record<string, unknown>>).map((s) => ({
    time: s.time as number, difference: s.difference as number, cubeDifference: s.cubeDifference as number, handMotion: (s.handMotion as number) ?? 0,
  }));

  // Scansione UNA sola volta su un intervallo largo (copre il piu' basso
  // start possibile e un search-end generoso): ogni prova successiva riusa
  // queste stesse griglie-colore reali, senza rileggere il video.
  const baseSearchEnd = Math.min(duration, Math.max(8, Math.min(25, duration * 0.72)));
  const scanEnd = Math.min(duration, Math.max(28, baseSearchEnd + 5));
  const boundarySamplesRaw = await vdm.scanInspectionFrames(video, 0, scanEnd);
  const boundarySamples = (boundarySamplesRaw as Array<Record<string, unknown>>).map((s) => ({
    time: s.time, visibleCells: s.visibleCells, confidence: s.confidence, faceGrids: s.faceGrids, captureId: s.captureId,
  }));
  video.removeAttribute('src'); video.load(); video.remove();

  function computeWindow(events: unknown[], boundaryEnd: number) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const segmentation = vdm.inferVideoSegmentation(events, 0, duration) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const solveWindow = segmentation.windows.find((w: any) => w.id === segmentation.defaultWindowId) ?? null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inspectionStage = solveWindow?.stages.find((s: any) => s.kind === 'inspection') ?? null;
    const automaticStart = inspectionStage?.start ?? 0;
    const intervalStart = Math.max(0, Math.min(automaticStart, duration - 0.5));
    const segmentationHint = inspectionStage?.end ?? solveWindow?.start ?? null;
    const localBaseSearchEnd = Math.min(duration, Math.max(8, Math.min(25, duration * 0.72)));
    const hintedSearchEnd = segmentationHint !== null && segmentationHint >= intervalStart + 2
      ? Math.min(duration, segmentationHint + 3) : intervalStart;
    const rawSearchEnd = Math.max(localBaseSearchEnd, hintedSearchEnd);
    const searchEndClamped = rawSearchEnd > boundaryEnd;
    const searchEnd = Math.min(rawSearchEnd, boundaryEnd);
    const boundary = vdm.inferInspectionEnd(boundarySamples, events, intervalStart, searchEnd, segmentationHint);
    const firstCubeChange = Math.max(intervalStart + 0.5, boundary.time);
    const intervalEnd = Math.max(intervalStart + 0.5, Math.min(vdm.lastInspectionFrameTime(intervalStart, firstCubeChange, 60), duration));
    const decision: WindowDecision = {
      intervalStart, segmentationHint, searchEnd, searchEndClamped,
      boundaryTime: boundary.time, boundarySource: boundary.source, intervalEnd,
      stageCount: solveWindow?.stages.length ?? 0, windowCount: segmentation.windows.length,
    };
    return decision;
  }

  function mulberry32(seed: number) {
    let a = seed >>> 0;
    return function rand() {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const baselineDetected = vdm.detectMotionEvents(samples, sampleInterval);
  const baseline = computeWindow(baselineDetected.events, scanEnd);

  // Margine di picco: quanto il campione piu' vicino (sopra o sotto) dista
  // dalla soglia di rilevamento, misurata (non ricalcolata) dal valore
  // "threshold" che detectMotionEvents restituisce davvero.
  const threshold = baselineDetected.threshold as number;
  let peakMargin: { absolute: number; relative: number; sampleTime: number } | null = null;
  for (const s of samples) {
    const d = Math.abs(s.difference - threshold);
    if (!peakMargin || d < peakMargin.absolute) peakMargin = { absolute: d, relative: threshold > 0 ? d / threshold : 0, sampleTime: s.time };
  }

  const trials: TrialResult[] = [];
  let significantChangeCount = 0;
  for (let trial = 0; trial < args.trialCount; trial += 1) {
    const seed = args.seedBase + trial;
    const rand = mulberry32(seed);
    const shiftFrames = ((trial % 3) - 1) as -1 | 0 | 1;
    const perturbedRaw = samples.map((s) => ({
      ...s,
      cubeDifference: s.cubeDifference * (1 + (rand() * 2 - 1) * args.noiseAmplitude),
      time: s.time + shiftFrames * args.frameDuration,
    }));
    const perturbedFused = vdm.fuseMotionEvidence(perturbedRaw);
    const perturbedDetected = vdm.detectMotionEvents(perturbedFused, sampleInterval);
    const trialWindow = computeWindow(perturbedDetected.events, scanEnd);

    const reasons: string[] = [];
    if (Math.abs(trialWindow.intervalStart - baseline.intervalStart) > args.significantShiftS) reasons.push('intervalStart spostato > 0.5s');
    if (Math.abs(trialWindow.intervalEnd - baseline.intervalEnd) > args.significantShiftS) reasons.push('intervalEnd spostato > 0.5s');
    if (trialWindow.stageCount !== baseline.stageCount) reasons.push(`numero di fasi diverso (${baseline.stageCount} -> ${trialWindow.stageCount})`);
    const significant = reasons.length > 0;
    if (significant) significantChangeCount += 1;
    trials.push({ trial, seed, shiftFrames, significant, significantReason: reasons, ...trialWindow });
  }

  return { duration, sampleInterval, scanEnd, threshold, peakMargin, baseline, trials, significantChangeCount };
}

async function main() {
  const argv = process.argv.slice(2);
  const trialsIndex = argv.indexOf('--trials');
  const trialCount = trialsIndex >= 0 ? Math.max(10, Number(argv[trialsIndex + 1])) : 12;
  const outIndex = argv.indexOf('--out');
  const outPath = outIndex >= 0 ? path.resolve(argv[outIndex + 1]) : path.join(HERE, 'results', 'window-sensitivity.json');
  const casesIndex = argv.indexOf('--cases');
  const casesFilter = casesIndex >= 0 ? argv[casesIndex + 1].split(',') : null;

  const raw = JSON.parse(fs.readFileSync(path.join(HERE, 'cases.json'), 'utf8'));
  const videoDir = path.resolve(process.env.BENCH_VIDEO_DIR || raw.videoDir);
  const allCases: Array<{ id: string; video: string }> = raw.cases;
  const cases = casesFilter ? allCases.filter((c) => casesFilter.includes(c.id)) : allCases;
  log(`${cases.length} video da analizzare, ${trialCount} prove per video (seme base ${SEED_BASE})`);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const videoServer = await startStaticServer(videoDir);
  log(`passo 1: server video pronto (porta ${videoServer.port})`);
  const dev = await startDevServer(WEB_ROOT, '[window-sensitivity]', '/bench');
  log(`passo 2: dev server pronto: ${dev.baseUrl}`);
  const browser: Browser = await chromium.launch({
    headless: true,
    executablePath: pinnedChromeExecutable(),
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu'],
  });
  log(`passo 3: browser Chrome for Testing ${CHROME_BUILD_ID} (pinnato)`);

  const reports: VideoReport[] = [];
  let page: Page | null = null;
  activeCleanup = async () => {
    await page?.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    await dev.close().catch(() => undefined);
    videoServer.close();
  };

  try {
    page = await browser.newPage();
    page.setDefaultTimeout(ELEMENT_TIMEOUT_MS);
    page.on('console', (m) => {
      const text = m.text();
      if (m.type() === 'error' && !/XNNPACK/i.test(text)) log(`console.error: ${text}`);
    });
    await page.route(`${MEDIAPIPE_WASM_CDN}**`, async (route) => {
      const rel = route.request().url().slice(MEDIAPIPE_WASM_CDN.length).split(/[?#]/)[0];
      const abs = path.join(VENDOR_WASM_DIR, rel);
      if (!abs.startsWith(VENDOR_WASM_DIR) || !fs.existsSync(abs)) { await route.fulfill({ status: 404, body: rel }); return; }
      const type = rel.endsWith('.wasm') ? 'application/wasm' : rel.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
      await route.fulfill({ status: 200, headers: { 'content-type': type, 'access-control-allow-origin': '*' }, body: fs.readFileSync(abs) });
    });
    await page.route(MEDIAPIPE_MODEL_URL, (route) => route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/octet-stream', 'access-control-allow-origin': '*' },
      body: fs.readFileSync(path.join(VENDOR_DIR, 'hand_landmarker.task')),
    }));
    await page.goto(`${dev.baseUrl}/bench`, { waitUntil: 'load', timeout: ELEMENT_TIMEOUT_MS });
    await page.waitForFunction(() => (window as { __benchReady?: boolean }).__benchReady === true, null, { timeout: ELEMENT_TIMEOUT_MS });
    log('passo 4: pagina /bench pronta.');

    for (let videoIndex = 0; videoIndex < cases.length; videoIndex += 1) {
      const entry = cases[videoIndex];
      const videoPath = path.join(videoDir, entry.video);
      if (!fs.existsSync(videoPath)) { log(`${entry.id}: video mancante, salto (${videoPath})`); continue; }
      log(`[${videoIndex + 1}/${cases.length}] ${entry.id}: avvio decodifica+scansione (puo' richiedere qualche minuto)...`);
      const videoUrl = `http://127.0.0.1:${videoServer.port}/${encodeURIComponent(entry.video)}`;

      const work = page.evaluate(probeVideo, {
        baseUrl: dev.baseUrl, videoUrl, trialCount, seedBase: SEED_BASE + videoIndex * 1000,
        noiseAmplitude: NOISE_AMPLITUDE, frameDuration: NOMINAL_FRAME_DURATION, significantShiftS: SIGNIFICANT_SHIFT_S,
      });
      const timeoutGuard = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`timeout (${PER_VIDEO_TIMEOUT_MS}ms) per ${entry.id}: decodeVideoMotion+scanInspectionFrames+prove`)), PER_VIDEO_TIMEOUT_MS);
      });
      const probe = await Promise.race([work, timeoutGuard]) as VideoProbeResult;

      const report: VideoReport = { caseId: entry.id, videoFile: entry.video, trialCount, ...probe };
      reports.push(report);
      log(`[${videoIndex + 1}/${cases.length}] ${entry.id}: base [${report.baseline.intervalStart.toFixed(2)}-${report.baseline.intervalEnd.toFixed(2)}s] fasi=${report.baseline.stageCount} confine=${report.baseline.boundarySource} | ${report.significantChangeCount}/${trialCount} prove con cambio rilevante | margine picco relativo ${((report.peakMargin?.relative ?? 0) * 100).toFixed(1)}%`);

      fs.writeFileSync(outPath, JSON.stringify({
        meta: {
          createdAt: new Date().toISOString(), platform: `${process.platform}-${process.arch}`, node: process.version, chrome: CHROME_BUILD_ID,
          trialCount, seedBase: SEED_BASE, noiseAmplitude: NOISE_AMPLITUDE, nominalFrameDuration: NOMINAL_FRAME_DURATION, significantShiftThresholdS: SIGNIFICANT_SHIFT_S,
        },
        reports,
      }, null, 1));
    }

    log('tutti i video analizzati. Riepilogo:');
    for (const r of reports) {
      log(`  ${r.caseId}: ${r.significantChangeCount}/${r.trialCount} prove rilevanti, margine picco relativo ${((r.peakMargin?.relative ?? 0) * 100).toFixed(1)}%`);
    }
    log(`salvato: ${outPath}`);
  } finally {
    await page?.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    await dev.close().catch(() => undefined);
    videoServer.close();
  }
}

let globalTimedOut = false;
let activeCleanup: (() => Promise<void>) | null = null;
const globalTimer = setTimeout(() => {
  globalTimedOut = true;
  log(`TIMEOUT GLOBALE: superati ${GLOBAL_TIMEOUT_MS / 1000}s, chiudo browser/server e esco (i risultati parziali gia' scritti restano validi).`);
  (activeCleanup?.() ?? Promise.resolve()).finally(() => process.exit(1));
}, GLOBAL_TIMEOUT_MS);

main()
  .then(() => { if (!globalTimedOut) clearTimeout(globalTimer); })
  .catch((error) => {
    console.error('\n[window-sensitivity] errore fatale:', error instanceof Error ? error.stack : error);
    if (!globalTimedOut) clearTimeout(globalTimer);
    process.exitCode = 1;
  });
