import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { MotionSample } from '../lib/video-decoder.ts';
import { detectMotionEvents, fuseMotionEvidence } from '../lib/video-decoder.ts';
import {
  checkEventFidelity,
  compareScans,
  computeWindow,
  detectFromSamples,
  diffWindows,
  finishWindow,
  makeRequest,
  mergeRequests,
  mulberry32,
  perturbSamples,
  planWindow,
  runTrials,
  S0B_MAX_MISMATCHED_VIDEOS,
  scanKey,
  windowMismatchVideos,
  type BoundarySample,
  type ScanStore,
  type WindowDecision,
} from './lib/window-replay-core.ts';
import { loadScanFile, readRequests, saveScanFile, toStore, writeRequests } from './lib/scan-store-io.ts';

const SAMPLE_INTERVAL = 0.1;
const DURATION = 16;

// Segnale sintetico: rumore di fondo deterministico + raffiche di movimento.
function syntheticRawSamples(): MotionSample[] {
  const peaks = new Set([30, 31, 52, 53, 64, 65, 72, 73, 80, 81, 88, 89, 96, 97, 104, 105]);
  const samples: MotionSample[] = [];
  for (let index = 0; index < 160; index += 1) {
    const value = peaks.has(index) ? 14 : 1 + ((index * 37) % 10) / 20;
    samples.push({
      time: index * SAMPLE_INTERVAL,
      difference: value,
      cubeDifference: value,
      handMotion: 0,
      coverage: 0.2,
      centerBias: 1,
    });
  }
  return samples;
}

/** Riempie lo store con scansioni vuote per ogni coppia richiesta, finche' non manca piu' nulla. */
function fillStore(caseId: string, samples: MotionSample[], amplitude: number): ScanStore {
  const store: ScanStore = new Map();
  for (let round = 0; round < 8; round += 1) {
    const summary = runTrials({
      caseId, samples, store, duration: DURATION, sampleInterval: SAMPLE_INTERVAL, trialCount: 12,
      seedBase: 20261013, amplitude, frameDuration: 1 / 30, significantShiftS: 0.5,
    });
    if (summary.missing.length === 0) return store;
    for (const request of summary.missing) store.set(request.key, []);
  }
  throw new Error('lo store non converge');
}

test('mulberry32 e\' deterministico per lo stesso seme e diverso per semi diversi', () => {
  const a = mulberry32(20261013);
  const b = mulberry32(20261013);
  const c = mulberry32(20261014);
  const seqA = [a(), a(), a(), a()];
  assert.deepEqual(seqA, [b(), b(), b(), b()]);
  assert.notDeepEqual(seqA, [c(), c(), c(), c()]);
});

test('perturbSamples con ampiezza 0 e spostamento 0 e\' l\'identita\' e conserva tutti i campi', () => {
  const samples = fuseMotionEvidence(syntheticRawSamples());
  const out = perturbSamples(samples, mulberry32(1), 0, 0);
  assert.deepEqual(out, samples);
  assert.equal(out[0].coverage, 0.2);
});

// Come decodeVideoMotion (video-decoder.ts:1965-1967): detect(fuse(grezzi)); i
// campioni restituiti sono quelli GIA' fusi. Il replay rifonde i campioni fusi.
function productionLike() {
  return detectMotionEvents(fuseMotionEvidence(syntheticRawSamples()), SAMPLE_INTERVAL);
}

test('S0: gli eventi rigiocati dai campioni fusi coincidono esattamente con la produzione', () => {
  const production = productionLike();
  assert.ok(production.events.length > 0, 'il segnale sintetico deve produrre eventi');
  const cache = { samples: production.samples, events: production.events, threshold: production.threshold, meta: { sampleInterval: SAMPLE_INTERVAL } };
  const result = checkEventFidelity(cache);
  assert.equal(result.exact, true);
  assert.equal(result.firstMismatch, null);
});

test('S0: un evento di produzione diverso viene segnalato con il primo campo discordante', () => {
  const production = productionLike();
  const tampered = production.events.map((event, index) => (index === 0 ? { ...event, peakTime: event.peakTime + 0.5 } : event));
  const result = checkEventFidelity({ samples: production.samples, events: tampered, threshold: production.threshold, meta: { sampleInterval: SAMPLE_INTERVAL } });
  assert.equal(result.exact, false);
  assert.match(result.firstMismatch ?? '', /evento 0, campo peakTime/);
});

test('scanKey: esatta, distingue anche start che differiscono di un fotogramma', () => {
  assert.equal(scanKey(1.2, 20.188), scanKey(1.2, 20.188));
  assert.notEqual(scanKey(1.2, 20.188), scanKey(1.2 + 1 / 30, 20.188));
  assert.notEqual(scanKey(1.2, 20.188), scanKey(1.2, 20.188 + 1 / 30));
});

test('planWindow: nessun clamp, searchEnd = max(base, hint+3) e coerente con la durata', () => {
  const events = detectFromSamples(fuseMotionEvidence(syntheticRawSamples()), SAMPLE_INTERVAL).events;
  const plan = planWindow(events, DURATION);
  const base = Math.min(DURATION, Math.max(8, Math.min(25, DURATION * 0.72)));
  const hinted = plan.segmentationHint !== null && plan.segmentationHint >= plan.intervalStart + 2
    ? Math.min(DURATION, plan.segmentationHint + 3) : plan.intervalStart;
  assert.equal(plan.searchEnd, Math.max(base, hinted));
  // su un video lungo il limite non e' piu' 28 s come nel replay precedente
  const long = planWindow(events, 100);
  assert.ok(long.searchEnd <= 100);
});

test('computeWindow: con la coppia mancante restituisce la richiesta, senza ripiegare su altro', () => {
  const events = detectFromSamples(fuseMotionEvidence(syntheticRawSamples()), SAMPLE_INTERVAL).events;
  const plan = planWindow(events, DURATION);
  const missing = computeWindow('IMG_X', events, DURATION, new Map());
  assert.equal(missing.window, null);
  assert.deepEqual(missing.missing, makeRequest('IMG_X', plan.intervalStart, plan.searchEnd));
  const store: ScanStore = new Map([[scanKey(plan.intervalStart, plan.searchEnd), []]]);
  const found = computeWindow('IMG_X', events, DURATION, store);
  assert.equal(found.missing, null);
  assert.equal(found.window?.intervalStart, plan.intervalStart);
  assert.deepEqual(found.window, finishWindow(plan, events, [], DURATION));
  assert.ok(found.window!.intervalEnd > found.window!.intervalStart);
  assert.ok(found.window!.intervalEnd <= DURATION);
});

test('runTrials con store vuoto: nessuna prova inventata, tutto in missing (deduplicato)', () => {
  const fused = fuseMotionEvidence(syntheticRawSamples());
  const summary = runTrials({
    caseId: 'IMG_X', samples: fused, store: new Map(), duration: DURATION, sampleInterval: SAMPLE_INTERVAL,
    trialCount: 12, seedBase: 20261013, amplitude: 0.01, frameDuration: 1 / 30, significantShiftS: 0.5,
  });
  assert.equal(summary.baseline, null);
  assert.equal(summary.trials.length, 0);
  assert.ok(summary.missing.length >= 1);
  assert.equal(new Set(summary.missing.map((m) => m.key)).size, summary.missing.length);
});

test('senza rumore la prova con spostamento 0 coincide con il baseline (stesso percorso)', () => {
  const fused = fuseMotionEvidence(syntheticRawSamples());
  const store = fillStore('IMG_X', fused, 0);
  const summary = runTrials({
    caseId: 'IMG_X', samples: fused, store, duration: DURATION, sampleInterval: SAMPLE_INTERVAL,
    trialCount: 12, seedBase: 20261013, amplitude: 0, frameDuration: 1 / 30, significantShiftS: 0.5,
  });
  assert.equal(summary.missing.length, 0);
  assert.ok(summary.baseline);
  const noShift = summary.trials.filter((t) => t.shiftFrames === 0);
  assert.equal(noShift.length, 4);
  for (const trial of noShift) {
    assert.equal(trial.significant, false);
    assert.equal(trial.intervalStart, summary.baseline!.intervalStart);
    assert.equal(trial.intervalEnd, summary.baseline!.intervalEnd);
    assert.equal(trial.stageCount, summary.baseline!.stageCount);
  }
});

test('le prove sono riproducibili: stessi semi, stesso risultato', () => {
  const fused = fuseMotionEvidence(syntheticRawSamples());
  const store = fillStore('IMG_X', fused, 0.01);
  const setup = {
    caseId: 'IMG_X', samples: fused, store, duration: DURATION, sampleInterval: SAMPLE_INTERVAL,
    trialCount: 12, seedBase: 20261013, amplitude: 0.01, frameDuration: 1 / 30, significantShiftS: 0.5,
  };
  assert.deepEqual(runTrials(setup), runTrials(setup));
});

test('mergeRequests deduplica per video e chiave, non tra video diversi', () => {
  const a = makeRequest('A', 1, 10);
  const merged = mergeRequests([a, makeRequest('A', 1, 10), makeRequest('A', 1.0333, 10), makeRequest('B', 1, 10)]);
  assert.deepEqual(merged.map((r) => `${r.caseId}:${r.key}`), ['A:1|10', 'A:1.0333|10', 'B:1|10']);
});

test('compareScans: identiche, numero diverso, tempo diverso, griglie diverse', () => {
  const grid = { centerColor: 'white', colors: ['white', null], confidence: 80, visibleCells: 9 };
  const base: BoundarySample[] = [
    { time: 0.5, faceGrids: [grid] as unknown as BoundarySample['faceGrids'] },
    { time: 1, faceGrids: [] },
  ];
  assert.deepEqual(compareScans(base, structuredClone(base)), { identical: true, firstDiff: null });
  assert.match(compareScans(base, base.slice(0, 1)).firstDiff ?? '', /numero di campioni/);
  const shifted = structuredClone(base); shifted[1].time = 1.0001;
  assert.match(compareScans(base, shifted).firstDiff ?? '', /campione 1: time/);
  const other = structuredClone(base); (other[0].faceGrids as unknown as Array<{ confidence: number }>)[0].confidence = 81;
  assert.match(compareScans(base, other).firstDiff ?? '', /campione 0 .*faceGrids diverse/);
});

test('scan-store-io: andata e ritorno su disco senza perdita, richieste incluse', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'window-scan-test-'));
  try {
    const request = makeRequest('IMG_X', 0.1 + 0.2, 20.188);
    const samples: BoundarySample[] = [{ time: 0.3, faceGrids: [] }];
    const file = loadScanFile(dir, 'IMG_X');
    file.scans[request.key] = { start: request.start, end: request.end, ms: 1234, samples };
    saveScanFile(dir, file);
    const store = toStore(loadScanFile(dir, 'IMG_X'));
    assert.deepEqual(store.get(scanKey(0.1 + 0.2, 20.188)), samples); // 0.30000000000000004 sopravvive al JSON
    const requestsFile = path.join(dir, 'requests.json');
    writeRequests(requestsFile, [request]);
    assert.deepEqual(readRequests(requestsFile), [request]);
    assert.equal(loadScanFile(dir, 'ALTRO').scans && Object.keys(loadScanFile(dir, 'ALTRO').scans).length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('S0b: windowMismatchVideos conta solo i video con produzione e differenze', () => {
  const diff = [{ field: 'intervalEnd', replay: 7, production: 6 }];
  const reports = [
    { caseId: 'A', production: {}, windowVsProduction: [] },
    { caseId: 'B', production: {}, windowVsProduction: diff },
    { caseId: 'C', production: null, windowVsProduction: [] },
    { caseId: 'D', production: {}, windowVsProduction: diff },
  ];
  assert.deepEqual(windowMismatchVideos(reports).map((r) => r.caseId), ['B', 'D']);
  assert.equal(windowMismatchVideos(reports).length > S0B_MAX_MISMATCHED_VIDEOS, true);
  assert.equal(windowMismatchVideos(reports.slice(0, 2)).length > S0B_MAX_MISMATCHED_VIDEOS, false);
});

test('diffWindows riporta solo i campi diversi, searchEnd compreso', () => {
  const base: WindowDecision = {
    intervalStart: 1, segmentationHint: 5, searchEnd: 12, boundaryTime: 6,
    boundarySource: 'state-change', intervalEnd: 6, stageCount: 3, windowCount: 1,
  };
  assert.deepEqual(diffWindows(base, { ...base }), []);
  const diff = diffWindows(base, { ...base, boundarySource: 'fallback', intervalEnd: 7, searchEnd: 13 });
  assert.deepEqual(diff.map((d) => d.field).sort(), ['boundarySource', 'intervalEnd', 'searchEnd']);
});
