// Caricamento condiviso dei fotogrammi di test (split: 'test' in
// annotate/frames/manifest.json, mai entrati in training) e risoluzione del
// path di un modello - identico in tutti gli script di confronto PCK, estratto
// qui per evitare 3 copie della stessa logica (compare-models-pck.ts,
// compare-models-pck-unbiased.ts, compare-two-pass-pck.ts).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYoloPoseLabels, type LabeledFace } from './yolo-label.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, '..', '..');
const ANNOTATE_DIR = path.join(WEB_ROOT, 'vision', 'annotate');
export const FRAMES_DIR = path.join(ANNOTATE_DIR, 'frames');
const LABELS_DIR = path.join(ANNOTATE_DIR, 'labels');
const MODELS_DIR = path.join(WEB_ROOT, 'vision', 'models');

export function resolveModelPath(arg: string): string {
  const resolved = arg.includes('/') || arg.includes('\\') ? path.resolve(arg) : path.join(MODELS_DIR, arg);
  if (!fs.existsSync(resolved)) throw new Error(`modello non trovato: ${resolved}`);
  return resolved;
}

type ManifestEntry = { id: string; video: string; time: number; split: 'train' | 'val' | 'test' };
export type Sample = { id: string; video: string; groundTruth: LabeledFace[] };

export function loadTestSamples(): Sample[] {
  const manifest: ManifestEntry[] = JSON.parse(fs.readFileSync(path.join(FRAMES_DIR, 'manifest.json'), 'utf8'));
  const testIds = new Set(manifest.filter((e) => e.split === 'test').map((e) => e.id));

  const samples: Sample[] = [];
  for (const entry of manifest) {
    if (!testIds.has(entry.id)) continue;
    const txtPath = path.join(LABELS_DIR, `${entry.id}.txt`);
    const jsonPath = path.join(LABELS_DIR, `${entry.id}.json`);
    const imagePath = path.join(FRAMES_DIR, `${entry.id}.jpg`);
    if (!fs.existsSync(txtPath) || !fs.existsSync(jsonPath) || !fs.existsSync(imagePath)) continue;
    const meta = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as { width: number; height: number };
    const groundTruth = parseYoloPoseLabels(fs.readFileSync(txtPath, 'utf8'), meta.width, meta.height);
    samples.push({ id: entry.id, video: entry.video, groundTruth });
  }
  return samples.sort((a, b) => a.id.localeCompare(b.id));
}
