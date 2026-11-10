// MediaPipe e' servito dall'app stessa (web/public/mediapipe/), non da CDN:
// niente deriva del runtime o del modello nel tempo e nessuna risorsa esterna.
// Questo modulo verifica i file e riconosce le richieste del browser.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MEDIAPIPE_DIR = path.resolve(HERE, '..', '..', 'public', 'mediapipe');

// hand_landmarker float16 rev. 1 (vedi docs/mediapipe-vendor.md).
export const MEDIAPIPE_TASK_SHA256 = 'fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1';

// Solo i file che `FilesetResolver.forVisionTasks(root)` di tasks-vision 1.0.1
// carica davvero (versione SIMD e non SIMD, senza `useModule`), piu' il modello.
export const MEDIAPIPE_REQUIRED_FILES = [
  'hand_landmarker.task',
  'wasm/vision_wasm_internal.js',
  'wasm/vision_wasm_internal.wasm',
  'wasm/vision_wasm_nosimd_internal.js',
  'wasm/vision_wasm_nosimd_internal.wasm',
];

export function mediapipeIntegrityIssues(
  dir: string = MEDIAPIPE_DIR,
  expectedTaskSha256: string = MEDIAPIPE_TASK_SHA256,
): string[] {
  const issues: string[] = [];
  for (const rel of MEDIAPIPE_REQUIRED_FILES) {
    if (!fs.existsSync(path.join(dir, rel))) issues.push(`file MediaPipe mancante: ${rel}`);
  }
  const task = path.join(dir, 'hand_landmarker.task');
  if (fs.existsSync(task)) {
    const actual = crypto.createHash('sha256').update(fs.readFileSync(task)).digest('hex');
    if (actual !== expectedTaskSha256) {
      issues.push(`hand_landmarker.task: SHA-256 ${actual} diverso da quello fissato ${expectedTaskSha256}`);
    }
  }
  return issues;
}

export function classifyMediapipeRequest(url: string): 'model' | 'wasm' | 'other' {
  const pathname = new URL(url).pathname;
  if (pathname.endsWith('/mediapipe/hand_landmarker.task')) return 'model';
  if (/\/mediapipe\/wasm\/[^/]+\.(wasm|js)$/.test(pathname)) return 'wasm';
  return 'other';
}

export function isMediapipeCdn(url: string): boolean {
  const host = new URL(url).hostname;
  return host === 'cdn.jsdelivr.net' || host === 'storage.googleapis.com';
}

/** Segue le richieste di una pagina: contatori delle risposte 200 e CDN esterni contattati. */
export function watchMediapipeRequests(page: Page): { counts: { model: number; wasm: number }; cdnRequests: string[] } {
  const state = { counts: { model: 0, wasm: 0 }, cdnRequests: [] as string[] };
  page.on('request', (request) => {
    if (isMediapipeCdn(request.url())) state.cdnRequests.push(request.url());
  });
  page.on('response', (response) => {
    if (response.status() !== 200) return;
    const kind = classifyMediapipeRequest(response.url());
    if (kind !== 'other') state.counts[kind] += 1;
  });
  return state;
}
