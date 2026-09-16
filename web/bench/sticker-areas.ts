// Driver diagnostico: misura SOLO la distribuzione di area e aspect-ratio
// delle componenti connesse del flood-fill colore, su un campione di
// fotogrammi (non tutto il video) — per stimare se in un caso c'e' sticker
// merging (blob che fondono piu' sticker adiacenti dello stesso colore).
//
// Non chiama reconstructInspectionFromVideo: niente hand-motion, niente
// MediaPipe, niente CDN. Per questo e' molto piu' veloce e non dipende dalla
// rete (a differenza di bench/debug-grids.ts, che invece esegue la pipeline
// completa).
//
//   node --experimental-strip-types bench/sticker-areas.ts                    # IMG_6107 + IMG_6108, 15 istanti
//   node --experimental-strip-types bench/sticker-areas.ts IMG_6108
//   node --experimental-strip-types bench/sticker-areas.ts IMG_6108 --samples=24
//   BENCH_VIDEO_DIR=... node --experimental-strip-types bench/sticker-areas.ts
//
// Stampa una riga di progresso per ogni fotogramma+ritaglio analizzato (il
// driver inoltra i console.log della pagina) e un riepilogo per caso appena
// e' pronto, senza aspettare gli altri casi. C'e' un timeout complessivo di
// 6 minuti: se scatta, il driver lo dice esplicitamente invece di restare
// muto.

import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, '..');
const RESULTS_DIR = path.join(HERE, 'results');
const OVERALL_TIMEOUT_MS = 6 * 60 * 1000;

// NB: debug-grids.ts/run-bench.ts usano `/\[[0-9;]*[A-Za-z]/g` (senza il byte
// ESC \x1B davanti alla parentesi): rimuove "[1m" ma lascia l'ESC orfano
// esattamente tra "localhost:" e la porta quando vinext colora quel segmento,
// facendo fallire il match dell'URL. Qui lo ESC e' incluso nel pattern.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1B\[[0-9;]*[A-Za-z]/g;

type CaseSpec = { id: string; video: string; scramble: string; orientation?: string };
type CubeColor = 'white' | 'red' | 'green' | 'yellow' | 'orange' | 'blue';

function log(...parts: unknown[]) {
  console.log('[sticker-areas]', ...parts);
}

function loadConfig(): { videoDir: string; cases: CaseSpec[] } {
  const raw = JSON.parse(fs.readFileSync(path.join(HERE, 'cases.json'), 'utf8'));
  const videoDir = process.env.BENCH_VIDEO_DIR || raw.videoDir;
  if (!videoDir) throw new Error('videoDir non definito: imposta BENCH_VIDEO_DIR o cases.json > videoDir');
  return { videoDir: path.resolve(videoDir), cases: raw.cases as CaseSpec[] };
}

// --- server statico per i video: Range + CORS (identico a run-bench.ts / debug-grids.ts) ---
function startVideoServer(dir: string): Promise<{ close: () => void; port: number }> {
  const root = path.resolve(dir);
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '');
    const baseHeaders: Record<string, string | number> = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'range',
      'Accept-Ranges': 'bytes',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, baseHeaders).end();
      return;
    }
    const filePath = path.join(root, name);
    if (!filePath.startsWith(root)) {
      res.writeHead(403, baseHeaders).end('forbidden');
      return;
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      res.writeHead(404, baseHeaders).end('not found');
      return;
    }
    const total = stat.size;
    const headers: Record<string, string | number> = {
      ...baseHeaders,
      'Content-Type': name.endsWith('.mp4') || name.endsWith('.m4v') ? 'video/mp4'
        : name.endsWith('.mov') ? 'video/quicktime'
        : name.endsWith('.webm') ? 'video/webm'
        : 'application/octet-stream',
    };
    const range = req.headers.range;
    let start = 0;
    let end = total - 1;
    let status = 200;
    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(range);
      start = match && match[1] ? parseInt(match[1], 10) : 0;
      end = match && match[2] ? parseInt(match[2], 10) : total - 1;
      if (!Number.isFinite(start) || start < 0) start = 0;
      if (!Number.isFinite(end) || end >= total) end = total - 1;
      if (start > end) {
        res.writeHead(416, { ...headers, 'Content-Range': `bytes */${total}` }).end();
        return;
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
    }
    headers['Content-Length'] = end - start + 1;
    if (req.method === 'HEAD') {
      res.writeHead(status, headers).end();
      return;
    }
    const stream = fs.createReadStream(filePath, { start, end });
    const abort = () => stream.destroy();
    res.on('close', abort);
    stream.on('error', () => {
      res.off('close', abort);
      if (!res.headersSent) res.writeHead(500, baseHeaders);
      res.end();
    });
    res.writeHead(status, headers);
    stream.pipe(res);
  });
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ close: () => server.close(), port });
    });
  });
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    try {
      // Il fetch di Node senza timeout puo' restare appeso indefinitamente su
      // questa macchina (osservato: nessun ritorno, nessun errore, per minuti)
      // pur rispondendo curl in ~25ms sullo stesso URL — per questo ogni
      // tentativo ha un timeout proprio (AbortSignal.timeout), cosi' il ciclo
      // di retry puo' sempre riprovare invece di restare muto.
      const response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(4000) });
      if (response.ok || response.status === 404) return;
      lastError = `HTTP ${response.status}`;
    } catch (caught) {
      lastError = caught instanceof Error ? caught.message : String(caught);
    }
    if (attempt % 5 === 0) log(`  ...ancora in attesa di ${url} (tentativo ${attempt}, ultimo esito: ${lastError})`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`server non raggiungibile a ${url} entro ${timeoutMs}ms (${lastError})`);
}

function startDevServer(): Promise<{ close: () => Promise<void>; baseUrl: string }> {
  const command = process.env.BENCH_SERVER_CMD || 'pnpm exec vinext dev';
  log(`avvio dev server: ${command}`);
  const child: ChildProcess = spawn(command, {
    cwd: WEB_ROOT,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, BROWSER: 'none' },
  });
  let resolved = false;
  const portPromise = new Promise<string>((resolve, reject) => {
    const onData = (buffer: Buffer) => {
      const text = buffer.toString();
      process.stdout.write(text.replace(/^/gm, '  | '));
      const plain = text.replace(ANSI, '');
      const match = /https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/.exec(plain)
        ?? /(?:localhost|127\.0\.0\.1):(\d+)/.exec(plain);
      if (match && !resolved) {
        resolved = true;
        resolve(`http://localhost:${match[1]}`);
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('exit', (code) => {
      if (!resolved) reject(new Error(`il dev server e' uscito prima di essere pronto (codice ${code})`));
    });
    setTimeout(() => {
      if (!resolved) reject(new Error('nessun URL localhost dal dev server entro 180s'));
    }, 180000);
  });
  return portPromise.then(async (baseUrl) => {
    await waitForHttp(`${baseUrl}/bench/sticker-areas`, 120000);
    return {
      baseUrl,
      close: () => new Promise<void>((resolve) => {
        child.on('exit', () => resolve());
        if (process.platform === 'win32' && child.pid) {
          spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { stdio: 'ignore' });
        } else {
          child.kill('SIGTERM');
        }
        setTimeout(resolve, 5000);
      }),
    };
  });
}

type ComponentSample = {
  time: number;
  crop: number;
  color: CubeColor;
  area: number;
  width: number;
  height: number;
  aspect: number;
};

type StickerAreasResult = {
  ok: boolean;
  error?: string;
  videoWidth?: number;
  videoHeight?: number;
  duration?: number;
  totalFrames?: number;
  components?: ComponentSample[];
  durationMs?: number;
};

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function asciiHistogram(values: number[], bins: number, label: string): string {
  if (!values.length) return `  (nessun valore per ${label})`;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(1e-6, max - min);
  const counts = new Array(bins).fill(0);
  values.forEach((v) => {
    const bin = Math.min(bins - 1, Math.floor(((v - min) / span) * bins));
    counts[bin] += 1;
  });
  const maxCount = Math.max(...counts);
  const lines = counts.map((count, i) => {
    const lo = min + (span * i) / bins;
    const hi = min + (span * (i + 1)) / bins;
    const bar = '#'.repeat(Math.round((count / Math.max(1, maxCount)) * 40));
    return `  ${lo.toFixed(0).padStart(6)}-${hi.toFixed(0).padEnd(6)} | ${bar} ${count}`;
  });
  return lines.join('\n');
}

function summarizeCase(caseId: string, result: StickerAreasResult) {
  const components = result.components ?? [];
  console.log('\n' + '='.repeat(72));
  log(`${caseId} · ${components.length} componenti trovate su ${result.totalFrames} fotogrammi analizzati (${((result.durationMs ?? 0) / 1000).toFixed(1)}s)`);
  if (!components.length) {
    log('  nessuna componente passa i filtri di forma — nulla da misurare');
    return;
  }

  const areas = components.map((c) => c.area);
  const nearSquare = components.filter((c) => c.aspect >= 0.82 && c.aspect <= 1.22);
  const unitArea = median(nearSquare.map((c) => c.area)) || median(areas);
  log(`  area mediana (tutte): ${median(areas).toFixed(0)}px²  ·  area unitaria (proxy: mediana dei quasi-quadrati, n=${nearSquare.length}): ${unitArea.toFixed(0)}px²`);

  console.log('  istogramma aree (px²):');
  console.log(asciiHistogram(areas, 16, 'area'));

  const ratioBuckets: Record<string, number> = { '<0.5x': 0, '0.5-1.5x': 0, '1.5-2.5x': 0, '2.5-3.5x': 0, '3.5-4.5x': 0, '>4.5x': 0 };
  components.forEach((c) => {
    const ratio = unitArea > 0 ? c.area / unitArea : 0;
    if (ratio < 0.5) ratioBuckets['<0.5x'] += 1;
    else if (ratio < 1.5) ratioBuckets['0.5-1.5x'] += 1;
    else if (ratio < 2.5) ratioBuckets['1.5-2.5x'] += 1;
    else if (ratio < 3.5) ratioBuckets['2.5-3.5x'] += 1;
    else if (ratio < 4.5) ratioBuckets['3.5-4.5x'] += 1;
    else ratioBuckets['>4.5x'] += 1;
  });
  log('  componenti per multiplo dell\'area unitaria (picchi a 2x/3x = indizio di merging):');
  Object.entries(ratioBuckets).forEach(([bucket, count]) => log(`    ${bucket.padEnd(10)} ${count}`));

  const nearOneToOne = components.filter((c) => c.aspect >= 0.8 && c.aspect <= 1.25).length;
  const nearTwoToOne = components.filter((c) => (c.aspect >= 1.7 && c.aspect <= 2.4) || (c.aspect >= 1 / 2.4 && c.aspect <= 1 / 1.7)).length;
  const other = components.length - nearOneToOne - nearTwoToOne;
  log(`  aspect ratio: ~1:1 → ${nearOneToOne}  ·  ~2:1 o 1:2 (due sticker fusi affiancati) → ${nearTwoToOne}  ·  altro → ${other}`);

  // stesso identico campione di istanti, solo il ritaglio cambia: se il conteggio
  // cala e l'area sale col ritaglio piu' stretto (crop 0 = piu' vicino), e' un
  // indizio diretto di merging legato all'inquadratura ravvicinata.
  log('  per ritaglio (0=più stretto/vicino … 2=intero fotogramma):');
  for (let crop = 0; crop <= 2; crop += 1) {
    const subset = components.filter((c) => c.crop === crop);
    if (!subset.length) { log(`    crop ${crop}: 0 componenti`); continue; }
    log(`    crop ${crop}: n=${subset.length}  area mediana=${median(subset.map((c) => c.area)).toFixed(0)}px²`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const requestedIds = args.filter((a) => !a.startsWith('--'));
  const samplesArg = args.find((a) => a.startsWith('--samples='));
  const sampleCount = samplesArg ? Math.max(4, Math.min(40, Number(samplesArg.split('=')[1]))) : 15;

  const { videoDir, cases } = loadConfig();
  const selected = requestedIds.length ? cases.filter((c) => requestedIds.includes(c.id)) : cases;
  if (!selected.length) throw new Error(`nessun caso trovato per: ${requestedIds.join(', ')}`);

  const CROPS_PER_FRAME = 3;
  const totalFramesAll = selected.length * sampleCount * CROPS_PER_FRAME;
  const estimateSeconds = 30 /* avvio dev server */ + totalFramesAll * 0.6 /* stima per fotogramma+ritaglio, seek incluso */;
  log(`casi: ${selected.map((c) => c.id).join(', ')} · ${sampleCount} istanti/caso × ${CROPS_PER_FRAME} ritagli = ${totalFramesAll} fotogrammi totali`);
  log(`stima: ~${Math.round(estimateSeconds)}s (${(estimateSeconds / 60).toFixed(1)} min) — timeout complessivo fissato a ${OVERALL_TIMEOUT_MS / 60000} min`);

  const overallDeadline = Date.now() + OVERALL_TIMEOUT_MS;
  const timedOut = { flag: false };
  const overallTimer = setTimeout(() => {
    timedOut.flag = true;
    log('✗ TIMEOUT COMPLESSIVO RAGGIUNTO — interrompo e chiudo tutto (nessun risultato silenzioso).');
    process.exitCode = 1;
  }, OVERALL_TIMEOUT_MS);

  const videoServer = await startVideoServer(videoDir);
  log(`server video su http://127.0.0.1:${videoServer.port}`);
  const dev = await startDevServer();
  log(`dev server pronto: ${dev.baseUrl} (${Math.round((OVERALL_TIMEOUT_MS - (overallDeadline - Date.now())) / 1000)}s trascorsi)`);

  const headless = !process.env.BENCH_HEADFUL;
  let browser: Browser;
  try {
    browser = await chromium.launch({ headless, channel: process.env.BENCH_CHANNEL || 'chrome' });
    log(`browser: Chrome di sistema (canale "${process.env.BENCH_CHANNEL || 'chrome'}")`);
  } catch (caught) {
    log(`Chrome di sistema non disponibile (${caught instanceof Error ? caught.message.split('\n')[0] : caught}); uso il Chromium di Playwright`);
    browser = await chromium.launch({ headless });
  }

  const allResults: Record<string, StickerAreasResult> = {};
  try {
    const page = await browser.newPage();
    page.on('console', (message) => {
      const text = message.text();
      if (text.startsWith('[sticker-areas]')) console.log(`  | ${text}`);
      else if (message.type() === 'error') log(`console.error: ${text}`);
    });
    await page.goto(`${dev.baseUrl}/bench/sticker-areas`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__stickerAreasReady === true, null, { timeout: 30000 });

    for (const entry of selected) {
      if (timedOut.flag) break;
      const filePath = path.join(videoDir, entry.video);
      if (!fs.existsSync(filePath)) {
        log(`✗ ${entry.id}: video mancante (${filePath}), salto`);
        continue;
      }
      const videoUrl = `http://127.0.0.1:${videoServer.port}/${encodeURIComponent(entry.video)}`;
      log(`--- ${entry.id}: avvio misura (${sampleCount} istanti, video: ${entry.video}) ---`);

      // finestra di campionamento: stessa euristica della finestra di ispezione
      // reale (~1-20s), niente decodifica dell'intero video.
      const times = Array.from({ length: sampleCount }, (_, i) => 1 + (19 * i) / Math.max(1, sampleCount - 1));

      const result = await page.evaluate(
        ({ url, times: t }) => window.__stickerAreas!(url, t),
        { url: videoUrl, times },
      ) as StickerAreasResult;
      allResults[entry.id] = result;
      if (!result.ok) {
        log(`✗ ${entry.id}: ${result.error ?? 'esito non valido'}`);
        continue;
      }
      summarizeCase(entry.id, result);
    }
  } finally {
    clearTimeout(overallTimer);
    await browser.close();
    await dev.close();
    videoServer.close();
  }

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(RESULTS_DIR, `sticker-areas-${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ sampleCount, cases: allResults }, null, 2));
  console.log('\n' + '='.repeat(72));
  log(`dati grezzi salvati in ${path.relative(WEB_ROOT, outPath)}`);
}

main().catch((error) => {
  console.error('\n[sticker-areas] errore fatale:', error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
