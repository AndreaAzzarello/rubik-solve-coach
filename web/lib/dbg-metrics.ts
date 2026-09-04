/**
 * STRUMENTAZIONE DIAGNOSTICA TEMPORANEA — pipeline di lettura colore.
 *
 * Tutto è dietro il flag `DBG`. Con il flag spento il costo è solo un check
 * booleano (nessuna allocazione, nessun conteggio). Da rimuovere insieme alle
 * righe taggate `// DBG` in:
 *   - lib/color-calibration.ts   (motivi di scarto pixel + soglie per-frame)
 *   - lib/video-decoder.ts       (componenti, griglie "pairs", silhouette, frame)
 *   - lib/inspection-state.ts    (fusione multi-frame, esito ricostruzione)
 *
 * ATTIVAZIONE
 *   browser  →  in console:  localStorage.setItem('DBG','1')  e ricarica
 *              oppure, senza reload:  globalThis.DBG = true   (prima di "Analizza")
 *   build    →  NEXT_PUBLIC_DBG=1   o   DBG=1
 *
 * RISULTATI
 *   Al termine di ogni analisi: console.table automatica in console
 *   + snapshot su  window.__DBG_COLOR_METRICS__  (da incollare per l'analisi).
 */

const truthy = (value: unknown) =>
  value === true || value === 1 || value === '1' || value === 'true';

export const DBG: boolean = (() => {
  try {
    if (
      typeof process !== 'undefined' && process.env
      && (truthy(process.env.DBG) || truthy(process.env.NEXT_PUBLIC_DBG))
    ) return true;
  } catch { /* `process` non definito nel browser */ }
  try {
    if (typeof globalThis !== 'undefined' && truthy((globalThis as { DBG?: unknown }).DBG)) return true;
  } catch { /* noop */ }
  try {
    if (typeof localStorage !== 'undefined' && truthy(localStorage.getItem('DBG'))) return true;
  } catch { /* localStorage non accessibile (SSR / privacy) */ }
  return false;
})();

type Counter = Record<string, number>;

export type DbgMetrics = {
  /** Frame-canvas dai quali si cercano le griglie 3×3 (scansione ad alta risoluzione). */
  framesInspection: number;
  /** Frame-canvas della sola passata movimento/pause (non cercano griglie). */
  framesMotion: number;

  /** 1. Esito della closure di `createAdaptiveColorClassifier`, solo frame ispezione. */
  pixelClass: Counter; // dark | whiteGrey | chromaFloor | colorDistance | passed
  /** 2. Promozione pixel → label in `frameSignature` (gate confidence ≥ 0.16). */
  pixelLabel: Counter; // labelled | lowConfidence
  /** 3. Soglie per-frame effettivamente risolte (una entry per crop). */
  thresholds: { chromaFloor: number[]; whiteFloor: number[]; darkFloor: number[] };

  /** 4. `stickerComponents`: blob scartati dal filtro di forma. */
  components: Counter; // kept | tooSmall | tooLarge | aspect | fill
  /** 5. `detectFaceGrids` via "pairs": ipotesi 3×3 scartate. */
  pairsGrid: Counter; // kept | rejVisibleCells | rejCenterMismatch | rejGeometry
  /** 6. `detectCubeFaceQuads` (silhouette esagonale): motivo di uscita. */
  silhouette: Counter; // built | fewComponents | fewPlausible | fewCluster
  //                      | hullTooSmall | notHexagon | areaGate | scaleGate | spreadGate

  /** 7a. Fusione multi-frame: voti per singola cella. */
  fusionCell: Counter; // accepted | rejVoteSplit | rejWeakSingleFrame
  /** 7b. Fusione multi-frame: allineamento fra letture di frame diversi. */
  fusionAlign: Counter; // accepted | rejIncoherent

  /** 8. Esito di `reconstructInspectionState`. */
  reconstruct: {
    droppedLowVisible: number;
    observationsIn: number;
    bestObserved: number;
    inferredFacelets: number;
    candidateCount: number;
    sawTruncation: boolean;
    status: string;
  };
  /** Extra: calibrazione centri + classificazione bilanciata a capacità fissa. */
  balanced: {
    calibratedCenters: number;
    ran: boolean;
    observedCells: number;
    usable: boolean;
  };
};

const zero = (): DbgMetrics => ({
  framesInspection: 0,
  framesMotion: 0,
  pixelClass: { dark: 0, whiteGrey: 0, chromaFloor: 0, colorDistance: 0, passed: 0 },
  pixelLabel: { labelled: 0, lowConfidence: 0 },
  thresholds: { chromaFloor: [], whiteFloor: [], darkFloor: [] },
  components: { kept: 0, tooSmall: 0, tooLarge: 0, aspect: 0, fill: 0 },
  pairsGrid: { kept: 0, rejVisibleCells: 0, rejCenterMismatch: 0, rejGeometry: 0 },
  silhouette: {
    built: 0, fewComponents: 0, fewPlausible: 0, fewCluster: 0,
    hullTooSmall: 0, notHexagon: 0, areaGate: 0, scaleGate: 0, spreadGate: 0,
  },
  fusionCell: { accepted: 0, rejVoteSplit: 0, rejWeakSingleFrame: 0 },
  fusionAlign: { accepted: 0, rejIncoherent: 0 },
  reconstruct: {
    droppedLowVisible: 0, observationsIn: 0, bestObserved: 0,
    inferredFacelets: 0, candidateCount: 0, sawTruncation: false, status: '',
  },
  balanced: { calibratedCenters: 0, ran: false, observedCells: 0, usable: false },
});

export const dbg: DbgMetrics = zero();

/**
 * Fase del frame attualmente in elaborazione. `createAdaptiveColorClassifier` e
 * `stickerComponents` girano anche nella passata movimento: i contatori a
 * livello di pixel/blob li ignorano guardando questo flag.
 */
export const dbgState: { framePhase: 'inspection' | 'motion' } = { framePhase: 'motion' };

export function resetDbgMetrics() {
  if (!DBG) return;
  Object.assign(dbg, zero());
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

const stats = (values: number[]) => {
  if (!values.length) return { n: 0, min: 0, median: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    min: round3(sorted[0]),
    median: round3(sorted[Math.floor((sorted.length - 1) / 2)]),
    max: round3(sorted[sorted.length - 1]),
  };
};

const withShare = (counter: Counter) => {
  const total = Object.values(counter).reduce((sum, value) => sum + value, 0);
  return Object.fromEntries(
    Object.entries(counter).map(([key, value]) => [
      key,
      { count: value, share: total > 0 ? `${Math.round((value / total) * 1000) / 10}%` : '—' },
    ]),
  );
};

/** Costruisce lo snapshot, lo stampa in console e lo espone su window. */
export function dumpDbgMetrics(context: string) {
  if (!DBG) return null;

  const pl = dbg.pixelLabel;
  const snapshot = {
    context,
    frames: { inspection: dbg.framesInspection, motion: dbg.framesMotion },
    pixelClass: withShare(dbg.pixelClass),
    pixelLabel: {
      labelled: pl.labelled,
      lowConfidence: pl.lowConfidence,
      lowConfidenceShare: pl.labelled + pl.lowConfidence > 0
        ? `${Math.round((pl.lowConfidence / (pl.labelled + pl.lowConfidence)) * 1000) / 10}%`
        : '—',
    },
    thresholds: {
      chromaFloor: stats(dbg.thresholds.chromaFloor),
      whiteFloor: stats(dbg.thresholds.whiteFloor),
      darkFloor: stats(dbg.thresholds.darkFloor),
    },
    components: withShare(dbg.components),
    pairsGrid: withShare(dbg.pairsGrid),
    silhouette: { ...dbg.silhouette },
    fusionCell: withShare(dbg.fusionCell),
    fusionAlign: withShare(dbg.fusionAlign),
    reconstruct: { ...dbg.reconstruct },
    balanced: { ...dbg.balanced },
  };

  /* eslint-disable no-console */
  console.groupCollapsed(`[DBG] pipeline colore — ${context}`);
  console.log('frame:', snapshot.frames);
  console.log('1. classificazione pixel (motivo di scarto):');
  console.table(snapshot.pixelClass);
  console.log('2. pixel → label:', snapshot.pixelLabel);
  console.log('3. soglie per-frame risolte:');
  console.table(snapshot.thresholds);
  console.log('4. stickerComponents (forma):');
  console.table(snapshot.components);
  console.log('5. griglie "pairs":');
  console.table(snapshot.pairsGrid);
  console.log('6. silhouette esagonale (detectCubeFaceQuads):', snapshot.silhouette);
  console.log('7. fusione — celle:');
  console.table(snapshot.fusionCell);
  console.log('7. fusione — allineamenti:', snapshot.fusionAlign);
  console.log('8. reconstruct:', snapshot.reconstruct);
  console.log('extra. balanced:', snapshot.balanced);
  console.groupEnd();
  /* eslint-enable no-console */

  try {
    (globalThis as { __DBG_COLOR_METRICS__?: unknown }).__DBG_COLOR_METRICS__ = snapshot;
  } catch { /* noop */ }
  return snapshot;
}
