import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  computeInspectionWindow,
  planInspectionWindow,
  readWindowRobustFlag,
  type InspectionWindow,
} from './inspection-window.ts';
import {
  detectMotionEvents,
  fuseMotionEvidence,
  inferInspectionEnd,
  inferVideoSegmentation,
  lastInspectionFrameTime,
  type MotionEvent,
  type MotionSample,
} from './video-decoder.ts';

// Esperimento #21, P3: computeInspectionWindow e' il codice di
// inspection-pipeline.ts (righe 94-128 prima del refactor) estratto in una
// funzione condivisa. Con il flag __benchWindowRobust spento deve essere
// IDENTICO, bit a bit, al comportamento di prima. Arresto S2 se non lo e'.

type Target = { __benchWindowRobust?: unknown };
const target = globalThis as Target;

// Copia VERBATIM del codice inline di inspection-pipeline.ts prima del refactor.
function referenceWindow(events: MotionEvent[], duration: number, scan: MotionSample[]): InspectionWindow {
  const segmentation = inferVideoSegmentation(events, 0, duration);
  const solveWindow = segmentation.windows.find((window) => window.id === segmentation.defaultWindowId);
  const inspectionStage = solveWindow?.stages.find((stage) => stage.kind === 'inspection');
  const automaticStart = inspectionStage?.start ?? 0;
  const intervalStart = Math.max(0, Math.min(automaticStart, duration - 0.5));
  const segmentationHint = inspectionStage?.end ?? solveWindow?.start ?? null;
  const baseSearchEnd = Math.min(duration, Math.max(8, Math.min(25, duration * 0.72)));
  const hintedSearchEnd = segmentationHint && segmentationHint >= intervalStart + 2
    ? Math.min(duration, segmentationHint + 3)
    : intervalStart;
  const searchEnd = Math.max(baseSearchEnd, hintedSearchEnd);
  const boundary = inferInspectionEnd(scan, events, intervalStart, searchEnd, segmentationHint);
  const firstCubeChange = Math.max(intervalStart + 0.5, boundary.time);
  const intervalEnd = Math.max(
    intervalStart + 0.5,
    Math.min(lastInspectionFrameTime(intervalStart, firstCubeChange, 60), duration),
  );
  return {
    intervalStart,
    segmentationHint,
    searchEnd,
    boundaryTime: boundary.time,
    boundarySource: boundary.source,
    intervalEnd,
    stageCount: solveWindow?.stages.length ?? 0,
    windowCount: segmentation.windows.length,
  };
}

function syntheticEvents(): MotionEvent[] {
  const peaks = new Set([30, 31, 52, 53, 64, 65, 72, 73, 80, 81, 88, 89, 96, 97, 104, 105]);
  const raw: MotionSample[] = [];
  for (let index = 0; index < 160; index += 1) {
    const value = peaks.has(index) ? 14 : 1 + ((index * 37) % 10) / 20;
    raw.push({ time: index * 0.1, difference: value, cubeDifference: value, handMotion: 0, coverage: 0.2, centerBias: 1 });
  }
  return detectMotionEvents(fuseMotionEvidence(raw), 0.1).events;
}

test('flag spento = identico: finestra uguale al codice di prima su durate diverse (sintetico)', async () => {
  delete target.__benchWindowRobust;
  const events = syntheticEvents();
  for (const duration of [16, 40, 100]) {
    const scan: MotionSample[] = [];
    const expected = referenceWindow(events, duration, scan);
    const actual = await computeInspectionWindow({ events, duration, scan: async () => scan });
    assert.deepEqual(actual.window, expected, `durata ${duration}`);
    assert.equal(JSON.stringify(actual.window), JSON.stringify(expected));
  }
});

test('computeInspectionWindow chiede la scansione esattamente per (intervalStart, searchEnd) del piano', async () => {
  delete target.__benchWindowRobust;
  const events = syntheticEvents();
  const plan = planInspectionWindow(events, 16);
  const calls: Array<[number, number]> = [];
  const result = await computeInspectionWindow({ events, duration: 16, scan: async (start, end) => { calls.push([start, end]); return []; } });
  assert.deepEqual(calls, [[plan.intervalStart, plan.searchEnd]]);
  assert.equal(result.window.intervalStart, plan.intervalStart);
  assert.equal(result.window.searchEnd, plan.searchEnd);
});

test('flag __benchWindowRobust: spento (undefined, false, "off") non cambia nulla; acceso senza varianti fallisce forte', async () => {
  const events = syntheticEvents();
  const expected = referenceWindow(events, 16, []);
  for (const value of [undefined, false, 'off']) {
    if (value === undefined) delete target.__benchWindowRobust; else target.__benchWindowRobust = value;
    assert.equal(readWindowRobustFlag(), value);
    const actual = await computeInspectionWindow({ events, duration: 16, scan: async () => [] });
    assert.deepEqual(actual.window, expected);
  }
  target.__benchWindowRobust = 'D';
  try {
    assert.throws(() => planInspectionWindow(events, 16), /non implementat/);
    await assert.rejects(computeInspectionWindow({ events, duration: 16, scan: async () => [] }), /non implementat/);
  } finally {
    delete target.__benchWindowRobust;
  }
});

// Prova sui dati reali: le 13 finestre registrate dal browser con il codice
// di prima (cache locale, gitignored). Senza cache (CI) il test si salta.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BENCH = path.resolve(HERE, '..', 'bench');
const cases = JSON.parse(fs.readFileSync(path.join(BENCH, 'cases.json'), 'utf8')).cases as Array<{ id: string }>;
const haveCache = cases.every((c) => fs.existsSync(path.join(BENCH, 'results', 'window-cache', `${c.id}.json`))
  && fs.existsSync(path.join(BENCH, 'results', 'window-scans', `${c.id}.json`)));

test('flag spento = identico, bit a bit, sulle 13 finestre registrate nel browser', { skip: haveCache ? false : 'cache locale assente (bench/results/ e\' gitignored)' }, async () => {
  delete target.__benchWindowRobust;
  const picked = ['intervalStart', 'segmentationHint', 'searchEnd', 'boundaryTime', 'boundarySource', 'intervalEnd', 'stageCount', 'windowCount'] as const;
  for (const entry of cases) {
    const cache = JSON.parse(fs.readFileSync(path.join(BENCH, 'results', 'window-cache', `${entry.id}.json`), 'utf8'));
    const scans = JSON.parse(fs.readFileSync(path.join(BENCH, 'results', 'window-scans', `${entry.id}.json`), 'utf8')).scans as Record<string, { start: number; end: number; samples: MotionSample[] }>;
    const recorded = cache.production as Record<string, unknown>;
    // Eventi REGISTRATI nel browser (non ricalcolati) e scansione stretta della coppia registrata.
    const scan = Object.values(scans).find((s) => s.start === recorded.intervalStart && s.end === recorded.searchEnd);
    assert.ok(scan, `${entry.id}: scansione della coppia di produzione mancante`);
    const result = await computeInspectionWindow({ events: cache.events, duration: cache.meta.duration, scan: async () => scan.samples });
    for (const key of picked) {
      assert.equal(JSON.stringify(result.window[key]), JSON.stringify(recorded[key]), `${entry.id}: campo ${key}`);
    }
  }
});
