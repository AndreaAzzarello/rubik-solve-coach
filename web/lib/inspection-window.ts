// Scelta della finestra di ispezione: [intervalStart, intervalEnd].
//
// Estratta da inspection-pipeline.ts (esperimento #21, P3) cosi' che l'app e il
// replay del banco di prova eseguano ESATTAMENTE lo stesso codice. Pura e
// senza dipendenze dal browser: la scansione dei fotogrammi arriva da una
// funzione passata dal chiamante.
//
// Due stadi, come in produzione:
//   1. eventi -> segmentazione -> intervalStart e searchEnd;
//   2. scansione stretta [intervalStart, searchEnd] -> fine dell'ispezione.
//
// Flag solo-bench `globalThis.__benchWindowRobust` (come
// __benchGridAlignmentThreshold): spento di default, e con il flag spento il
// comportamento e' identico bit a bit a quello precedente (test in
// inspection-window.test.ts). Le varianti dell'esperimento #21 si agganciano
// qui; finche' non esistono, un flag acceso fallisce forte invece di essere
// ignorato in silenzio.

import {
  inferInspectionEnd,
  inferVideoSegmentation,
  lastInspectionFrameTime,
  type MotionEvent,
  type MotionSample,
  type SolveWindow,
} from './video-decoder.ts';

/** Solo cio' che inferInspectionEnd legge: tempo e griglie-colore osservate. */
export type BoundaryScanSample = Pick<MotionSample, 'time' | 'faceGrids'>;

export interface InspectionWindowPlan {
  intervalStart: number;
  segmentationHint: number | null;
  searchEnd: number;
  stageCount: number;
  windowCount: number;
  /** Finestra di solve scelta dalla segmentazione, per chi ne ha bisogno (pipeline). */
  solveWindow: SolveWindow | null;
}

export interface InspectionWindow {
  intervalStart: number;
  segmentationHint: number | null;
  searchEnd: number;
  boundaryTime: number;
  boundarySource: string;
  intervalEnd: number;
  stageCount: number;
  windowCount: number;
}

/** Valore del flag solo-bench; undefined in produzione. */
export function readWindowRobustFlag(): unknown {
  return (globalThis as { __benchWindowRobust?: unknown }).__benchWindowRobust;
}

function assertRobustVariantsOff(): void {
  const flag = readWindowRobustFlag();
  if (flag === undefined || flag === null || flag === false || flag === 'off') return;
  throw new Error(`__benchWindowRobust=${String(flag)}: variante non implementata (esperimento #21, P3: solo il flag spento)`);
}

/** Stadio 1: dagli eventi a (intervalStart, searchEnd). */
export function planInspectionWindow(events: MotionEvent[], duration: number): InspectionWindowPlan {
  assertRobustVariantsOff();
  const segmentation = inferVideoSegmentation(events, 0, duration);
  const solveWindow = segmentation.windows.find((window) => window.id === segmentation.defaultWindowId) ?? null;
  const inspectionStage = solveWindow?.stages.find((stage) => stage.kind === 'inspection');
  const automaticStart = inspectionStage?.start ?? 0;
  const intervalStart = Math.max(0, Math.min(automaticStart, duration - 0.5));
  const segmentationHint = inspectionStage?.end ?? solveWindow?.start ?? null;
  const baseSearchEnd = Math.min(duration, Math.max(8, Math.min(25, duration * 0.72)));
  const hintedSearchEnd = segmentationHint && segmentationHint >= intervalStart + 2
    ? Math.min(duration, segmentationHint + 3)
    : intervalStart;
  return {
    intervalStart,
    segmentationHint,
    searchEnd: Math.max(baseSearchEnd, hintedSearchEnd),
    stageCount: solveWindow?.stages.length ?? 0,
    windowCount: segmentation.windows.length,
    solveWindow,
  };
}

/** Stadio 2: dalla scansione stretta alla fine dell'ispezione. */
export function finishInspectionWindow(
  plan: InspectionWindowPlan,
  events: MotionEvent[],
  scan: BoundaryScanSample[],
  duration: number,
): InspectionWindow {
  assertRobustVariantsOff();
  // inferInspectionEnd legge soltanto time e faceGrids dei campioni.
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

export interface ComputeInspectionWindowInput<S extends BoundaryScanSample> {
  events: MotionEvent[];
  duration: number;
  /** Scansiona i fotogrammi in [start, end]: nel browser e' scanInspectionFrames. */
  scan: (start: number, end: number) => Promise<S[]>;
}

export interface ComputeInspectionWindowResult<S extends BoundaryScanSample> {
  plan: InspectionWindowPlan;
  /** La scansione stretta usata, riutilizzabile dal chiamante per i campioni dell'ispezione. */
  scan: S[];
  window: InspectionWindow;
}

export async function computeInspectionWindow<S extends BoundaryScanSample>(
  input: ComputeInspectionWindowInput<S>,
): Promise<ComputeInspectionWindowResult<S>> {
  const plan = planInspectionWindow(input.events, input.duration);
  const scan = await input.scan(plan.intervalStart, plan.searchEnd);
  const window = finishInspectionWindow(plan, input.events, scan, input.duration);
  return { plan, scan, window };
}
