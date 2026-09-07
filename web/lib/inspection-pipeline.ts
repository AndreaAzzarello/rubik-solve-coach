// Orchestrazione della ricostruzione dello stato iniziale a partire da un video.
//
// Questo modulo e' l'UNICO punto in cui vive la sequenza completa
// (moto -> segmentazione -> confine ispezione -> fusione fotogrammi ->
// ricostruzione). La usa la pagina principale e la usa il banco di prova
// (`bench/`), cosi' il punteggio misura sempre esattamente il percorso reale.
//
// Dipende dal browser: `HTMLVideoElement` con seek e un canvas 2D per estrarre
// i pixel dai fotogrammi.

import {
  decodeVideoMotion,
  inferInspectionEnd,
  inferVideoSegmentation,
  lastInspectionFrameTime,
  scanInspectionFrames,
  summarizeCubeObservation,
  type CubeObservationSummary,
  type MotionSample,
} from './video-decoder.ts';

export type InspectionRunPhase = 'motion' | 'boundary' | 'frames' | 'fusing';

export type InspectionRunResult = {
  summary: CubeObservationSummary;
  samples: MotionSample[];
  runCount: number;
  interval: { start: number; end: number };
};

export type InspectionRunOptions = {
  /** Campioni di analisi precedenti da riusare in una rianalisi incrementale. */
  priorSamples?: MotionSample[];
  /** Numero di passate gia' completate (usato per variare la fase di campionamento). */
  priorRunCount?: number;
  /** Quante passate di fusione extra tentare finche' lo stato non e' completo. */
  maxFusionPasses?: number;
  onProgress?: (value: number) => void;
  onPhase?: (phase: InspectionRunPhase) => void;
  /** Se ritorna true durante una fase asincrona, l'esecuzione si interrompe e ritorna null. */
  shouldCancel?: () => boolean;
};

export async function reconstructInspectionFromVideo(
  video: HTMLVideoElement,
  options: InspectionRunOptions = {},
): Promise<InspectionRunResult | null> {
  const priorSamples = options.priorSamples ?? [];
  const reanalysis = priorSamples.length > 0;
  const maxFusionPasses = options.maxFusionPasses ?? 1;
  const cancelled = () => options.shouldCancel?.() ?? false;

  let combinedSamples: MotionSample[] = reanalysis ? [...priorSamples] : [];
  let completedRuns = options.priorRunCount ?? 0;

  options.onPhase?.('motion');
  video.pause();

  const decoded = await decodeVideoMotion(video, {
    startTime: 0,
    endTime: video.duration,
    analysisPass: completedRuns,
    onProgress: (value) => options.onProgress?.(value * 0.34),
  });
  if (cancelled()) return null;

  const segmentation = inferVideoSegmentation(decoded.events, 0, video.duration);
  const solveWindow = segmentation.windows.find((window) => window.id === segmentation.defaultWindowId);
  const inspectionStage = solveWindow?.stages.find((stage) => stage.kind === 'inspection');
  const automaticStart = inspectionStage?.start ?? 0;
  const intervalStart = Math.max(0, Math.min(automaticStart, video.duration - 0.5));
  const segmentationHint = inspectionStage?.end ?? solveWindow?.start ?? null;
  const baseSearchEnd = Math.min(
    video.duration,
    Math.max(8, Math.min(25, video.duration * 0.72)),
  );
  const hintedSearchEnd = segmentationHint && segmentationHint >= intervalStart + 2
    ? Math.min(video.duration, segmentationHint + 3)
    : intervalStart;
  const searchEnd = Math.max(baseSearchEnd, hintedSearchEnd);

  options.onPhase?.('boundary');
  const boundarySamples = await scanInspectionFrames(video, intervalStart, searchEnd, {
    analysisPass: completedRuns,
    onProgress: (value) => options.onProgress?.(0.34 + value * 0.34),
  });
  if (cancelled()) return null;

  const boundary = inferInspectionEnd(
    boundarySamples,
    decoded.events,
    intervalStart,
    searchEnd,
    segmentationHint,
  );
  const firstCubeChange = Math.max(intervalStart + 0.5, boundary.time);
  const intervalEnd = Math.max(
    intervalStart + 0.5,
    Math.min(lastInspectionFrameTime(intervalStart, firstCubeChange, 60), video.duration),
  );
  const interval = { start: intervalStart, end: intervalEnd };

  const automaticInspectionSamples = boundarySamples.filter((sample) => sample.time <= intervalEnd);
  combinedSamples = reanalysis
    ? [...combinedSamples, ...automaticInspectionSamples]
    : automaticInspectionSamples;
  completedRuns += 1;
  let latestSummary = summarizeCubeObservation(combinedSamples, intervalStart, intervalEnd);

  options.onPhase?.('frames');
  for (let pass = 0; pass < maxFusionPasses && latestSummary.reconstruction.status !== 'complete'; pass += 1) {
    const scanned = await scanInspectionFrames(video, intervalStart, intervalEnd, {
      analysisPass: completedRuns,
      onProgress: (value) => options.onProgress?.(0.68 + ((pass + value) / maxFusionPasses) * 0.28),
    });
    if (cancelled()) return null;
    combinedSamples = [...combinedSamples, ...scanned];
    completedRuns += 1;
    latestSummary = summarizeCubeObservation(combinedSamples, intervalStart, intervalEnd);
    if (latestSummary.reconstruction.status === 'complete') break;
  }

  if (!latestSummary.reconstruction.observedFaces.length) {
    latestSummary = summarizeCubeObservation(
      [...combinedSamples, ...decoded.samples],
      intervalStart,
      intervalEnd,
    );
  }

  options.onPhase?.('fusing');
  options.onProgress?.(0.98);

  return {
    summary: latestSummary,
    samples: combinedSamples,
    runCount: completedRuns,
    interval,
  };
}
