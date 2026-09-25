// Server dello strumento di annotazione: file statici (pagina + fotogrammi)
// + API JSON per la pre-annotazione SAM e il salvataggio. Va aperto in un
// browser VERO (non Playwright): qui l'utente disegna/trascina con il mouse.
//
//   node --experimental-strip-types vision/annotate/server.ts
//   poi apri http://localhost:5175

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { pinnedChromeExecutable } from '../../bench/chrome-path.ts';
import { toYoloLines, type AnnotatedFace } from '../dataset/annotation.ts';
import { SamAnnotator } from './sam.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRAMES_DIR = path.join(HERE, 'frames');
const LABELS_DIR = path.join(HERE, 'labels');
const PUBLIC_DIR = path.join(HERE, 'public');
const ENCODER_PATH = path.join(HERE, '.cache', 'mobilesam', 'encoder.onnx');
const DECODER_PATH = path.join(HERE, '.cache', 'mobilesam', 'decoder.onnx');
const PORT = Number(process.env.ANNOTATE_PORT || 5175);

type ManifestEntry = { id: string; video: string; time: number; split: 'train' | 'val' };

type SavedFace = { corners: Array<{ x: number; y: number; visibility: 0 | 1 | 2 }> };
type SavePayload = { faces: SavedFace[]; discarded: boolean; width: number; height: number };

fs.mkdirSync(LABELS_DIR, { recursive: true });

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, data: unknown) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
};

function serveStatic(res: http.ServerResponse, filePath: string) {
  if (!fs.existsSync(filePath)) { res.writeHead(404).end('not found'); return; }
  const ext = path.extname(filePath);
  const body = fs.readFileSync(filePath);
  res.writeHead(200, {
    'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
    'content-length': body.length,
    // Necessario per img.crossOrigin='anonymous' nel preprocessing SAM
    // (altrimenti getImageData tainta il canvas e fallisce in silenzio con
    // onerror sull'<img>, non con un errore CORS esplicito - visto dal vivo).
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

// Punto di richiesta automatico: centro del fotogramma. Nei video di
// ispezione il cubo e' quasi sempre inquadrato li'.
//
// Una griglia 3x3 con "tieni lo score piu' alto" e' stata provata e
// scartata: un punto fuori centro puo' segmentare con sicurezza un singolo
// sticker (score locale piu' alto della faccia intera, che e' un oggetto
// piu' grande e quindi "meno ovvio" per il decoder), quindi massimizzare lo
// score su piu' punti sceglieva sistematicamente il sotto-sticker sbagliato
// invece della faccia giusta. Un solo punto, quando sbaglia, sbaglia in modo
// visibile (nessun risultato) invece di sbagliare con sicurezza.
function centerPrompt(width: number, height: number) {
  return { x: width / 2, y: height / 2 };
}

async function imageSize(page: Page, url: string): Promise<{ width: number; height: number }> {
  return page.evaluate(async (imageUrl) => {
    const img = document.createElement('img');
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('errore caricamento'));
      img.src = imageUrl;
    });
    return { width: img.naturalWidth, height: img.naturalHeight };
  }, url);
}

async function main() {
  const manifest: ManifestEntry[] = JSON.parse(fs.readFileSync(path.join(FRAMES_DIR, 'manifest.json'), 'utf8'));

  console.log('avvio Chrome per il preprocessing SAM (invisibile, non e\' quello che usi tu)...');
  const browser: Browser = await chromium.launch({ executablePath: pinnedChromeExecutable(), headless: true });
  const page = await browser.newPage();
  await page.setContent('<!doctype html><html><body></body></html>');

  console.log('carico i modelli MobileSAM...');
  const sam = await SamAnnotator.create(page, ENCODER_PATH, DECODER_PATH);
  console.log('pronto.');

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');

      if (url.pathname === '/' || url.pathname === '/index.html') {
        serveStatic(res, path.join(PUBLIC_DIR, 'index.html'));
        return;
      }
      if (url.pathname === '/app.js') {
        serveStatic(res, path.join(PUBLIC_DIR, 'app.js'));
        return;
      }
      if (url.pathname.startsWith('/frames/')) {
        serveStatic(res, path.join(FRAMES_DIR, path.basename(url.pathname)));
        return;
      }

      const labelMatch = url.pathname.match(/^\/api\/label\/(.+)$/);
      if (labelMatch && req.method === 'GET') {
        const jsonPath = path.join(LABELS_DIR, `${labelMatch[1]}.json`);
        sendJson(res, 200, fs.existsSync(jsonPath) ? JSON.parse(fs.readFileSync(jsonPath, 'utf8')) : null);
        return;
      }

      if (url.pathname === '/api/manifest' && req.method === 'GET') {
        const withProgress = manifest.map((entry) => ({
          ...entry,
          annotated: fs.existsSync(path.join(LABELS_DIR, `${entry.id}.json`)),
        }));
        sendJson(res, 200, withProgress);
        return;
      }

      const autoMatch = url.pathname.match(/^\/api\/auto\/(.+)$/);
      if (autoMatch && req.method === 'POST') {
        const frameId = autoMatch[1];
        const frameUrl = `http://127.0.0.1:${PORT}/frames/${frameId}.jpg`;
        const size = await imageSize(page, frameUrl);
        const MIN_AUTO_SCORE = 0.7;
        const { x, y } = centerPrompt(size.width, size.height);
        const result = await sam.promptPoint(frameUrl, x, y);
        sendJson(res, 200, { ...size, result: result && result.score >= MIN_AUTO_SCORE ? result : null });
        return;
      }

      const promptMatch = url.pathname.match(/^\/api\/prompt\/(.+)$/);
      if (promptMatch && req.method === 'POST') {
        const frameId = promptMatch[1];
        const body = await readJsonBody(req) as { x: number; y: number };
        const frameUrl = `http://127.0.0.1:${PORT}/frames/${frameId}.jpg`;
        const result = await sam.promptPoint(frameUrl, body.x, body.y);
        sendJson(res, 200, { result });
        return;
      }

      const saveMatch = url.pathname.match(/^\/api\/save\/(.+)$/);
      if (saveMatch && req.method === 'POST') {
        const frameId = saveMatch[1];
        const payload = await readJsonBody(req) as SavePayload;
        fs.writeFileSync(path.join(LABELS_DIR, `${frameId}.json`), JSON.stringify(payload, null, 2));
        if (!payload.discarded && payload.faces.length > 0) {
          const annotated: AnnotatedFace[] = payload.faces.map((face) => ({ face: 'U', corners: face.corners }));
          const lines = toYoloLines(annotated, payload.width, payload.height);
          fs.writeFileSync(path.join(LABELS_DIR, `${frameId}.txt`), `${lines.join('\n')}\n`);
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      res.writeHead(404).end('not found');
    } catch (error) {
      console.error(error);
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  server.listen(PORT, () => {
    console.log(`\nApri http://localhost:${PORT} nel TUO browser (non e' automatizzato, ci lavori tu).`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
