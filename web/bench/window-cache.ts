// Esperimento #21: raccolta UNA TANTUM dei dati grezzi della finestra di ispezione.
//
//   node --experimental-strip-types bench/window-cache.ts [--cases IMG_6258,...] [--force] [--no-production-window]
//
// SOLA LETTURA rispetto alla produzione: chiama le funzioni di lib/video-decoder.ts
// esattamente come lib/inspection-pipeline.ts (stesso analysisPass=0), senza
// accendere nessun flag e senza modificare nessun comportamento. Nel browser
// verifica che window.__benchWindowRobust NON sia impostato.
//
// Per ogni video salva in bench/results/window-cache/<id>.json (gitignored: solo
// numeri, nessun fotogramma): campioni completi gia' fusi, eventi di produzione,
// scansione larga [0, scanEnd] per l'inferenza del confine, e la finestra
// calcolata come in produzione (scansione stretta) per il confronto di fedelta'.
//
// Riprendibile: i video gia' in cache si saltano (salvo --force).
// Il replay vero e proprio e' bench/window-replay.ts (Node, senza browser).
//
// Va lanciato solo seguendo la skill bench-safety (un solo run, nessun altro
// bench attivo, porta 3000/3100 libera, BENCH_VIDEO_DIR come in CLAUDE.md).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { startStaticServer } from './lib/static-server.ts';
import { startDevServer } from './lib/dev-server.ts';
import { pinnedChromeExecutable, CHROME_BUILD_ID } from './chrome-path.ts';
import type { VideoCache } from './lib/window-replay-core.ts';
import { requireVideoDir } from './lib/video-dir.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, '..');
const CACHE_DIR = path.join(HERE, 'results', 'window-cache');
const VENDOR_DIR = path.join(HERE, 'vendor', 'mediapipe');
const VENDOR_WASM_DIR = path.join(VENDOR_DIR, 'wasm');
const MEDIAPIPE_WASM_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm/';
const MEDIAPIPE_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

const GLOBAL_TIMEOUT_MS = 60 * 60 * 1000;
const ELEMENT_TIMEOUT_MS = 30_000;
const PER_VIDEO_TIMEOUT_MS = 10 * 60 * 1000; // decodeVideoMotion + scansione larga + scansione stretta
const ANALYSIS_PASS = 0; // come inspection-pipeline.ts alla prima passata

const START = Date.now();
function log(...parts: unknown[]) {
  console.log(`[window-cache] [+${((Date.now() - START) / 1000).toFixed(1)}s]`, ...parts);
}

type CollectArgs = { baseUrl: string; videoUrl: string; analysisPass: number; withProductionWindow: boolean };
type Collected = Pick<VideoCache, 'samples' | 'events' | 'threshold' | 'boundarySamples' | 'production'> & {
  duration: number;
  sampleInterval: number;
  scanEnd: number;
  windowRobustFlag: unknown;
};

// Eseguita nel browser. Nessuna scrittura di stato globale, nessun flag.
async function collectVideo(args: CollectArgs): Promise<Collected> {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const flag = (window as any).__benchWindowRobust;
  if (flag !== undefined) throw new Error(`__benchWindowRobust impostato (${String(flag)}): la raccolta deve essere a flag spenti`);
  const vdm: any = await import(/* @vite-ignore */ `${args.baseUrl}/lib/video-decoder.ts`);

  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = args.videoUrl;
  document.body.appendChild(video);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('video non pronto entro 30s')), 30000);
    const ready = () => {
      if (video.readyState >= 2 && Number.isFinite(video.duration) && video.duration > 0) { clearTimeout(timer); resolve(); }
    };
    video.addEventListener('canplay', ready);
    video.addEventListener('loadeddata', ready);
    ready();
  });
  video.pause();
  const duration = video.duration;

  // Come inspection-pipeline.ts:86-91.
  const motion = await vdm.decodeVideoMotion(video, { startTime: 0, endTime: duration, analysisPass: args.analysisPass });

  // Scansione larga una sola volta (come nel #20): copre ogni start/search-end possibile.
  const baseSearchEnd = Math.min(duration, Math.max(8, Math.min(25, duration * 0.72)));
  const scanEnd = Math.min(duration, Math.max(28, baseSearchEnd + 5));
  const wide = await vdm.scanInspectionFrames(video, 0, scanEnd, { analysisPass: args.analysisPass });
  const boundarySamples = (wide as any[]).map((s) => ({ time: s.time, faceGrids: s.faceGrids }));

  // Riferimento di produzione: copia fedele di inspection-pipeline.ts:94-128,
  // con la scansione STRETTA [intervalStart, searchEnd] come fa l'app.
  let production: any = null;
  if (args.withProductionWindow) {
    const segmentation = vdm.inferVideoSegmentation(motion.events, 0, duration);
    const solveWindow = segmentation.windows.find((w: any) => w.id === segmentation.defaultWindowId);
    const inspectionStage = solveWindow?.stages.find((s: any) => s.kind === 'inspection');
    const automaticStart = inspectionStage?.start ?? 0;
    const intervalStart = Math.max(0, Math.min(automaticStart, duration - 0.5));
    const segmentationHint = inspectionStage?.end ?? solveWindow?.start ?? null;
    const hintedSearchEnd = segmentationHint && segmentationHint >= intervalStart + 2
      ? Math.min(duration, segmentationHint + 3)
      : intervalStart;
    const searchEnd = Math.max(baseSearchEnd, hintedSearchEnd);
    const narrow = await vdm.scanInspectionFrames(video, intervalStart, searchEnd, { analysisPass: args.analysisPass });
    const boundary = vdm.inferInspectionEnd(narrow, motion.events, intervalStart, searchEnd, segmentationHint);
    const firstCubeChange = Math.max(intervalStart + 0.5, boundary.time);
    const intervalEnd = Math.max(
      intervalStart + 0.5,
      Math.min(vdm.lastInspectionFrameTime(intervalStart, firstCubeChange, 60), duration),
    );
    production = {
      intervalStart,
      segmentationHint,
      searchEnd,
      searchEndClamped: false,
      boundaryTime: boundary.time,
      boundarySource: boundary.source,
      intervalEnd,
      stageCount: solveWindow?.stages.length ?? 0,
      windowCount: segmentation.windows.length,
    };
  }

  video.removeAttribute('src');
  video.load();
  video.remove();
  return {
    duration,
    sampleInterval: motion.sampleInterval,
    scanEnd,
    threshold: motion.threshold,
    samples: motion.samples,
    events: motion.events,
    boundarySamples,
    production,
    windowRobustFlag: flag,
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

function git(args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: WEB_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'n/d';
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const force = argv.includes('--force');
  const withProductionWindow = !argv.includes('--no-production-window');
  const casesIndex = argv.indexOf('--cases');
  const casesFilter = casesIndex >= 0 ? argv[casesIndex + 1].split(',') : null;

  const raw = JSON.parse(fs.readFileSync(path.join(HERE, 'cases.json'), 'utf8'));
  const videoDir = requireVideoDir(raw.videoDir);
  const allCases: Array<{ id: string; video: string }> = raw.cases;
  const cases = casesFilter ? allCases.filter((c) => casesFilter.includes(c.id)) : allCases;
  const gitCommit = git(['rev-parse', 'HEAD']);
  const gitStatus = git(['status', '--short']);
  log(`${cases.length} video, finestra di produzione: ${withProductionWindow ? 'si' : 'no'}, commit ${gitCommit.slice(0, 12)}, stato albero: ${gitStatus ? gitStatus.split('\n').length + ' file modificati' : 'pulito'}`);

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const videoServer = await startStaticServer(videoDir);
  const dev = await startDevServer(WEB_ROOT, '[window-cache]', '/bench');
  const browser: Browser = await chromium.launch({
    headless: true,
    executablePath: pinnedChromeExecutable(),
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu'],
  });
  log(`dev server ${dev.baseUrl}, Chrome for Testing ${CHROME_BUILD_ID} (pinnato)`);

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
    // MediaPipe servito dai file vendorizzati (come run-bench.ts): niente rete esterna.
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

    for (let index = 0; index < cases.length; index += 1) {
      const entry = cases[index];
      const target = path.join(CACHE_DIR, `${entry.id}.json`);
      if (!force && fs.existsSync(target)) { log(`${entry.id}: gia' in cache, salto`); continue; }
      const videoPath = path.join(videoDir, entry.video);
      if (!fs.existsSync(videoPath)) { log(`${entry.id}: video mancante, salto`); continue; }
      log(`[${index + 1}/${cases.length}] ${entry.id}: raccolta in corso...`);
      const videoUrl = `http://127.0.0.1:${videoServer.port}/${encodeURIComponent(entry.video)}`;

      const work = page.evaluate(collectVideo, { baseUrl: dev.baseUrl, videoUrl, analysisPass: ANALYSIS_PASS, withProductionWindow });
      const guard = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`timeout (${PER_VIDEO_TIMEOUT_MS}ms) per ${entry.id}`)), PER_VIDEO_TIMEOUT_MS);
      });
      const data = await Promise.race([work, guard]) as Collected;

      const cache: VideoCache = {
        meta: {
          caseId: entry.id,
          videoFile: entry.video,
          duration: data.duration,
          sampleInterval: data.sampleInterval,
          scanEnd: data.scanEnd,
          createdAt: new Date().toISOString(),
          platform: `${process.platform}-${process.arch}`,
          chrome: CHROME_BUILD_ID,
          gitCommit,
          gitStatus,
          analysisPass: ANALYSIS_PASS,
          windowRobustFlag: data.windowRobustFlag ?? null,
        },
        samples: data.samples,
        events: data.events,
        threshold: data.threshold,
        boundarySamples: data.boundarySamples,
        production: data.production,
      };
      fs.writeFileSync(target, JSON.stringify(cache));
      log(`[${index + 1}/${cases.length}] ${entry.id}: ${data.samples.length} campioni, ${data.events.length} eventi, ${data.boundarySamples?.length ?? 0} campioni di confine -> ${path.relative(WEB_ROOT, target)}`);
    }
    log('raccolta completata.');
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
  log(`TIMEOUT GLOBALE: superati ${GLOBAL_TIMEOUT_MS / 1000}s, chiudo browser/server e esco (i video gia' in cache restano validi).`);
  (activeCleanup?.() ?? Promise.resolve()).finally(() => process.exit(1));
}, GLOBAL_TIMEOUT_MS);

main()
  .then(() => { if (!globalTimedOut) clearTimeout(globalTimer); })
  .catch((error) => {
    console.error('\n[window-cache] errore fatale:', error instanceof Error ? error.stack : error);
    if (!globalTimedOut) clearTimeout(globalTimer);
    process.exitCode = 1;
  });
