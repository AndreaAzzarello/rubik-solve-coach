// Esperimento #21: nucleo puro del replay della finestra di ispezione.
//
// Rigioca in Node (senza browser) le decisioni discrete che scelgono la finestra
// di ispezione. Chiama le funzioni di produzione reali di lib/video-decoder.ts:
// nessuna copia della logica di rilevamento.
//
// Pipeline a due stadi, come in produzione (inspection-pipeline.ts:94-128):
//   1. eventi (da campioni fusi, perturbabili) -> segmentazione -> intervalStart
//      e searchEnd;
//   2. scansione STRETTA [intervalStart, searchEnd] -> fine dell'ispezione.
// La scansione stretta legge fotogrammi a tempi che dipendono da (start, end)
// (buildInspectionSampleTimes), quindi non si puo' riusare una scansione larga:
// si raccolgono nel browser le scansioni delle coppie (start, searchEnd) che
// servono (bench/window-scan.ts, in batch) e il replay le cerca per chiave
// esatta. Se una coppia manca, la richiede (ScanRequest) e NON ripiega su altro.
//
// Differenza rispetto a bench/window-sensitivity.ts (#20): il baseline passa
// dallo STESSO percorso delle prove e conserva TUTTI i campi dei campioni.
// Limite noto (da registrare): il rumore perturba solo cubeDifference e sposta i
// tempi degli eventi; NON perturba i fotogrammi ne' le griglie colore.
//
// computeWindow()/finishWindow() sono una copia temporanea di
// inspection-pipeline.ts:94-128, da sostituire con la funzione condivisa al P3.

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
    /** Solo diagnostico (scansione larga della prima raccolta). */
    scanEnd?: number;
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
  /** Solo diagnostico: scansione larga [0, scanEnd] della prima raccolta. Non usata dal replay. */
  boundarySamples?: BoundarySample[];
  /** Finestra calcolata dal browser come in produzione (scansione stretta), per confronto. Null con --no-production-window. */
  production: WindowDecision | null;
}

// ---------------------------------------------------------------- scansioni

/** Chiave esatta di una scansione stretta: i doppi si serializzano senza perdita. */
export function scanKey(start: number, end: number): string {
  return `${start}|${end}`;
}

export interface ScanEntry {
  start: number;
  end: number;
  /** Durata della scansione nel browser, per stimare i tempi. */
  ms?: number;
  samples: BoundarySample[];
}

/** Scansioni raccolte di un video, per chiave. */
export type ScanStore = Map<string, BoundarySample[]>;

export interface ScanRequest {
  caseId: string;
  start: number;
  end: number;
  key: string;
}

export function makeRequest(caseId: string, start: number, end: number): ScanRequest {
  return { caseId, start, end, key: scanKey(start, end) };
}

/** Deduplica per (video, chiave) mantenendo l'ordine di prima comparsa. */
export function mergeRequests(requests: ScanRequest[]): ScanRequest[] {
  const seen = new Set<string>();
  const out: ScanRequest[] = [];
  for (const request of requests) {
    const id = `${request.caseId}#${request.key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(request);
  }
  return out;
}

export interface ScanComparison {
  identical: boolean;
  firstDiff: string | null;
}

/** C: confronto esatto di due scansioni della stessa coppia (determinismo del browser). */
export function compareScans(left: BoundarySample[], right: BoundarySample[]): ScanComparison {
  if (left.length !== right.length) {
    return { identical: false, firstDiff: `numero di campioni diverso: ${left.length} contro ${right.length}` };
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index].time !== right[index].time) {
      return { identical: false, firstDiff: `campione ${index}: time ${left[index].time} contro ${right[index].time}` };
    }
    if (JSON.stringify(left[index].faceGrids ?? null) !== JSON.stringify(right[index].faceGrids ?? null)) {
      return { identical: false, firstDiff: `campione ${index} (t=${left[index].time}): faceGrids diverse` };
    }
  }
  return { identical: true, firstDiff: null };
}

// ------------------------------------------------------------------ random

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

// ---------------------------------------------------------------- finestra

export interface WindowPlan {
  intervalStart: number;
  segmentationHint: number | null;
  searchEnd: number;
  stageCount: number;
  windowCount: number;
}

/** Stadio 1: dagli eventi a (intervalStart, searchEnd). Nessun clamp artificiale. */
export function planWindow(events: MotionEvent[], duration: number): WindowPlan {
  const segmentation = inferVideoSegmentation(events, 0, duration);
  const solveWindow = segmentation.windows.find((w) => w.id === segmentation.defaultWindowId) ?? null;
  const inspectionStage = solveWindow?.stages.find((s) => s.kind === 'inspection') ?? null;
  const automaticStart = inspectionStage?.start ?? 0;
  const intervalStart = Math.max(0, Math.min(automaticStart, duration - 0.5));
  const segmentationHint = inspectionStage?.end ?? solveWindow?.start ?? null;
  const baseSearchEnd = Math.min(duration, Math.max(8, Math.min(25, duration * 0.72)));
  const hintedSearchEnd = segmentationHint !== null && segmentationHint >= intervalStart + 2
    ? Math.min(duration, segmentationHint + 3)
    : intervalStart;
  return {
    intervalStart,
    segmentationHint,
    searchEnd: Math.max(baseSearchEnd, hintedSearchEnd),
    stageCount: solveWindow?.stages.length ?? 0,
    windowCount: segmentation.windows.length,
  };
}

/** Stadio 2: dalla scansione stretta alla fine dell'ispezione. */
export function finishWindow(
  plan: WindowPlan,
  events: MotionEvent[],
  scan: BoundarySample[],
  duration: number,
): WindowDecision {
  const boundary = inferInspectionEnd(scan as MotionSample[], events, plan.intervalStart, plan.searchEnd, plan.segmentationHint);
  const firstCubeChange = Math.max(plan.intervalStart + 0.5, boundary.time);
  const intervalEnd = Math.max(
    plan.intervalStart + 0.5,
    Math.min(lastInspectionFrameTime(plan.intervalStart, firstCubeChange, 60), duration),
  );
  return {
    intervalStart: plan.intervalStart,
    segmentationHint: plan.segmentationHint,
    searchEnd: plan.searchEnd,
    boundaryTime: boundary.time,
    boundarySource: boundary.source,
    intervalEnd,
    stageCount: plan.stageCount,
    windowCount: plan.windowCount,
  };
}

export type WindowOutcome =
  | { window: WindowDecision; missing: null }
  | { window: null; missing: ScanRequest };

/** Finestra completa; se la scansione della coppia non e' in cache, restituisce la richiesta. */
export function computeWindow(
  caseId: string,
  events: MotionEvent[],
  duration: number,
  store: ScanStore,
): WindowOutcome {
  const plan = planWindow(events, duration);
  const scan = store.get(scanKey(plan.intervalStart, plan.searchEnd));
  if (!scan) return { window: null, missing: makeRequest(caseId, plan.intervalStart, plan.searchEnd) };
  return { window: finishWindow(plan, events, scan, duration), missing: null };
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

/**
 * S0: il replay deve riprodurre ESATTAMENTE gli eventi (e la soglia) di produzione.
 * `cache.events` / `cache.threshold` sono quelli registrati nel browser, restituiti
 * da decodeVideoMotion (window-cache.ts); il replay li ricalcola dai soli campioni
 * fusi con le stesse funzioni, quindi il confronto non e' una semplice idempotenza
 * di fuseMotionEvidence ma verifica il risultato reale dell'app.
 */
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

/** Confronto finestra del replay con quella di produzione (confronto esatto, tolleranza solo numerica). */
export function diffWindows(replay: WindowDecision, production: WindowDecision, tolerance = 1e-9): WindowDiff[] {
  const out: WindowDiff[] = [];
  const keys: Array<keyof WindowDecision> = [
    'intervalStart', 'segmentationHint', 'searchEnd', 'boundaryTime', 'boundarySource', 'intervalEnd', 'stageCount', 'windowCount',
  ];
  for (const key of keys) {
    const a = replay[key] as number | string | null;
    const b = production[key] as number | string | null;
    const same = typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) <= tolerance : a === b;
    if (!same) out.push({ field: key, replay: a, production: b });
  }
  return out;
}

/** Limite dell'arresto S0b: oltre 1 video su 13 con finestra replay diversa da quella di produzione. */
export const S0B_MAX_MISMATCHED_VIDEOS = 1;

/**
 * S0b: i video la cui finestra del replay differisce da quella di produzione.
 * "Differisce" = QUALUNQUE campo di diffWindows (confronto esatto): e' la
 * definizione piu' severa; e' il titolare a decidere dopo l'arresto. Chi non ha
 * la finestra di produzione o la scansione (finestra del replay assente) non si conta.
 */
export function windowMismatchVideos<T extends { caseId: string; production: unknown; windowVsProduction: WindowDiff[] }>(
  reports: T[],
): T[] {
  return reports.filter((report) => report.production && report.windowVsProduction.length > 0);
}

// ------------------------------------------------------------------- prove

export interface TrialResult extends WindowDecision {
  trial: number;
  seed: number;
  shiftFrames: -1 | 0 | 1;
  significant: boolean;
  significantReason: string[];
}

export interface TrialSetup {
  caseId: string;
  samples: MotionSample[];
  store: ScanStore;
  duration: number;
  sampleInterval: number;
  trialCount: number;
  seedBase: number;
  amplitude: number;
  frameDuration: number;
  significantShiftS: number;
}

export interface TrialSummary {
  /** Null se la scansione della coppia di baseline manca. */
  baseline: WindowDecision | null;
  /** Solo le prove completabili: quelle con scansione mancante sono in `missing`. */
  trials: TrialResult[];
  significantChangeCount: number;
  missing: ScanRequest[];
}

export function runTrials(setup: TrialSetup): TrialSummary {
  const missing: ScanRequest[] = [];
  const baselineDetected = detectFromSamples(setup.samples, setup.sampleInterval);
  const baselineOutcome = computeWindow(setup.caseId, baselineDetected.events, setup.duration, setup.store);
  if (baselineOutcome.missing) missing.push(baselineOutcome.missing);
  const baseline = baselineOutcome.window;
  const trials: TrialResult[] = [];
  let significantChangeCount = 0;
  for (let trial = 0; trial < setup.trialCount; trial += 1) {
    const seed = setup.seedBase + trial;
    const rand = mulberry32(seed);
    const shiftFrames = ((trial % 3) - 1) as -1 | 0 | 1;
    const perturbed = perturbSamples(setup.samples, rand, setup.amplitude, shiftFrames * setup.frameDuration);
    const detected = detectFromSamples(perturbed, setup.sampleInterval);
    const outcome = computeWindow(setup.caseId, detected.events, setup.duration, setup.store);
    if (outcome.missing) { missing.push(outcome.missing); continue; }
    if (!baseline) continue; // senza baseline non c'e' confronto: la prova non conta
    const window = outcome.window;
    const reasons: string[] = [];
    if (Math.abs(window.intervalStart - baseline.intervalStart) > setup.significantShiftS) reasons.push('intervalStart spostato > 0.5s');
    if (Math.abs(window.intervalEnd - baseline.intervalEnd) > setup.significantShiftS) reasons.push('intervalEnd spostato > 0.5s');
    if (window.stageCount !== baseline.stageCount) reasons.push(`numero di fasi diverso (${baseline.stageCount} -> ${window.stageCount})`);
    const significant = reasons.length > 0;
    if (significant) significantChangeCount += 1;
    trials.push({ trial, seed, shiftFrames, significant, significantReason: reasons, ...window });
  }
  return { baseline, trials, significantChangeCount, missing: mergeRequests(missing) };
}
