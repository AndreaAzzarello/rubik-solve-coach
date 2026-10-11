'use client';

// Pagina-harness del banco di prova. Non fa parte del prodotto: espone
// `window.__benchReconstruct(videoUrl)` che esegue la STESSA pipeline della
// pagina principale (`reconstructInspectionFromVideo`) su un video dato e
// restituisce lo schema ricostruito in forma serializzabile.
//
// Il punteggio (confronto con lo scramble noto) NON avviene qui: lo calcola
// `bench/lib/score.ts` in Node, cosi' resta puro e testato a parte.

import { useEffect, useRef, useState } from 'react';
import type { CubeColor, Face } from '../../lib/cube';
import { reconstructInspectionFromVideo } from '../../lib/inspection-pipeline';
import type { BenchBudgetTelemetry, BenchChoicesDiag, BenchFaceObservationDiag, BenchStableRawDiag, FaceGridObservation, PartialFacelets } from '../../lib/inspection-state';
import type { MotionSample } from '../../lib/video-decoder';

type ColorPresence = { maxInsideWindow: number; maxBeforeWindow: number; samplesBeforeWindow: number };

type BenchResult = {
  ok: boolean;
  status?: string;
  message?: string;
  confidence?: number;
  observedFaces?: Face[];
  facelets?: Record<Face, Array<CubeColor | null>>;
  completeFacelets?: Record<Face, CubeColor[]> | null;
  cellConfidence?: Record<Face, number[]>;
  interval?: { start: number; end: number };
  runCount?: number;
  durationMs?: number;
  error?: string;
  // Diagnostica esperimento #12 (vedi bench/missing-cells-diagnosis.ts):
  // presenti solo quando la pagina bench ha predisposto i rispettivi global
  // PRIMA della chiamata (stesso schema lazy di __benchGridAlignmentTally).
  faceCoverage?: Record<Face, { observedCells: number; status: string }>;
  faceObservationDiag?: Record<Face, BenchFaceObservationDiag>;
  gridAlignmentSafeguardColors?: CubeColor[];
  stableRawDiag?: Record<Face, BenchStableRawDiag>;
  choicesDiag?: BenchChoicesDiag;
  partialDiag?: { bestObservedPartial: PartialFacelets; bestPartial: PartialFacelets };
  modelGateAttempts?: Record<string, { attempts: number; passed: number }>;
  candidateCount?: number;
  truncated?: boolean;
  coverage?: Record<CubeColor, number>;
  detectedColors?: CubeColor[];
  videoDuration?: number;
  colorPresence?: Record<CubeColor, ColorPresence>;
  // Diagnostica esperimento #13 (vedi bench/beam-ambiguity-photometric.ts).
  candidateStates?: PartialFacelets[];
  alignmentFilteredObservations?: FaceGridObservation[];
  // Diagnostica approfondimento esperimento #13 (vedi bench/beam-truncation-check.ts).
  observationsDiag?: { observations: FaceGridObservation[]; balancedInfo: { observedCells: number; usable: boolean } };
  // Diagnostica esperimento #14 (vedi bench/beam-budget-check.ts).
  budgetTelemetry?: BenchBudgetTelemetry;
};

declare global {
  interface Window {
    __benchReconstruct?: (videoUrl: string) => Promise<BenchResult>;
    __benchReady?: boolean;
    __benchFaceObservationDiag?: Record<Face, BenchFaceObservationDiag>;
    __benchGridAlignmentSafeguardColors?: CubeColor[];
    __benchStableRawDiag?: Record<Face, BenchStableRawDiag>;
    __benchChoicesDiag?: BenchChoicesDiag;
    __benchPartialDiag?: { bestObservedPartial: PartialFacelets; bestPartial: PartialFacelets };
    __benchModelGateAttempts?: Record<string, { attempts: number; passed: number }>;
    __benchCandidateStatesDiag?: PartialFacelets[];
    __benchAlignmentFilteredObservations?: FaceGridObservation[];
    __benchObservationsDiag?: { observations: FaceGridObservation[]; balancedInfo: { observedCells: number; usable: boolean } };
    __benchBudgetTelemetry?: BenchBudgetTelemetry;
    __benchBudgetMultiplier?: number;
  }
}

const CUBE_COLORS_LOCAL: CubeColor[] = ['white', 'red', 'green', 'yellow', 'orange', 'blue'];

// Diagnosi #12, parte C: presenza del colore (segnale fotometrico grezzo
// gia' calcolato dalla prima passata su TUTTO il video, lib/video-decoder.ts
// decodeVideoMotion) dentro la finestra di ispezione individuata vs PRIMA
// che la finestra inizi - per distinguere "finestra sbagliata" da "non
// rilevata"/"scartata dal gate" (quelle due si misurano con
// __benchModelGateAttempts, qui serve solo a vedere se il colore era
// altrove visibile).
function computeColorPresence(
  samples: MotionSample[],
  interval: { start: number; end: number },
): Record<CubeColor, ColorPresence> {
  const presence = Object.fromEntries(CUBE_COLORS_LOCAL.map((color) => (
    [color, { maxInsideWindow: 0, maxBeforeWindow: 0, samplesBeforeWindow: 0 }]
  ))) as Record<CubeColor, ColorPresence>;
  samples.forEach((sample) => {
    if (!sample.visibleColors) return;
    const bucket = sample.time < interval.start ? 'maxBeforeWindow'
      : sample.time <= interval.end ? 'maxInsideWindow'
        : null;
    if (!bucket) return;
    CUBE_COLORS_LOCAL.forEach((color) => {
      const value = sample.visibleColors?.[color] ?? 0;
      if (value > presence[color][bucket]) presence[color][bucket] = value;
    });
    if (bucket === 'maxBeforeWindow') {
      CUBE_COLORS_LOCAL.forEach((color) => { presence[color].samplesBeforeWindow += 1; });
    }
  });
  return presence;
}

function waitForVideoReady(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error('timeout nel caricamento del video (nessun canplay entro 60s)'));
    }, 60000);
    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener('canplay', onReady);
      video.removeEventListener('loadeddata', onReady);
      video.removeEventListener('error', onError);
    };
    const onReady = () => {
      if (video.readyState >= 2 && Number.isFinite(video.duration) && video.duration > 0) {
        cleanup();
        resolve();
      }
    };
    const onError = () => {
      cleanup();
      reject(new Error(`il browser non riesce a decodificare il video (${video.error?.message ?? 'errore sconosciuto'})`));
    };
    video.addEventListener('canplay', onReady);
    video.addEventListener('loadeddata', onReady);
    video.addEventListener('error', onError);
    onReady();
  });
}

export default function BenchHarness() {
  const stageRef = useRef<HTMLDivElement>(null);
  const [log, setLog] = useState<string[]>(['harness pronta']);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const append = (line: string) => setLog((current) => [...current, line]);

    window.__benchReconstruct = async (videoUrl: string): Promise<BenchResult> => {
      setBusy(true);
      const startedAt = performance.now();
      const video = document.createElement('video');
      video.crossOrigin = 'anonymous';
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
      video.controls = false;
      video.style.width = '320px';
      video.style.opacity = '0';
      video.style.pointerEvents = 'none';
      video.src = videoUrl;
      stageRef.current?.appendChild(video);
      append(`carico ${videoUrl}`);

      try {
        await waitForVideoReady(video);
        append(`video pronto: ${video.videoWidth}x${video.videoHeight}, ${video.duration.toFixed(2)}s`);

        const result = await reconstructInspectionFromVideo(video, {
          onPhase: (phase) => append(`fase: ${phase}`),
        });
        if (!result) return { ok: false, error: 'pipeline annullata' };

        const reconstruction = result.summary.reconstruction;
        append(`stato: ${reconstruction.status} · facce ${reconstruction.observedFaces.length}/6`);
        const faceCoverage = Object.fromEntries(
          Object.entries(reconstruction.faceCoverage).map(([face, coverage]) => (
            [face, { observedCells: coverage.observedCells, status: coverage.status }]
          )),
        ) as Record<Face, { observedCells: number; status: string }>;
        return {
          ok: true,
          status: reconstruction.status,
          message: reconstruction.message,
          confidence: result.summary.confidence,
          observedFaces: reconstruction.observedFaces,
          facelets: reconstruction.facelets,
          completeFacelets: reconstruction.completeFacelets,
          cellConfidence: reconstruction.cellConfidence,
          interval: result.interval,
          runCount: result.runCount,
          durationMs: Math.round(performance.now() - startedAt),
          faceCoverage,
          faceObservationDiag: window.__benchFaceObservationDiag,
          gridAlignmentSafeguardColors: window.__benchGridAlignmentSafeguardColors,
          stableRawDiag: window.__benchStableRawDiag,
          choicesDiag: window.__benchChoicesDiag,
          partialDiag: window.__benchPartialDiag,
          modelGateAttempts: window.__benchModelGateAttempts,
          candidateCount: reconstruction.candidateCount,
          truncated: reconstruction.truncated,
          coverage: result.summary.coverage,
          detectedColors: result.summary.detectedColors,
          videoDuration: video.duration,
          colorPresence: computeColorPresence(result.motionSamples, result.interval),
          candidateStates: window.__benchCandidateStatesDiag,
          alignmentFilteredObservations: window.__benchAlignmentFilteredObservations,
          observationsDiag: window.__benchObservationsDiag,
          budgetTelemetry: window.__benchBudgetTelemetry,
        };
      } catch (caught) {
        const error = caught instanceof Error ? caught.message : String(caught);
        append(`errore: ${error}`);
        return { ok: false, error, durationMs: Math.round(performance.now() - startedAt) };
      } finally {
        video.removeAttribute('src');
        video.load();
        video.remove();
        setBusy(false);
      }
    };

    window.__benchReady = true;
    append('window.__benchReconstruct registrata');

    return () => {
      delete window.__benchReconstruct;
      window.__benchReady = false;
    };
  }, []);

  return (
    <main style={{ fontFamily: 'ui-monospace, monospace', padding: 24, maxWidth: 900 }}>
      <h1 style={{ fontSize: 16, fontWeight: 800 }}>Bench harness · ricostruzione stato cubo</h1>
      <p style={{ fontSize: 12, color: '#64748b' }}>
        Pagina interna di test. Il driver <code>bench/run-bench.mjs</code> chiama{' '}
        <code>window.__benchReconstruct(url)</code>. Stato: {busy ? 'in esecuzione…' : 'inattiva'}.
      </p>
      <div ref={stageRef} aria-hidden />
      <pre
        data-testid="bench-log"
        style={{
          marginTop: 16,
          padding: 12,
          background: '#0f172a',
          color: '#e2e8f0',
          borderRadius: 8,
          fontSize: 11,
          lineHeight: 1.6,
          whiteSpace: 'pre-wrap',
        }}
      >
        {log.join('\n')}
      </pre>
    </main>
  );
}
