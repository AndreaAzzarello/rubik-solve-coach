// Worker per l'esperimento #14 (vedi docs/pipeline-experiments.md): esegue
// UNA chiamata a reconstructInspectionState (funzione pura, nessun browser)
// con un moltiplicatore di budget dato, in un thread separato cosi' il
// genitore puo' imporre un timeout reale (worker.terminate()) anche se la
// ricerca non terminasse mai da sola - reconstructInspectionState e'
// sincrona, un timeout lato chiamante non la interromperebbe altrimenti.

import { parentPort, workerData } from 'node:worker_threads';
import { reconstructInspectionState, type FaceGridObservation, type PartialFacelets } from '../lib/inspection-state.ts';

type WorkerInput = {
  observations: FaceGridObservation[];
  balancedInfo: { observedCells: number; usable: boolean };
  multiplier: number;
};

const { observations, balancedInfo, multiplier } = workerData as WorkerInput;

(globalThis as unknown as Record<string, unknown>).__benchBudgetMultiplier = multiplier;
(globalThis as unknown as Record<string, unknown>).__benchCandidateStatesDiag = [];
(globalThis as unknown as Record<string, unknown>).__benchBudgetTelemetry = {};

const startedAt = performance.now();
const result = reconstructInspectionState(observations, balancedInfo);
const elapsedMs = performance.now() - startedAt;
const candidates = ((globalThis as unknown as Record<string, unknown>).__benchCandidateStatesDiag ?? []) as PartialFacelets[];
const budgetTelemetry = (globalThis as unknown as Record<string, unknown>).__benchBudgetTelemetry;

parentPort?.postMessage({
  candidateCount: result.candidateCount,
  truncated: result.truncated,
  candidates,
  budgetTelemetry,
  elapsedMs,
});
