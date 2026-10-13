// Diagnosi Mac/Windows (solo diagnosi, NON modifica la pipeline): per UN video
// salva in un JSON confrontabile ogni anello della catena
//   moto -> segmentazione -> finestra di ispezione -> tempi dei fotogrammi
//   -> pixel (hash) -> input del modello (hash) -> output ONNX grezzo (hash)
//   -> vertici/score dopo NMS e due passaggi -> griglie (colori, confidenze,
//   rotazione, gridAlignmentIndex) -> diagnostica della ricostruzione -> punteggio.
//
// Riproduce l'orchestrazione di lib/inspection-pipeline.ts chiamando le STESSE
// funzioni esportate (per avere i valori intermedi che la pipeline non
// restituisce); il punteggio finale va confrontato con `pnpm bench`.
//
//   node --experimental-strip-types bench/diag-platform-diff.ts IMG_6258 [--out file.json]
//   node --experimental-strip-types bench/diag-platform-diff.ts --compare mac.json win.json
//
// Stesso Chrome for Testing pinnato, stessi flag GL e stesso MediaPipe
// vendorizzato di bench/run-bench.ts.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startStaticServer } from './lib/static-server.ts';
import { startDevServer } from './lib/dev-server.ts';
import { pinnedChromeExecutable, CHROME_BUILD_ID } from './chrome-path.ts';
import { scoreReconstruction } from './lib/score.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, '..');
const VENDOR_DIR = path.join(HERE, 'vendor', 'mediapipe');
const VENDOR_WASM_DIR = path.join(VENDOR_DIR, 'wasm');
const MEDIAPIPE_WASM_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm/';
const MEDIAPIPE_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

const log = (...parts: unknown[]) => console.log('[diag]', ...parts);

// ---------------------------------------------------------------- browser side
// Eseguita dentro la pagina /bench. Tutto cio' che serve viene importato
// dinamicamente dal dev server Vite (stessi moduli dell'app).
async function pageDiag(args: { baseUrl: string; videoUrl: string }) {
  const { baseUrl, videoUrl } = args;
  const vd = await import(/* @vite-ignore */ `${baseUrl}/lib/video-decoder.ts`);
  const fkm = await import(/* @vite-ignore */ `${baseUrl}/lib/face-keypoint-model.ts`);
  // onnxruntime-web: l'URL "ottimizzato" da Vite si ricava dal sorgente
  // trasformato di face-keypoint-model.ts (cosi' e' la STESSA build).
  const fkmSource = await (await fetch(`${baseUrl}/lib/face-keypoint-model.ts`)).text();
  const ortMatch = /from\s+["']([^"']*onnxruntime-web[^"']*)["']/.exec(fkmSource);
  const ort = ortMatch ? await import(/* @vite-ignore */ new URL(ortMatch[1], baseUrl).href) : null;

  const g = globalThis as Record<string, unknown>;
  g.__benchFaceObservationDiag = {};
  g.__benchStableRawDiag = {};
  g.__benchChoicesDiag = {};
  g.__benchPartialDiag = {};
  g.__benchCandidateStatesDiag = [];
  g.__benchAlignmentFilteredObservations = [];
  g.__benchGridAlignmentSafeguardColors = [];
  g.__benchModelGateAttempts = {};
  g.__benchObservationsDiag = { observations: [], balancedInfo: { observedCells: 0, usable: false } };
  g.__benchBudgetTelemetry = {};

  const hash = async (bytes: ArrayBufferView | ArrayBuffer) => {
    const digest = await crypto.subtle.digest('SHA-256', bytes as ArrayBuffer);
    return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
  };
  const canvasHash = (ctx: CanvasRenderingContext2D, w: number, h: number) => hash(ctx.getImageData(0, 0, w, h).data);

  // --- sonde d'ambiente: scalatura canvas e ONNX su input sintetici ---
  const synth = document.createElement('canvas');
  synth.width = 997; synth.height = 1771;
  const sctx = synth.getContext('2d')!;
  const img = sctx.createImageData(synth.width, synth.height);
  let seed = 12345;
  for (let i = 0; i < img.data.length; i += 4) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    img.data[i] = seed & 255; img.data[i + 1] = (seed >> 8) & 255; img.data[i + 2] = (seed >> 16) & 255; img.data[i + 3] = 255;
  }
  sctx.putImageData(img, 0, 0);
  const scaled = document.createElement('canvas');
  scaled.width = 512; scaled.height = 287;
  const scx = scaled.getContext('2d')!;
  scx.drawImage(synth, 0, 0, 512, 287);
  const probes: Record<string, unknown> = {
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    devicePixelRatio: window.devicePixelRatio,
    canvasDownscaleHash: await canvasHash(scx, 512, 287),
    ortImport: ortMatch?.[1] ?? null,
  };

  let session: { run: (feeds: Record<string, unknown>) => Promise<Record<string, { data: Float32Array; dims: number[] }>>; inputNames: string[]; outputNames: string[] } | null = null;
  if (ort) {
    ort.env.wasm.numThreads = 1;
    session = await ort.InferenceSession.create('/models/cube-face-keypoints.onnx', { executionProviders: ['wasm'] });
    const tensor = new Float32Array(3 * 512 * 512);
    for (let i = 0; i < tensor.length; i += 1) tensor[i] = ((i * 2654435761) >>> 0) / 4294967296;
    const out = await session!.run({ [session!.inputNames[0]]: new ort.Tensor('float32', tensor, [1, 3, 512, 512]) });
    const data = out[session!.outputNames[0]].data;
    probes.ortSyntheticOutputHash = await hash(data);
    probes.ortSyntheticHead = Array.from(data.slice(0, 6));
    probes.ortSimd = ort.env.wasm.simd;
  }

  // --- video, identico alla pagina bench ---
  const video = document.createElement('video');
  video.crossOrigin = 'anonymous'; video.muted = true; video.playsInline = true;
  video.preload = 'auto'; video.controls = false;
  video.style.width = '320px'; video.style.opacity = '0';
  video.src = videoUrl;
  document.body.appendChild(video);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('video non pronto entro 60s')), 60000);
    const ready = () => {
      if (video.readyState >= 2 && Number.isFinite(video.duration) && video.duration > 0) { clearTimeout(t); resolve(); }
    };
    video.addEventListener('canplay', ready); video.addEventListener('loadeddata', ready); ready();
  });
  const videoInfo = { width: video.videoWidth, height: video.videoHeight, duration: video.duration };

  // --- orchestrazione = lib/inspection-pipeline.ts (maxFusionPasses 1) ---
  video.pause();
  let completedRuns = 0;
  const decoded = await vd.decodeVideoMotion(video, { startTime: 0, endTime: video.duration, analysisPass: completedRuns });
  const segmentation = vd.inferVideoSegmentation(decoded.events, 0, video.duration);
  const solveWindow = segmentation.windows.find((w: { id: number }) => w.id === segmentation.defaultWindowId);
  const inspectionStage = solveWindow?.stages.find((s: { kind: string }) => s.kind === 'inspection');
  const automaticStart = inspectionStage?.start ?? 0;
  const intervalStart = Math.max(0, Math.min(automaticStart, video.duration - 0.5));
  const segmentationHint = inspectionStage?.end ?? solveWindow?.start ?? null;
  const baseSearchEnd = Math.min(video.duration, Math.max(8, Math.min(25, video.duration * 0.72)));
  const hintedSearchEnd = segmentationHint && segmentationHint >= intervalStart + 2
    ? Math.min(video.duration, segmentationHint + 3) : intervalStart;
  const searchEnd = Math.max(baseSearchEnd, hintedSearchEnd);
  const boundarySamples = await vd.scanInspectionFrames(video, intervalStart, searchEnd, { analysisPass: completedRuns });
  const boundary = vd.inferInspectionEnd(boundarySamples, decoded.events, intervalStart, searchEnd, segmentationHint);
  const firstCubeChange = Math.max(intervalStart + 0.5, boundary.time);
  const intervalEnd = Math.max(intervalStart + 0.5, Math.min(vd.lastInspectionFrameTime(intervalStart, firstCubeChange, 60), video.duration));
  let combined = boundarySamples.filter((s: { time: number }) => s.time <= intervalEnd);
  const outsideWindow = boundarySamples.filter((s: { time: number }) => s.time > intervalEnd);
  completedRuns += 1;
  let summary = vd.summarizeCubeObservation(combined, intervalStart, intervalEnd);
  const statusAfterBoundary = summary.reconstruction.status;
  let fusionTimes: number[] = [];
  if (summary.reconstruction.status !== 'complete') {
    fusionTimes = vd.buildInspectionSampleTimes(intervalStart, intervalEnd, completedRuns);
    const scanned = await vd.scanInspectionFrames(video, intervalStart, intervalEnd, { analysisPass: completedRuns });
    combined = [...combined, ...scanned];
    completedRuns += 1;
    summary = vd.summarizeCubeObservation(combined, intervalStart, intervalEnd);
  }
  let usedDecodedFallback = false;
  if (!summary.reconstruction.observedFaces.length) {
    usedDecodedFallback = true;
    summary = vd.summarizeCubeObservation([...combined, ...decoded.samples], intervalStart, intervalEnd);
  }

  // --- replay per fotogramma: pixel, input modello, output modello ---
  const waitSeek = (time: number) => new Promise<void>((resolve, reject) => {
    const target = Math.min(Math.max(0, time), Math.max(0, video.duration - 0.01));
    if (video.readyState >= 2 && Math.abs(video.currentTime - target) < 0.01) { requestAnimationFrame(() => resolve()); return; }
    const t = setTimeout(() => reject(new Error(`seek ${time}`)), 8000);
    video.addEventListener('seeked', () => { clearTimeout(t); resolve(); }, { once: true });
    video.currentTime = target;
  });
  const portrait = video.videoHeight >= video.videoWidth;
  const crops = vd.inspectionCropVariants(portrait);
  const modelScale = Math.min(1, 960 / Math.max(video.videoWidth, video.videoHeight));
  const scanTimes = [...new Set([...combined, ...outsideWindow].map((s: { time: number }) => s.time))].sort((a, b) => a - b) as number[];
  const round = (v: number) => Math.round(v * 1000) / 1000;
  const frames = [];
  for (const time of scanTimes) {
    await waitSeek(time);
    const native = document.createElement('canvas');
    native.width = video.videoWidth; native.height = video.videoHeight;
    const nctx = native.getContext('2d', { willReadFrequently: true })!;
    nctx.drawImage(video, 0, 0);
    const modelCanvas = document.createElement('canvas');
    modelCanvas.width = Math.round(video.videoWidth * modelScale);
    modelCanvas.height = Math.round(video.videoHeight * modelScale);
    const mctx = modelCanvas.getContext('2d')!;
    mctx.drawImage(video, 0, 0, modelCanvas.width, modelCanvas.height);
    // letterbox del passaggio 1 (stessa matematica di face-keypoint-model.ts)
    const lb = document.createElement('canvas');
    lb.width = 512; lb.height = 512;
    const lctx = lb.getContext('2d')!;
    const lscale = Math.min(512 / modelCanvas.width, 512 / modelCanvas.height);
    const nw = Math.round(modelCanvas.width * lscale); const nh = Math.round(modelCanvas.height * lscale);
    lctx.fillStyle = 'rgb(114,114,114)'; lctx.fillRect(0, 0, 512, 512);
    lctx.drawImage(modelCanvas, 0, 0, modelCanvas.width, modelCanvas.height, Math.floor((512 - nw) / 2), Math.floor((512 - nh) / 2), nw, nh);
    const lpx = lctx.getImageData(0, 0, 512, 512).data;
    let rawOutput: Record<string, unknown> | null = null;
    if (session && ort) {
      const size = 512 * 512; const tensor = new Float32Array(3 * size);
      for (let i = 0; i < size; i += 1) { tensor[i] = lpx[i * 4] / 255; tensor[size + i] = lpx[i * 4 + 1] / 255; tensor[2 * size + i] = lpx[i * 4 + 2] / 255; }
      const out = (await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', tensor, [1, 3, 512, 512]) }))[session.outputNames[0]];
      const [, , anchors] = out.dims;
      let maxConf = 0;
      for (let a = 0; a < anchors; a += 1) maxConf = Math.max(maxConf, out.data[4 * anchors + a]);
      rawOutput = { hash: await hash(out.data), maxConf };
    }
    const detections = fkm.filterPlausibleDetections(await fkm.detectFaceCornersTwoPassRefine(mctx, modelCanvas.width, modelCanvas.height, 2.5));
    const cropHashes = [];
    for (const crop of crops) {
      const a = document.createElement('canvas');
      a.width = portrait ? vd.ANALYSIS_CANVAS_WIDTH_PORTRAIT : vd.ANALYSIS_CANVAS_WIDTH_LANDSCAPE;
      a.height = Math.round(a.width * (video.videoHeight * crop.height) / (video.videoWidth * crop.width));
      const actx = a.getContext('2d', { willReadFrequently: true })!;
      actx.drawImage(video, video.videoWidth * crop.x, video.videoHeight * crop.y, video.videoWidth * crop.width, video.videoHeight * crop.height, 0, 0, a.width, a.height);
      cropHashes.push(await canvasHash(actx, a.width, a.height));
    }
    frames.push({
      time,
      currentTimeAfterSeek: video.currentTime,
      nativeHash: await canvasHash(nctx, native.width, native.height),
      modelCanvasHash: await canvasHash(mctx, modelCanvas.width, modelCanvas.height),
      letterboxHash: await hash(lpx),
      cropHashes,
      rawOutput,
      detections: detections.map((d: { score: number; keypoints: Array<{ x: number; y: number }> }) => ({
        score: d.score, keypoints: d.keypoints.map((p) => [round(p.x), round(p.y)]),
      })),
    });
  }

  type Grid = Record<string, unknown> & { silhouette?: Array<{ x: number; y: number }>; rawColors?: unknown[] };
  const grids = [...combined, ...outsideWindow].flatMap((s: { time: number; faceGrids?: Grid[]; sharpness?: number }) => (s.faceGrids ?? []).map((grid) => ({
    time: s.time,
    insideWindow: s.time <= intervalEnd,
    frameId: grid.frameId,
    gridSource: grid.gridSource,
    centerColor: grid.centerColor,
    colors: grid.colors,
    confidence: grid.confidence,
    visibleCells: grid.visibleCells,
    cellConfidences: grid.cellConfidences,
    orientationTurns: grid.orientationTurns,
    orientationConfidence: grid.orientationConfidence,
    gridAlignmentIndex: grid.gridAlignmentIndex,
    silhouette: grid.silhouette?.map((p) => [round(p.x), round(p.y)]),
    rawColors: grid.rawColors,
    sharpness: s.sharpness,
  })));

  const rec = summary.reconstruction;
  video.removeAttribute('src'); video.load(); video.remove();
  return {
    probes,
    videoInfo,
    motion: {
      sampleCount: decoded.samples.length,
      sampleInterval: decoded.sampleInterval,
      threshold: decoded.threshold,
      handTracking: decoded.handTracking,
      samples: decoded.samples.map((s: Record<string, number>) => ({
        time: s.time, difference: s.difference, cubeDifference: s.cubeDifference, handMotion: s.handMotion, handCount: s.handCount,
      })),
      events: decoded.events.map((e: Record<string, unknown>) => ({
        start: e.start, end: e.end, peakTime: e.peakTime, motionKind: e.motionKind, evidence: e.evidence, cubeStrength: e.cubeStrength, candidateMove: e.candidateMove,
      })),
    },
    segmentation: {
      defaultWindowId: segmentation.defaultWindowId,
      windows: segmentation.windows.map((w: Record<string, unknown>) => ({ id: w.id, start: w.start, end: w.end, stages: w.stages })),
    },
    window: {
      intervalStart, searchEnd, segmentationHint, boundary, intervalEnd,
      boundaryScanTimes: boundarySamples.map((s: { time: number }) => s.time).filter((t: number, i: number, a: number[]) => a.indexOf(t) === i),
      fusionTimes, statusAfterBoundary, runCount: completedRuns, usedDecodedFallback,
    },
    frames,
    grids,
    reconstruction: {
      status: rec.status,
      observedFaces: rec.observedFaces,
      facelets: rec.facelets,
      completeFacelets: rec.completeFacelets,
      cellConfidence: rec.cellConfidence,
      candidateCount: rec.candidateCount,
      truncated: rec.truncated,
      confidence: summary.confidence,
      detectedColors: summary.detectedColors,
      faceObservationDiag: g.__benchFaceObservationDiag,
      stableRawDiag: g.__benchStableRawDiag,
      choicesDiag: g.__benchChoicesDiag,
      partialDiag: g.__benchPartialDiag,
      candidateStatesCount: (g.__benchCandidateStatesDiag as unknown[]).length,
      gridAlignmentSafeguardColors: g.__benchGridAlignmentSafeguardColors,
      modelGateAttempts: g.__benchModelGateAttempts,
      budgetTelemetry: g.__benchBudgetTelemetry,
      alignmentFilteredObservations: (g.__benchAlignmentFilteredObservations as Grid[]).map((o) => ({
        time: o.time, frameId: o.frameId, centerColor: o.centerColor, colors: o.colors, gridAlignmentIndex: o.gridAlignmentIndex, confidence: o.confidence,
      })),
    },
  };
}

// ------------------------------------------------------------------- run mode
async function run(caseId: string, outArg: string | undefined) {
  const raw = JSON.parse(fs.readFileSync(path.join(HERE, 'cases.json'), 'utf8'));
  const entry = (raw.cases as Array<{ id: string; video: string; scramble: string }>).find((c) => c.id === caseId);
  if (!entry) throw new Error(`caso sconosciuto: ${caseId}`);
  const videoDir = path.resolve(process.env.BENCH_VIDEO_DIR || raw.videoDir);
  const videoPath = path.join(videoDir, entry.video);
  if (!fs.existsSync(videoPath)) throw new Error(`video mancante: ${videoPath}`);
  const videoSize = fs.statSync(videoPath).size;

  const videoServer = await startStaticServer(videoDir);
  const dev = await startDevServer(WEB_ROOT, '[diag]', '/bench');
  log(`dev server: ${dev.baseUrl}`);
  const browser = await chromium.launch({
    headless: true,
    executablePath: pinnedChromeExecutable(),
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu'],
  });
  let sawCpuDelegate = false;
  try {
    const page = await browser.newPage();
    page.on('console', (m) => {
      const text = m.text();
      if (/XNNPACK delegate for CPU/i.test(text)) sawCpuDelegate = true;
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
    await page.goto(`${dev.baseUrl}/bench`, { waitUntil: 'load' });
    await page.waitForFunction(() => (window as { __benchReady?: boolean }).__benchReady === true, null, { timeout: 30000 });
    const videoUrl = `http://127.0.0.1:${videoServer.port}/${encodeURIComponent(entry.video)}`;
    log(`analisi ${caseId} …`);
    const started = Date.now();
    page.setDefaultTimeout(0);
    const data = await page.evaluate(pageDiag, { baseUrl: dev.baseUrl, videoUrl });
    log(`fatto in ${Math.round((Date.now() - started) / 1000)}s`);
    const rec = data.reconstruction as { facelets: never; completeFacelets: never; status: string; cellConfidence: never };
    const score = scoreReconstruction({
      facelets: rec.facelets, completeFacelets: rec.completeFacelets ?? null, status: rec.status,
      scramble: entry.scramble, cellConfidence: rec.cellConfidence,
    });
    const report = {
      meta: {
        caseId, videoFile: entry.video, videoSize, platform: `${process.platform}-${process.arch}`,
        osRelease: os.release(), cpu: os.cpus()[0]?.model, node: process.version, chrome: CHROME_BUILD_ID,
        sawCpuDelegate, createdAt: new Date().toISOString(),
      },
      score: { correct: score.correct, status: score.status },
      ...data,
    };
    const out = outArg ?? path.join(HERE, 'results', `diag-${caseId}-${process.platform}.json`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(report, null, 1));
    log(`punteggio: ${score.correct}/54 · ${score.status}`);
    log(`salvato: ${out}`);
  } finally {
    await browser.close();
    await dev.close();
    videoServer.close();
  }
}

// ---------------------------------------------------------------- compare mode
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const near = (a: unknown, b: unknown, tol = 1e-6): boolean => {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
  return JSON.stringify(a) === JSON.stringify(b);
};
function firstDiff(a: unknown, b: unknown, at = ''): string | null {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${at}.length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i += 1) { const d = firstDiff(a[i], b[i], `${at}[${i}]`); if (d) return d; }
    return null;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const k of keys) { const d = firstDiff((a as Json)[k], (b as Json)[k], `${at}.${k}`); if (d) return d; }
    return null;
  }
  return near(a, b) ? null : `${at}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
}

function compare(fileA: string, fileB: string) {
  const A: Json = JSON.parse(fs.readFileSync(fileA, 'utf8'));
  const B: Json = JSON.parse(fs.readFileSync(fileB, 'utf8'));
  const line = (label: string, d: string | null) => console.log(`${d ? '✗' : '✓'} ${label}${d ? `  → ${d}` : ''}`);
  console.log(`A: ${A.meta.platform} (${A.score.correct}/54)   B: ${B.meta.platform} (${B.score.correct}/54)`);
  line('video (dimensione file)', firstDiff(A.meta.videoSize, B.meta.videoSize));
  line('video (w/h/durata)', firstDiff(A.videoInfo, B.videoInfo));
  for (const k of ['canvasDownscaleHash', 'ortSyntheticOutputHash', 'ortSyntheticHead', 'ortSimd']) {
    line(`sonda ${k}`, firstDiff(A.probes[k], B.probes[k]));
  }
  line('moto: tempi dei campioni', firstDiff(A.motion.samples.map((s: Json) => s.time), B.motion.samples.map((s: Json) => s.time)));
  line('moto: difference/cubeDifference', firstDiff(
    A.motion.samples.map((s: Json) => [s.difference, s.cubeDifference]), B.motion.samples.map((s: Json) => [s.difference, s.cubeDifference]),
  ));
  line('moto: mani', firstDiff(A.motion.samples.map((s: Json) => [s.handMotion, s.handCount]), B.motion.samples.map((s: Json) => [s.handMotion, s.handCount])));
  line('moto: eventi', firstDiff(A.motion.events, B.motion.events));
  line('segmentazione', firstDiff(A.segmentation, B.segmentation));
  for (const k of ['intervalStart', 'searchEnd', 'segmentationHint', 'boundary', 'intervalEnd', 'boundaryScanTimes', 'fusionTimes', 'statusAfterBoundary', 'runCount']) {
    line(`finestra ${k}`, firstDiff(A.window[k], B.window[k]));
  }

  // per fotogramma, solo sui tempi comuni
  const byTime = (frames: Json[]) => new Map(frames.map((f) => [f.time.toFixed(4), f]));
  const fa = byTime(A.frames); const fb = byTime(B.frames);
  const common = [...fa.keys()].filter((t) => fb.has(t));
  console.log(`fotogrammi: A ${fa.size}, B ${fb.size}, comuni ${common.length}`);
  const firstFrameDiff = (label: string, pick: (f: Json) => unknown) => {
    const bad = common.filter((t) => firstDiff(pick(fa.get(t)!), pick(fb.get(t)!)));
    line(`${label} (${common.length - bad.length}/${common.length} uguali)`, bad.length
      ? `primo t=${bad[0]}: ${firstDiff(pick(fa.get(bad[0])!), pick(fb.get(bad[0])!))}` : null);
  };
  firstFrameDiff('currentTime dopo seek', (f) => f.currentTimeAfterSeek);
  firstFrameDiff('pixel nativi (hash)', (f) => f.nativeHash);
  firstFrameDiff('canvas modello 960 (hash)', (f) => f.modelCanvasHash);
  firstFrameDiff('letterbox 512 (hash)', (f) => f.letterboxHash);
  firstFrameDiff('ritagli analisi (hash)', (f) => f.cropHashes);
  firstFrameDiff('output ONNX grezzo (hash)', (f) => f.rawOutput?.hash);
  firstFrameDiff('rilevamenti: numero', (f) => f.detections.length);
  firstFrameDiff('rilevamenti: score+vertici', (f) => f.detections);
  const maxDelta = common.reduce((m, t) => {
    const da = fa.get(t)!.detections; const db = fb.get(t)!.detections;
    if (da.length !== db.length) return m;
    da.forEach((d: Json, i: number) => d.keypoints.forEach((p: number[], j: number) => {
      const q = db[i].keypoints[j]; m.px = Math.max(m.px, Math.hypot(p[0] - q[0], p[1] - q[1]));
    }));
    da.forEach((d: Json, i: number) => { m.score = Math.max(m.score, Math.abs(d.score - db[i].score)); });
    return m;
  }, { px: 0, score: 0 });
  console.log(`  scarto max su rilevamenti con stesso numero: vertici ${maxDelta.px.toFixed(3)} px, score ${maxDelta.score.toFixed(5)}`);

  // griglie: chiave = frameId + centro; prima decisione discreta che cambia
  const key = (g: Json) => `${g.frameId}|${g.centerColor}`;
  const ga = new Map(A.grids.map((g: Json) => [key(g), g])); const gb = new Map(B.grids.map((g: Json) => [key(g), g]));
  const onlyA = [...ga.keys()].filter((k) => !gb.has(k)); const onlyB = [...gb.keys()].filter((k) => !ga.has(k));
  console.log(`griglie: A ${ga.size}, B ${gb.size}, solo A ${onlyA.length}, solo B ${onlyB.length}${onlyA[0] ? ` (primo solo-A ${onlyA[0]})` : ''}${onlyB[0] ? ` (primo solo-B ${onlyB[0]})` : ''}`);
  const sharedGrids = [...ga.keys()].filter((k) => gb.has(k)).sort();
  for (const field of ['colors', 'orientationTurns', 'visibleCells', 'confidence', 'cellConfidences', 'gridAlignmentIndex', 'silhouette', 'rawColors']) {
    const bad = sharedGrids.filter((k) => firstDiff((ga.get(k) as Json)[field], (gb.get(k) as Json)[field]));
    line(`griglie.${field} (${sharedGrids.length - bad.length}/${sharedGrids.length} uguali)`, bad.length
      ? `primo ${bad[0]}: ${firstDiff((ga.get(bad[0]) as Json)[field], (gb.get(bad[0]) as Json)[field])}` : null);
  }
  // soglia di allineamento (6): osservazioni che passano da una parte e non dall'altra
  const crossed = sharedGrids.filter((k) => {
    const a = (ga.get(k) as Json).gridAlignmentIndex; const b = (gb.get(k) as Json).gridAlignmentIndex;
    return typeof a === 'number' && typeof b === 'number' && (a >= 6) !== (b >= 6);
  });
  line(`gridAlignmentIndex attraversa la soglia 6 (${crossed.length})`, crossed.length ? crossed.slice(0, 5).join(', ') : null);
  const sel = (r: Json) => r.alignmentFilteredObservations.map((o: Json) => `${o.frameId}|${o.centerColor}`).sort();
  line('osservazioni sopravvissute al filtro', firstDiff(sel(A.reconstruction), sel(B.reconstruction)));
  for (const k of ['gridAlignmentSafeguardColors', 'modelGateAttempts', 'faceObservationDiag', 'stableRawDiag', 'choicesDiag', 'partialDiag', 'candidateStatesCount', 'budgetTelemetry', 'status', 'facelets']) {
    line(`ricostruzione.${k}`, firstDiff(A.reconstruction[k], B.reconstruction[k]));
  }
}

const argv = process.argv.slice(2);
if (argv[0] === '--compare') {
  compare(argv[1], argv[2]);
} else {
  const outIndex = argv.indexOf('--out');
  const out = outIndex >= 0 ? argv[outIndex + 1] : undefined;
  const caseId = argv.find((a, i) => !a.startsWith('--') && (outIndex < 0 || i !== outIndex + 1)) ?? 'IMG_6258';
  run(caseId, out).catch((error) => {
    console.error('[diag] errore:', error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
