// Esperimento #21: lettura/scrittura su disco delle scansioni strette raccolte.
// Un file per video: bench/results/window-scans/<caseId>.json (gitignored, solo
// numeri: tempi e griglie colore 3x3, nessun fotogramma). Condiviso da
// window-replay.ts (legge) e window-scan.ts (scrive).

import fs from 'node:fs';
import path from 'node:path';
import { scanKey, type ScanEntry, type ScanRequest, type ScanStore } from './window-replay-core.ts';

export interface ScanFile {
  caseId: string;
  meta: Record<string, unknown>;
  scans: Record<string, ScanEntry>;
}

export function scanFilePath(dir: string, caseId: string): string {
  return path.join(dir, `${caseId}.json`);
}

export function loadScanFile(dir: string, caseId: string): ScanFile {
  const file = scanFilePath(dir, caseId);
  if (!fs.existsSync(file)) return { caseId, meta: {}, scans: {} };
  return JSON.parse(fs.readFileSync(file, 'utf8')) as ScanFile;
}

export function toStore(file: ScanFile): ScanStore {
  const store: ScanStore = new Map();
  for (const entry of Object.values(file.scans)) store.set(scanKey(entry.start, entry.end), entry.samples);
  return store;
}

/** Scrittura atomica (file temporaneo + rename): un'interruzione non corrompe la cache. */
export function saveScanFile(dir: string, file: ScanFile): void {
  fs.mkdirSync(dir, { recursive: true });
  const target = scanFilePath(dir, file.caseId);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file));
  fs.renameSync(tmp, target);
}

export interface RequestsFile {
  createdAt: string;
  requests: ScanRequest[];
}

export function writeRequests(file: string, requests: ScanRequest[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body: RequestsFile = { createdAt: new Date().toISOString(), requests };
  fs.writeFileSync(file, JSON.stringify(body, null, 1));
}

export function readRequests(file: string): ScanRequest[] {
  const body = JSON.parse(fs.readFileSync(file, 'utf8')) as RequestsFile;
  // Ricalcola la chiave: il file e' un'interfaccia, non va creduto alla cieca.
  return body.requests.map((r) => ({ caseId: r.caseId, start: r.start, end: r.end, key: scanKey(r.start, r.end) }));
}
