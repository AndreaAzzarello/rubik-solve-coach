// Driver del banco di prova.
//
//   pnpm bench                    # tutti i casi in cases.json
//   pnpm bench IMG_6107           # solo un caso
//   BENCH_VIDEO_DIR=... pnpm bench
//   BENCH_HEADFUL=1 pnpm bench    # mostra il browser
//
// Passi: avvia il dev server dell'app -> avvia un server statico locale per i
// video (con Range + CORS) -> apre Chromium (Playwright) su /bench -> per ogni
// caso chiama window.__benchReconstruct(url) -> passa lo schema a
// scoreReconstruction -> stampa e salva il report.
//
// Il numero di riferimento e' "caselle giuste su 54" con allineamento identita'
// (non ottimistico). Vedi bench/lib/score.ts.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { startStaticServer } from './lib/static-server.ts';
import { startDevServer } from './lib/dev-server.ts';
import {
  scoreReconstruction,
  formatScoreReport,
  type ReconstructionScore,
} from './lib/score.ts';
import { pinnedChromeExecutable, CHROME_BUILD_ID } from './chrome-path.ts';
import type { CubeColor, Face } from '../lib/cube.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, '..');
const RESULTS_DIR = path.join(HERE, 'results');

// MediaPipe servito in locale dai file vendorizzati (bench/vendor/mediapipe):
// niente CDN esterni, niente deriva del modello o del runtime nel tempo.
const VENDOR_DIR = path.join(HERE, 'vendor', 'mediapipe');
const VENDOR_WASM_DIR = path.join(VENDOR_DIR, 'wasm');
const MEDIAPIPE_WASM_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm/';
const MEDIAPIPE_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

type CaseSpec = {
  id: string;
  video: string;
  scramble: string;
  orientation?: string;
};

type BenchConfig = {
  videoDir: string;
  repeats: number;
  cases: CaseSpec[];
};

type HarnessResult = {
  ok: boolean;
  status?: string;
  message?: string;
  confidence?: number;
  observedFaces?: Face[];
  facelets?: Record<Face, Array<CubeColor | null>>;
  completeFacelets?: Record<Face, CubeColor[]> | null;
  cellConfidence?: Record<Face, number[]>;
  interval?: { start: number; end: number };
  runCount?: number;
  durationMs?: number;
  error?: string;
};

function log(...parts: unknown[]) {
  console.log('[bench]', ...parts);
}

function loadConfig(): BenchConfig {
  const raw = JSON.parse(fs.readFileSync(path.join(HERE, 'cases.json'), 'utf8'));
  const videoDir = process.env.BENCH_VIDEO_DIR || raw.videoDir;
  if (!videoDir) throw new Error('videoDir non definito: imposta BENCH_VIDEO_DIR o cases.json > videoDir');
  return {
    videoDir: path.resolve(videoDir),
    repeats: Math.max(1, Number(process.env.BENCH_REPEATS || raw.repeats || 1)),
    cases: raw.cases as CaseSpec[],
  };
}

// Server statico per i video (Range + CORS): vedi bench/lib/static-server.ts.
// Bootstrap del dev server: vedi bench/lib/dev-server.ts (entrambi estratti
// da qui perche' ora li riusa anche vision/eval e vision/annotate.

const median = (values: number[]): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

async function main() {
  const config = loadConfig();
  const only = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
  const cases = only.length ? config.cases.filter((entry) => only.includes(entry.id)) : config.cases;
  if (!cases.length) throw new Error(`nessun caso da eseguire (filtro: ${only.join(', ') || 'nessuno'})`);

  for (const entry of cases) {
    const filePath = path.join(config.videoDir, entry.video);
    if (!fs.existsSync(filePath)) {
      throw new Error(`video mancante: ${filePath} (imposta BENCH_VIDEO_DIR)`);
    }
  }
  log(`cartella video: ${config.videoDir}`);
  log(`casi: ${cases.map((entry) => entry.id).join(', ')} · ripetizioni: ${config.repeats}`);

  const videoServer = await startStaticServer(config.videoDir);
  log(`server video su http://127.0.0.1:${videoServer.port}`);

  const dev = await startDevServer(WEB_ROOT, '[bench]', '/bench');
  log(`dev server pronto: ${dev.baseUrl}`);

  // Il Chromium di Playwright non ha i codec proprietari (H.264/AAC): per
// decodificare gli .mp4 usiamo il Chrome di sistema. Fallback al bundle se
// manca (con .webm/VP9 funziona lo stesso).
  const headless = !process.env.BENCH_HEADFUL;
  // Chrome for Testing pinnato: ha i codec proprietari per gli .mp4 e non si
  // aggiorna da solo. GL forzato su SwiftShader: i calculator GL di MediaPipe
  // non devono dipendere dalla GPU della macchina. Senza GPU reale il delegate
  // TFLite ricade su CPU/XNNPACK, che viene verificato a fine run.
  const chromeExecutable = pinnedChromeExecutable();
  const glArgs = [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-gpu',
  ];
  const browser: Browser = await chromium.launch({
    headless,
    executablePath: chromeExecutable,
    args: glArgs,
  });
  log(`browser: Chrome for Testing ${CHROME_BUILD_ID} (pinnato) · GL SwiftShader`);

  // Sentinelle di determinismo, verificate dopo il run.
  let sawCpuDelegate = false;
  let sawGpuDelegate = false;
  let vendorWasmHits = 0;
  let vendorModelHits = 0;
  const startedAt = new Date();
  const report: {
    startedAt: string;
    videoDir: string;
    cases: Array<{
      id: string;
      scramble: string;
      repeats: number;
      headline: number[];
      status: string[];
      representative: ReconstructionScore | null;
      // schema ricostruito della ripetizione rappresentativa, per debug dei cali
      reconstructed: {
        facelets?: Record<Face, Array<CubeColor | null>>;
        completeFacelets?: Record<Face, CubeColor[]> | null;
        cellConfidence?: Record<Face, number[]>;
      } | null;
      errors: string[];
    }>;
  } = { startedAt: startedAt.toISOString(), videoDir: config.videoDir, cases: [] };

  try {
    const page = await browser.newPage();
    page.on('console', (message) => {
      const text = message.text();
      if (/XNNPACK delegate for CPU/i.test(text)) sawCpuDelegate = true;
      if (/delegate for GPU|GPU delegate/i.test(text)) sawGpuDelegate = true;
      if (message.type() === 'error') log(`console.error: ${text}`);
    });

    // MediaPipe (runtime WASM + modello mani) servito dai file vendorizzati.
    await page.route(`${MEDIAPIPE_WASM_CDN}**`, async (route) => {
      const rel = route.request().url().slice(MEDIAPIPE_WASM_CDN.length).split(/[?#]/)[0];
      const abs = path.join(VENDOR_WASM_DIR, rel);
      if (!abs.startsWith(VENDOR_WASM_DIR) || !fs.existsSync(abs)) {
        await route.fulfill({ status: 404, body: `non vendorizzato: ${rel}` });
        return;
      }
      vendorWasmHits += 1;
      const type = rel.endsWith('.wasm') ? 'application/wasm'
        : rel.endsWith('.js') ? 'text/javascript'
        : 'application/octet-stream';
      await route.fulfill({
        status: 200,
        headers: { 'content-type': type, 'access-control-allow-origin': '*' },
        body: fs.readFileSync(abs),
      });
    });
    await page.route(MEDIAPIPE_MODEL_URL, async (route) => {
      vendorModelHits += 1;
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/octet-stream', 'access-control-allow-origin': '*' },
        body: fs.readFileSync(path.join(VENDOR_DIR, 'hand_landmarker.task')),
      });
    });

    await page.goto(`${dev.baseUrl}/bench`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__benchReady === true, null, { timeout: 30000 });

    for (const entry of cases) {
      const videoUrl = `http://127.0.0.1:${videoServer.port}/${encodeURIComponent(entry.video)}`;
      const scores: ReconstructionScore[] = [];
      const harnessResults: HarnessResult[] = [];
      const headline: number[] = [];
      const statuses: string[] = [];
      const errors: string[] = [];

      for (let repeat = 1; repeat <= config.repeats; repeat += 1) {
        log(`${entry.id} · ripetizione ${repeat}/${config.repeats} …`);
        const result: HarnessResult = await page.evaluate(
          (url) => window.__benchReconstruct!(url),
          videoUrl,
        );
        if (!result.ok || !result.facelets) {
          errors.push(result.error || 'esito non valido dalla harness');
          log(`  ✗ ${result.error || 'errore'}`);
          continue;
        }
        const score = scoreReconstruction({
          facelets: result.facelets,
          completeFacelets: result.completeFacelets ?? null,
          status: result.status,
          scramble: entry.scramble,
          cellConfidence: result.cellConfidence,
        });
        scores.push(score);
        harnessResults.push(result);
        headline.push(score.correct);
        statuses.push(score.status);
        log(`  → ${score.correct}/54 giuste · stato ${score.status} · ${result.durationMs}ms`);
      }

      const medianCorrect = median(headline);
      let representativeIndex = -1;
      scores.forEach((score, index) => {
        if (
          representativeIndex < 0
          || Math.abs(score.correct - medianCorrect) < Math.abs(scores[representativeIndex].correct - medianCorrect)
        ) {
          representativeIndex = index;
        }
      });
      const representative = representativeIndex >= 0 ? scores[representativeIndex] : null;
      const representativeResult = representativeIndex >= 0 ? harnessResults[representativeIndex] : null;

      report.cases.push({
        id: entry.id,
        scramble: entry.scramble,
        repeats: config.repeats,
        headline,
        status: statuses,
        representative,
        reconstructed: representativeResult
          ? {
            facelets: representativeResult.facelets,
            completeFacelets: representativeResult.completeFacelets ?? null,
            cellConfidence: representativeResult.cellConfidence,
          }
          : null,
        errors,
      });
    }
  } finally {
    await browser.close();
    await dev.close();
    videoServer.close();
  }

  // --- stampa ---
  console.log('\n' + '='.repeat(72));
  for (const caseReport of report.cases) {
    console.log('');
    if (caseReport.errors.length && !caseReport.representative) {
      console.log(`# ${caseReport.id}  ·  FALLITO`);
      caseReport.errors.forEach((error) => console.log(`  ${error}`));
      continue;
    }
    if (caseReport.representative) {
      console.log(formatScoreReport(caseReport.id, caseReport.representative));
      console.log('');
      console.log(`  ripetizioni (giuste/54): ${caseReport.headline.join(', ')}   mediana ${median(caseReport.headline)}`);
      if (caseReport.errors.length) {
        console.log(`  ripetizioni fallite: ${caseReport.errors.length} (${caseReport.errors.join('; ')})`);
      }
    }
  }
  console.log('\n' + '='.repeat(72));

  // --- salvataggio ---
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(RESULTS_DIR, `${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(RESULTS_DIR, 'latest.json'), JSON.stringify(report, null, 2));
  log(`report salvato: ${path.relative(WEB_ROOT, outPath)}`);

  // --- sentinelle di determinismo ---
  const determinismIssues: string[] = [];
  if (vendorWasmHits === 0) {
    determinismIssues.push('runtime WASM MediaPipe NON servito dai file vendorizzati (starebbe scaricando dal CDN)');
  }
  if (vendorModelHits === 0) {
    determinismIssues.push('modello mani MediaPipe NON servito dai file vendorizzati (starebbe scaricando da googleapis)');
  }
  if (!sawCpuDelegate) {
    determinismIssues.push('atteso il delegate TFLite "XNNPACK for CPU": non rilevato nei log del browser');
  }
  if (sawGpuDelegate) {
    determinismIssues.push('rilevato un delegate GPU: il risultato dipenderebbe dalla GPU della macchina');
  }
  if (determinismIssues.length) {
    console.log('\n[bench] ⚠ DETERMINISMO NON GARANTITO:');
    for (const issue of determinismIssues) console.log(`  - ${issue}`);
    console.log('  Il numero qui sopra NON e\' un baseline affidabile.');
    process.exitCode = 1;
  } else {
    log('determinismo: WASM+modello locali · delegate CPU/XNNPACK · GL SwiftShader ✓');
  }

  const anyRun = report.cases.some((entry) => entry.representative);
  if (!anyRun) process.exitCode = 1;
}

main().catch((error) => {
  console.error('\n[bench] errore fatale:', error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
