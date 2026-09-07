// Driver diagnostico: salva, per un video, un PNG per faccia con la griglia 3x3
// SCELTA dalla pipeline, i 9 punti di campionamento e il colore letto in
// ciascuno, sovrapposti al fotogramma reale. Non tocca la pipeline: usa
// `reconstruction.faceReference`, i `samples` restituiti e
// `mapGridGeometryToVideoSpace`, tutti gia' esposti.
//
//   node --experimental-strip-types bench/debug-grids.ts            # IMG_6107 (default)
//   node --experimental-strip-types bench/debug-grids.ts IMG_6108
//   BENCH_VIDEO_DIR=... node --experimental-strip-types bench/debug-grids.ts
//   BENCH_HEADFUL=1 ...                                             # mostra il browser
//
// Riusa la stessa infrastruttura di run-bench.ts (dev server vinext + server
// statico per i video con Range/CORS + Chrome di sistema via Playwright).
// Output: bench/debug-grids/<n>-<FACE>-<colore>.png  +  bench/debug-grids/index.json

import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, '..');
const OUT_DIR = path.join(HERE, 'debug-grids');

const FACE_ORDER = ['U', 'R', 'F', 'D', 'L', 'B'];
// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;]*[A-Za-z]/g;

type CaseSpec = { id: string; video: string; scramble: string; orientation?: string };

function log(...parts: unknown[]) {
  console.log('[debug-grids]', ...parts);
}

function loadCase(id: string): { videoDir: string; entry: CaseSpec } {
  const raw = JSON.parse(fs.readFileSync(path.join(HERE, 'cases.json'), 'utf8'));
  const videoDir = process.env.BENCH_VIDEO_DIR || raw.videoDir;
  if (!videoDir) throw new Error('videoDir non definito: imposta BENCH_VIDEO_DIR o cases.json > videoDir');
  const entry = (raw.cases as CaseSpec[]).find((c) => c.id === id);
  if (!entry) throw new Error(`caso "${id}" non trovato in cases.json`);
  return { videoDir: path.resolve(videoDir), entry };
}

// --- server statico per i video: Range + CORS (identico a run-bench.ts) ---
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
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { method: 'GET' });
      if (response.ok || response.status === 404) return;
      lastError = `HTTP ${response.status}`;
    } catch (caught) {
      lastError = caught instanceof Error ? caught.message : String(caught);
    }
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
      // vinext colora l'output con vere sequenze ANSI: senza rimuoverle per
      // intero resta il carattere ESC fra "localhost:" e la porta e il match
      // fallisce, lasciando orfano il dev server.
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
    await waitForHttp(`${baseUrl}/bench/debug-grids`, 120000);
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

type FaceGridImage = {
  face: string;
  centerColor: string;
  time: number;
  frameId: string | null;
  gridSource: string | null;
  hasGeometry: boolean;
  hasSilhouette: boolean;
  colorSource: string;
  readColors: Array<string | null>;
  dataUrl: string;
};
type DebugGridsResult = {
  ok: boolean;
  error?: string;
  status?: string;
  observedFaces?: string[];
  interval?: { start: number; end: number };
  videoWidth?: number;
  videoHeight?: number;
  facesWithReference?: number;
  images?: FaceGridImage[];
  durationMs?: number;
};

async function main() {
  const id = process.argv.slice(2).find((arg) => !arg.startsWith('-')) || 'IMG_6107';
  const { videoDir, entry } = loadCase(id);
  const filePath = path.join(videoDir, entry.video);
  if (!fs.existsSync(filePath)) throw new Error(`video mancante: ${filePath} (imposta BENCH_VIDEO_DIR)`);
  log(`caso: ${entry.id} · video: ${filePath}`);

  const videoServer = await startVideoServer(videoDir);
  log(`server video su http://127.0.0.1:${videoServer.port}`);
  const dev = await startDevServer();
  log(`dev server pronto: ${dev.baseUrl}`);

  const headless = !process.env.BENCH_HEADFUL;
  let browser: Browser;
  try {
    browser = await chromium.launch({ headless, channel: process.env.BENCH_CHANNEL || 'chrome' });
    log(`browser: Chrome di sistema (canale "${process.env.BENCH_CHANNEL || 'chrome'}")`);
  } catch (caught) {
    log(`Chrome di sistema non disponibile (${caught instanceof Error ? caught.message.split('\n')[0] : caught}); uso il Chromium di Playwright`);
    browser = await chromium.launch({ headless });
  }

  let result: DebugGridsResult;
  try {
    const page = await browser.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error') log(`console.error: ${message.text()}`);
    });
    await page.goto(`${dev.baseUrl}/bench/debug-grids`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__debugGridsReady === true, null, { timeout: 30000 });
    const videoUrl = `http://127.0.0.1:${videoServer.port}/${encodeURIComponent(entry.video)}`;
    log(`ricostruzione + rendering griglie… (puo' richiedere qualche minuto)`);
    result = await page.evaluate((url) => window.__debugGrids!(url), videoUrl) as DebugGridsResult;
  } finally {
    await browser.close();
    await dev.close();
    videoServer.close();
  }

  if (!result.ok) {
    log(`✗ ${result.error ?? 'esito non valido'}`);
    process.exitCode = 1;
    return;
  }

  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const images = result.images ?? [];
  const manifest = images.map((image) => {
    const order = FACE_ORDER.indexOf(image.face);
    const name = `${order + 1}-${image.face}-${image.centerColor}.png`;
    const base64 = image.dataUrl.replace(/^data:image\/png;base64,/, '');
    fs.writeFileSync(path.join(OUT_DIR, name), Buffer.from(base64, 'base64'));
    return {
      file: name,
      face: image.face,
      centerColor: image.centerColor,
      time: image.time,
      frameId: image.frameId,
      gridSource: image.gridSource,
      colorSource: image.colorSource,
      readColors: image.readColors,
      hasGeometry: image.hasGeometry,
      hasSilhouette: image.hasSilhouette,
    };
  });

  const summary = {
    case: entry.id,
    scramble: entry.scramble,
    status: result.status,
    observedFaces: result.observedFaces,
    facesWithReference: result.facesWithReference,
    interval: result.interval,
    videoSize: [result.videoWidth, result.videoHeight],
    durationMs: result.durationMs,
    images: manifest,
    missingFaces: FACE_ORDER.filter((face) => !images.some((image) => image.face === face)),
    legend: {
      cyan: 'contorno della griglia 3x3 scelta',
      magenta: '9 punti di campionamento (+ intorno mediato per il colore)',
      swatch: 'colore letto dall’algoritmo in quel punto (etichetta accanto al punto)',
      yellow: 'cella centrale (il suo colore diventa il centro faccia)',
      orange: 'silhouette esagonale (solo se la griglia viene dalla silhouette)',
      colorSource: '"osservazione" = colori del frame scelto · "facelet-fuso" = stato ricostruito (ripiego)',
    },
  };
  fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify(summary, null, 2));

  console.log('\n' + '='.repeat(72));
  log(`stato ricostruzione: ${result.status} · facce osservate ${result.observedFaces?.length ?? 0}/6`);
  log(`intervallo ispezione: ${result.interval?.start.toFixed(2)}–${result.interval?.end.toFixed(2)}s`);
  manifest.forEach((image) => {
    log(`  ${image.file}  ·  ${image.gridSource ?? 'n/d'}  ·  t=${image.time.toFixed(3)}s  ·  colori:${image.colorSource}  ·  ${image.frameId ?? 'frameId?'}${image.hasGeometry ? '' : '  (GEOMETRIA MANCANTE)'}`);
    log(`      letti: [${image.readColors.map((c) => c ?? '·').join(' ')}]`);
  });
  if (summary.missingFaces.length) log(`facce senza griglia scelta: ${summary.missingFaces.join(', ')}`);
  log(`salvate ${manifest.length} immagini in ${path.relative(WEB_ROOT, OUT_DIR)}/`);
  console.log('='.repeat(72));
}

main().catch((error) => {
  console.error('\n[debug-grids] errore fatale:', error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
