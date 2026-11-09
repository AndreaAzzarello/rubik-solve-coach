// Esperimento #21: nucleo puro del replay della finestra di ispezione.
//
// Rigioca in Node (senza browser) le decisioni discrete che scelgono la finestra
// di ispezione, a partire dai dati grezzi raccolti UNA volta da
// bench/window-cache.ts. Chiama le funzioni di produzione reali di
// lib/video-decoder.ts: nessuna copia della logica di rilevamento.
//
// Differenza rispetto a bench/window-sensitivity.ts (#20): qui il baseline passa
// dallo STESSO percorso delle prove (fuseMotionEvidence -> detectMotionEvents)
// e conserva TUTTI i campi dei campioni. Nel #20 il baseline usava campioni
// ridotti a 4 campi (senza cubeEvidence/handEvidence/coverage/centerBias), quindi
// non poteva mai produrre 'state-change' o 'motion-density' come le prove.
//
// computeWindow() e' una copia temporanea di inspection-pipeline.ts:94-128 (come
// nel #20): sara' sostituita dalla funzione condivisa estratta al passo P3.

import {
  detectMotionEvents,
  fuseMotionEvidence,
  inferInspectionEnd,
  inferVideoSegmentation,
  lastInspectionFrameTime,
  type MotionEvent,
  type MotionSample,
} from '../../lib/video-decoder.ts';

export interface WindowDecision {
  intervalStart: number;
  segmentationHint: number | null;
  searchEnd: number;
  searchEndClamped: boolean;
  boundaryTime: number;
  boundarySource: string;
  intervalEnd: number;
  stageCount: number;
  windowCount: number;
}

/** Solo cio' che inferInspectionEnd legge: tempo e griglie-colore osservate. */
export type BoundarySample = Pick<MotionSample, 'time' | 'faceGrids'>;

export interface VideoCache {
  meta: {
    caseId: string;
    videoFile: string;
    duration: number;
    sampleInterval: number;
    scanEnd: number;
    createdAt: string;
    platform: string;
    chrome: string;
    gitCommit: string;
    gitStatus: string;
    analysisPass: number;
    windowRobustFlag: unknown;
  };
  /** motion.samples di decodeVideoMotion: campioni gia' fusi, TUTTI i campi. */
  samples: MotionSample[];
  /** motion.events di produzione. */
  events: MotionEvent[];
  threshold: number;
  /** Scansione larga [0, scanEnd], una sola volta (come nel #20). */
  boundarySamples: BoundarySample[];
  /** Finestra calcolata come in produzione (scansione stretta), per confronto. Null con --no-production-window. */
  production: WindowDecision | null;
}

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function computeWindow(
  events: MotionEvent[],
  boundarySamples: BoundarySample[],
  duration: number,
  boundaryEnd: number,
): WindowDecision {
  const segmentation = inferVideoSegmentation(events, 0, duration);
  const solveWindow = segmentation.windows.find((w) => w.id === segmentation.defaultWindowId) ?? null;
  const inspectionStage = solveWindow?.stages.find((s) => s.kind === 'inspection') ?? null;
  const automaticStart = inspectionStage?.start ?? 0;
  const intervalStart = Math.max(0, Math.min(automaticStart, duration - 0.5));
  const segmentationHint = inspectionStage?.end ?? solveWindow?.start ?? null;
  const localBaseSearchEnd = Math.min(duration, Math.max(8, Math.min(25, duration * 0.72)));
  const hintedSearchEnd = segmentationHint !== null && segmentationHint >= intervalStart + 2
    ? Math.min(duration, segmentationHint + 3)
    : intervalStart;
  const rawSearchEnd = Math.max(localBaseSearchEnd, hintedSearchEnd);
  const searchEndClamped = rawSearchEnd > boundaryEnd;
  const searchEnd = Math.min(rawSearchEnd, boundaryEnd);
  const boundary = inferInspectionEnd(boundarySamples as MotionSample[], events, intervalStart, searchEnd, segmentationHint);
  const firstCubeChange = Math.max(intervalStart + 0.5, boundary.time);
  const intervalEnd = Math.max(
    intervalStart + 0.5,
    Math.min(lastInspectionFrameTime(intervalStart, firstCubeChange, 60), duration),
  );
  return {
    intervalStart,
    segmentationHint,
    searchEnd,
    searchEndClamped,
    boundaryTime: boundary.time,
    boundarySource: boundary.source,
    intervalEnd,
    stageCount: solveWindow?.stages.length ?? 0,
    windowCount: segmentation.windows.length,
  };
}

/** Stesso schema del #20: rumore moltiplicativo su cubeDifference + spostamento dei tempi. */
export function perturbSamples(
  samples: MotionSample[],
  rand: () => number,
  amplitude: number,
  shiftSeconds: number,
): MotionSample[] {
  return samples.map((s) => ({
    ...s,
    cubeDifference: (s.cubeDifference ?? s.difference) * (1 + (rand() * 2 - 1) * amplitude),
    time: s.time + shiftSeconds,
  }));
}

export function detectFromSamples(samples: MotionSample[], sampleInterval: number) {
  return detectMotionEvents(fuseMotionEvidence(samples), sampleInterval);
}

export interface FidelityResult {
  exact: boolean;
  replayEvents: number;
  productionEvents: number;
  thresholdEqual: boolean;
  firstMismatch: string | null;
}

const normalize = (value: unknown) => JSON.parse(JSON.stringify(value));

/** S0: il replay deve riprodurre ESATTAMENTE gli eventi (e la soglia) di produzione. */
export function checkEventFidelity(cache: Pick<VideoCache, 'samples' | 'events' | 'threshold'> & { meta: { sampleInterval: number } }): FidelityResult {
  const replay = detectFromSamples(cache.samples, cache.meta.sampleInterval);
  const replayEvents = normalize(replay.events) as Array<Record<string, unknown>>;
  const productionEvents = normalize(cache.events) as Array<Record<string, unknown>>;
  const thresholdEqual = replay.threshold === cache.threshold;
  let firstMismatch: string | null = null;
  const count = Math.max(replayEvents.length, productionEvents.length);
  for (let index = 0; index < count && firstMismatch === null; index += 1) {
    const left = replayEvents[index];
    const right = productionEvents[index];
    if (!left || !right) {
      firstMismatch = `evento ${index}: ${left ? 'solo nel replay' : 'solo in produzione'}`;
      break;
    }
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of keys) {
      if (JSON.stringify(left[key]) !== JSON.stringify(right[key])) {
        firstMismatch = `evento ${index}, campo ${key}: replay=${JSON.stringify(left[key])} produzione=${JSON.stringify(right[key])}`;
        break;
      }
    }
  }
  return {
    exact: firstMismatch === null && thresholdEqual,
    replayEvents: replayEvents.length,
    productionEvents: productionEvents.length,
    thresholdEqual,
    firstMismatch,
  };
}

export interface WindowDiff {
  field: string;
  replay: number | string | null;
  production: number | string | null;
}

/** Confronto finestra del replay (scansione larga) con quella di produzione (scansione stretta). */
export function diffWindows(replay: WindowDecision, production: WindowDecision, tolerance = 1e-9): WindowDiff[] {
  const out: WindowDiff[] = [];
  const keys: Array<keyof WindowDecision> = ['intervalStart', 'segmentationHint', 'boundaryTime', 'boundarySource', 'intervalEnd', 'stageCount', 'windowCount'];
  for (const key of keys) {
    const a = replay[key] as number | string | null;
    const b = production[key] as number | string | null;
    const same = typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) <= tolerance : a === b;
    if (!same) out.push({ field: key, replay: a, production: b });
  }
  return out;
}

export interface TrialResult extends WindowDecision {
  trial: number;
  seed: number;
  shiftFrames: -1 | 0 | 1;
  significant: boolean;
  significantReason: string[];
}

export interface TrialSetup {
  samples: MotionSample[];
  boundarySamples: BoundarySample[];
  duration: number;
  sampleInterval: number;
  scanEnd: number;
  trialCount: number;
  seedBase: number;
  amplitude: number;
  frameDuration: number;
  significantShiftS: number;
}

export interface TrialSummary {
  baseline: WindowDecision;
  trials: TrialResult[];
  significantChangeCount: number;
}

export function runTrials(setup: TrialSetup): TrialSummary {
  const baselineDetected = detectFromSamples(setup.samples, setup.sampleInterval);
  const baseline = computeWindow(baselineDetected.events, setup.boundarySamples, setup.duration, setup.scanEnd);
  const trials: TrialResult[] = [];
  let significantChangeCount = 0;
  for (let trial = 0; trial < setup.trialCount; trial += 1) {
    const seed = setup.seedBase + trial;
    const rand = mulberry32(seed);
    const shiftFrames = ((trial % 3) - 1) as -1 | 0 | 1;
    const perturbed = perturbSamples(setup.samples, rand, setup.amplitude, shiftFrames * setup.frameDuration);
    const detected = detectFromSamples(perturbed, setup.sampleInterval);
    const window = computeWindow(detected.events, setup.boundarySamples, setup.duration, setup.scanEnd);
    const reasons: string[] = [];
    if (Math.abs(window.intervalStart - baseline.intervalStart) > setup.significantShiftS) reasons.push('intervalStart spostato > 0.5s');
    if (Math.abs(window.intervalEnd - baseline.intervalEnd) > setup.significantShiftS) reasons.push('intervalEnd spostato > 0.5s');
    if (window.stageCount !== baseline.stageCount) reasons.push(`numero di fasi diverso (${baseline.stageCount} -> ${window.stageCount})`);
    const significant = reasons.length > 0;
    if (significant) significantChangeCount += 1;
    trials.push({ trial, seed, shiftFrames, significant, significantReason: reasons, ...window });
  }
  return { baseline, trials, significantChangeCount };
}
