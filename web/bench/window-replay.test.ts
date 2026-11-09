import assert from 'node:assert/strict';
import test from 'node:test';
import type { MotionSample } from '../lib/video-decoder.ts';
import { detectMotionEvents, fuseMotionEvidence } from '../lib/video-decoder.ts';
import {
  checkEventFidelity,
  computeWindow,
  detectFromSamples,
  diffWindows,
  mulberry32,
  perturbSamples,
  runTrials,
  S0B_MAX_MISMATCHED_VIDEOS,
  windowMismatchVideos,
  type WindowDecision,
} from './lib/window-replay-core.ts';

const SAMPLE_INTERVAL = 0.1;

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

test('senza rumore la prova con spostamento 0 coincide con il baseline (stesso percorso)', () => {
  const fused = fuseMotionEvidence(syntheticRawSamples());
  const summary = runTrials({
    samples: fused,
    boundarySamples: [],
    duration: 16,
    sampleInterval: SAMPLE_INTERVAL,
    scanEnd: 16,
    trialCount: 12,
    seedBase: 20261013,
    amplitude: 0,
    frameDuration: 1 / 30,
    significantShiftS: 0.5,
  });
  const noShift = summary.trials.filter((t) => t.shiftFrames === 0);
  assert.equal(noShift.length, 4);
  for (const trial of noShift) {
    assert.equal(trial.significant, false);
    assert.equal(trial.intervalStart, summary.baseline.intervalStart);
    assert.equal(trial.intervalEnd, summary.baseline.intervalEnd);
    assert.equal(trial.stageCount, summary.baseline.stageCount);
  }
});

test('le prove sono riproducibili: stessi semi, stesso risultato', () => {
  const fused = fuseMotionEvidence(syntheticRawSamples());
  const setup = {
    samples: fused, boundarySamples: [], duration: 16, sampleInterval: SAMPLE_INTERVAL, scanEnd: 16,
    trialCount: 12, seedBase: 20261013, amplitude: 0.01, frameDuration: 1 / 30, significantShiftS: 0.5,
  };
  assert.deepEqual(runTrials(setup), runTrials(setup));
});

test('computeWindow restituisce una finestra coerente (inizio < fine, dentro la durata)', () => {
  const fused = fuseMotionEvidence(syntheticRawSamples());
  const events = detectFromSamples(fused, SAMPLE_INTERVAL).events;
  const window = computeWindow(events, [], 16, 16);
  assert.ok(window.intervalEnd > window.intervalStart);
  assert.ok(window.intervalEnd <= 16);
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

test('diffWindows riporta solo i campi diversi', () => {
  const base: WindowDecision = {
    intervalStart: 1, segmentationHint: 5, searchEnd: 12, searchEndClamped: false, boundaryTime: 6,
    boundarySource: 'state-change', intervalEnd: 6, stageCount: 3, windowCount: 1,
  };
  assert.deepEqual(diffWindows(base, { ...base }), []);
  const diff = diffWindows(base, { ...base, boundarySource: 'fallback', intervalEnd: 7 });
  assert.deepEqual(diff.map((d) => d.field).sort(), ['boundarySource', 'intervalEnd']);
});
