// Esperimento #21: raccolta BATCH delle scansioni strette (coppie start/searchEnd).
//
//   node --experimental-strip-types bench/window-scan.ts [--requests FILE] [--max-minutes N]
//   node --experimental-strip-types bench/window-scan.ts --determinism [--cases ID,ID,ID]
//
// Un lancio, poi esce: nessun browser o server resta aperto. Va lanciato solo
// seguendo la skill bench-safety (un solo run, nessun altro bench attivo).
//
// SOLA LETTURA rispetto alla produzione: chiama scanInspectionFrames come
// inspection-pipeline.ts (analysisPass=0), senza flag. Verifica che
// window.__benchWindowRobust NON sia impostato.
//
// Modalita' batch (default): legge le coppie che window-replay.ts ha scritto in
// bench/results/window-scan-requests.json, scansiona quelle mancanti e le salva in
// bench/results/window-scans/<caseId>.json (scrittura atomica dopo ogni coppia,
// riprendibile: le coppie gia' presenti si saltano). Registra anche la durata
// di ogni scansione, per stimare i tempi.
//
// Modalita' --determinism (C, arresto S0c): per ciascun video (default 3) scansiona
// DUE volte la coppia di produzione, la seconda in una pagina nuova, e verifica
// che (1) le due scansioni siano identiche, (2) la finestra calcolata dalla prima
// coincida con quella registrata nella prima raccolta (altro lancio del browser).
// Esito in bench/results/window-determinism.json; codice di uscita 6 se fallisce.
// La prima scansione resta salvata come scansione di baseline del video.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { startStaticServer } from './lib/static-server.ts';
import { startDevServer } from './lib/dev-server.ts';
import { pinnedChromeExecutable, CHROME_BUILD_ID } from './chrome-path.ts';
import {
  compareScans,
  diffWindows,
  finishWindow,
  makeRequest,
  mergeRequests,
  scanKey,
  type BoundarySample,
  type ScanComparison,
  type ScanRequest,
  type VideoCache,
  type WindowDiff,
} from './lib/window-replay-core.ts';
import { loadScanFile, readRequests, saveScanFile } from './lib/scan-store-io.ts';
import { requireVideoDir } from './lib/video-dir.ts';
import { mediapipeIntegrityIssues } from './lib/mediapipe-local.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, '..');
const CACHE_DIR = path.join(HERE, 'results', 'window-cache');
const SCANS_DIR = path.join(HERE, 'results', 'window-scans');
const DEFAULT_REQUESTS = path.join(HERE, 'results', 'window-scan-requests.json');
const DETERMINISM_OUT = path.join(HERE, 'results', 'window-determinism.json');

const ELEMENT_TIMEOUT_MS = 30_000;
const PER_SCAN_TIMEOUT_MS = 6 * 60 * 1000;
const ANALYSIS_PASS = 0; // come inspection-pipeline.ts alla prima passata
const DEFAULT_DETERMINISM_CASES = ['IMG_6107', 'IMG_6260', 'IMG_6298']; // integration, test, seen

const START = Date.now();
function log(...parts: unknown[]) {
  console.log(`[window-scan] [+${((Date.now() - START) / 1000).toFixed(1)}s]`, ...parts);
}

function arg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}
const flag = (name: string) => process.argv.slice(2).includes(name);

// Eseguita nel browser. Nessuna scrittura di stato globale, nessun flag.
async function scanRange(args: { baseUrl: string; videoUrl: string; start: number; end: number; analysisPass: number }) {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const robustFlag = (window as any).__benchWindowRobust;
  if (robustFlag !== undefined) throw new Error(`__benchWindowRobust impostato (${String(robustFlag)}): la raccolta deve essere a flag spenti`);
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
  const scan = await vdm.scanInspectionFrames(video, args.start, args.end, { analysisPass: args.analysisPass });
  video.removeAttribute('src');
  video.load();
  video.remove();
  return (scan as any[]).map((s) => ({ time: s.time, faceGrids: s.faceGrids })) as BoundarySample[];
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

function git(args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: WEB_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'n/d';
  }
}

interface Session {
  baseUrl: string;
  videoUrl(file: string): string;
  newPage(): Promise<Page>;
  close(): Promise<void>;
}

async function openSession(videoDir: string): Promise<Session> {
  const videoServer = await startStaticServer(videoDir);
  const dev = await startDevServer(WEB_ROOT, '[window-scan]', '/bench');
  const browser: Browser = await chromium.launch({
    headless: true,
    executablePath: pinnedChromeExecutable(),
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu'],
  });
  log(`dev server ${dev.baseUrl}, Chrome for Testing ${CHROME_BUILD_ID} (pinnato)`);
  const pages: Page[] = [];
  return {
    baseUrl: dev.baseUrl,
    videoUrl: (file) => `http://127.0.0.1:${videoServer.port}/${encodeURIComponent(file)}`,
    async newPage() {
      const page = await browser.newPage();
      pages.push(page);
      page.setDefaultTimeout(ELEMENT_TIMEOUT_MS);
      page.on('console', (m) => {
        const text = m.text();
        if (m.type() === 'error' && !/XNNPACK/i.test(text)) log(`console.error: ${text}`);
      });
      await page.goto(`${dev.baseUrl}/bench`, { waitUntil: 'load', timeout: ELEMENT_TIMEOUT_MS });
      await page.waitForFunction(() => (window as { __benchReady?: boolean }).__benchReady === true, null, { timeout: ELEMENT_TIMEOUT_MS });
      return page;
    },
    async close() {
      for (const page of pages) await page.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
      await dev.close().catch(() => undefined);
      videoServer.close();
    },
  };
}

async function timedScan(session: Session, page: Page, videoFile: string, request: ScanRequest) {
  const t0 = Date.now();
  const work = page.evaluate(scanRange, {
    baseUrl: session.baseUrl,
    videoUrl: session.videoUrl(videoFile),
    start: request.start,
    end: request.end,
    analysisPass: ANALYSIS_PASS,
  });
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout (${PER_SCAN_TIMEOUT_MS}ms) per ${request.caseId} ${request.key}`)), PER_SCAN_TIMEOUT_MS);
  });
  try {
    const samples = await Promise.race([work, guard]) as BoundarySample[];
    return { samples, ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

function saveScan(caseId: string, request: ScanRequest, samples: BoundarySample[], ms: number, gitInfo: { commit: string; status: string }) {
  const file = loadScanFile(SCANS_DIR, caseId);
  file.meta = { platform: `${process.platform}-${process.arch}`, chrome: CHROME_BUILD_ID, gitCommit: gitInfo.commit, gitStatus: gitInfo.status, analysisPass: ANALYSIS_PASS, updatedAt: new Date().toISOString() };
  file.scans[request.key] = { start: request.start, end: request.end, ms, samples };
  saveScanFile(SCANS_DIR, file);
}

interface DeterminismRecord {
  caseId: string;
  start: number;
  end: number;
  samples: number;
  scanMs: [number, number];
  scansIdentical: ScanComparison;
  windowVsFirstCollection: WindowDiff[] | 'n/d (cache senza finestra di produzione)';
  ok: boolean;
}

async function runDeterminism(session: Session, cases: Array<{ id: string; video: string }>, gitInfo: { commit: string; status: string }): Promise<number> {
  const wanted = (arg('--cases')?.split(',') ?? DEFAULT_DETERMINISM_CASES);
  const records: DeterminismRecord[] = [];
  for (const caseId of wanted) {
    const entry = cases.find((c) => c.id === caseId);
    const cacheFile = path.join(CACHE_DIR, `${caseId}.json`);
    if (!entry || !fs.existsSync(cacheFile)) throw new Error(`${caseId}: caso o cache eventi mancante`);
    const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as VideoCache;
    if (!cache.production) throw new Error(`${caseId}: la cache non ha la finestra di produzione`);
    const request = makeRequest(caseId, cache.production.intervalStart, cache.production.searchEnd);
    log(`${caseId}: determinismo su (${request.start}, ${request.end}), scansione 1...`);
    const first = await timedScan(session, await session.newPage(), entry.video, request);
    log(`${caseId}: scansione 1 in ${(first.ms / 1000).toFixed(1)}s (${first.samples.length} campioni), scansione 2 in pagina nuova...`);
    const second = await timedScan(session, await session.newPage(), entry.video, request);
    const identical = compareScans(first.samples, second.samples);
    const plan = {
      intervalStart: cache.production.intervalStart,
      segmentationHint: cache.production.segmentationHint,
      searchEnd: cache.production.searchEnd,
      stageCount: cache.production.stageCount,
      windowCount: cache.production.windowCount,
      solveWindow: null, // non serve a finishInspectionWindow
    };
    const window = finishWindow(plan, cache.events, first.samples, cache.meta.duration);
    const diff = diffWindows(window, cache.production);
    records.push({
      caseId, start: request.start, end: request.end, samples: first.samples.length, scanMs: [first.ms, second.ms],
      scansIdentical: identical, windowVsFirstCollection: diff, ok: identical.identical && diff.length === 0,
    });
    saveScan(caseId, request, first.samples, first.ms, gitInfo); // resta come scansione di baseline
    log(`${caseId}: scansioni ${identical.identical ? 'IDENTICHE' : `DIVERSE (${identical.firstDiff})`}; finestra vs prima raccolta: ${diff.length ? diff.map((d) => `${d.field} ${d.replay}!=${d.production}`).join('; ') : 'identica'}`);
  }
  const failed = records.filter((r) => !r.ok);
  fs.mkdirSync(path.dirname(DETERMINISM_OUT), { recursive: true });
  fs.writeFileSync(DETERMINISM_OUT, JSON.stringify({ createdAt: new Date().toISOString(), ...gitInfo, records }, null, 1));
  log(`determinismo: ${records.length - failed.length}/${records.length} video ok -> ${DETERMINISM_OUT}`);
  if (failed.length > 0) {
    log('S0c SCATTATA: la scansione non e\' deterministica (o la finestra non coincide con la prima raccolta). FERMARSI e riportare al titolare.');
    return 6;
  }
  return 0;
}

async function runBatch(session: Session, cases: Array<{ id: string; video: string }>, gitInfo: { commit: string; status: string }, deadline: number): Promise<number> {
  const requestsPath = path.resolve(arg('--requests') ?? DEFAULT_REQUESTS);
  const requests = mergeRequests(readRequests(requestsPath));
  const todo = requests.filter((r) => !(scanKey(r.start, r.end) in loadScanFile(SCANS_DIR, r.caseId).scans));
  log(`${requests.length} coppie richieste, ${todo.length} da scansionare (le altre sono gia' in cache)`);
  const page = todo.length > 0 ? await session.newPage() : null;
  let done = 0;
  const durations: number[] = [];
  for (const request of todo) {
    if (Date.now() > deadline) { log('limite di tempo raggiunto: mi fermo (le coppie salvate restano valide, rilancia per proseguire).'); return 2; }
    const entry = cases.find((c) => c.id === request.caseId);
    if (!entry) throw new Error(`${request.caseId}: caso sconosciuto in cases.json`);
    const { samples, ms } = await timedScan(session, page!, entry.video, request);
    saveScan(request.caseId, request, samples, ms, gitInfo);
    durations.push(ms);
    done += 1;
    const mean = durations.reduce((a, b) => a + b, 0) / durations.length;
    log(`[${done}/${todo.length}] ${request.caseId} (${request.start.toFixed(3)}, ${request.end.toFixed(3)}): ${samples.length} campioni in ${(ms / 1000).toFixed(1)}s; restano ~${((todo.length - done) * mean / 60000).toFixed(1)} min`);
  }
  log('batch completato. Rilancia window-replay.ts.');
  return 0;
}

let activeCleanup: (() => Promise<void>) | null = null;

async function main(): Promise<number> {
  // MediaPipe e' servito dall'app (public/mediapipe): file e hash del modello devono essere quelli fissati.
  const mediapipeIssues = mediapipeIntegrityIssues();
  if (mediapipeIssues.length) throw new Error(`file MediaPipe in public/mediapipe non integri: ${mediapipeIssues.join('; ')}`);
  const raw = JSON.parse(fs.readFileSync(path.join(HERE, 'cases.json'), 'utf8'));
  const videoDir = requireVideoDir(raw.videoDir);
  const cases: Array<{ id: string; video: string }> = raw.cases;
  const gitInfo = { commit: git(['rev-parse', 'HEAD']), status: git(['status', '--short']) };
  const maxMinutes = Number(arg('--max-minutes') ?? 90);
  log(`commit ${gitInfo.commit.slice(0, 12)}, stato albero: ${gitInfo.status ? gitInfo.status.split('\n').length + ' file modificati' : 'pulito'}, limite ${maxMinutes} min`);
  const session = await openSession(videoDir);
  activeCleanup = () => session.close();
  try {
    return flag('--determinism')
      ? await runDeterminism(session, cases, gitInfo)
      : await runBatch(session, cases, gitInfo, START + maxMinutes * 60_000);
  } finally {
    await session.close();
    activeCleanup = null;
  }
}

const GLOBAL_TIMEOUT_MS = (Number(arg('--max-minutes') ?? 90) + 5) * 60_000;
const globalTimer = setTimeout(() => {
  log('TIMEOUT GLOBALE: chiudo browser/server e esco (le scansioni salvate restano valide).');
  (activeCleanup?.() ?? Promise.resolve()).finally(() => process.exit(1));
}, GLOBAL_TIMEOUT_MS);

main()
  .then((code) => { clearTimeout(globalTimer); process.exitCode = code; })
  .catch((error) => {
    clearTimeout(globalTimer);
    console.error('\n[window-scan] errore fatale:', error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
