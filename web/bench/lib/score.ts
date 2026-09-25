// Punteggio ripetibile per la ricostruzione dello stato del cubo.
//
// Confronto NON ottimistico:
//  - i due lati sono gia' nella convenzione canonica (centri bianco/rosso/verde/
//    giallo/arancio/blu su U/R/F/D/L/B), quindi il punteggio ufficiale e' un
//    diff diretto casella-per-casella con allineamento IDENTITA'. Nessuna
//    ricerca di rotazione, nessun rimappaggio colore per faccia.
//  - il "best su 24 rotazioni di cubo intero" e' calcolato solo come DIAGNOSI di
//    un eventuale offset di orientamento sistematico: non e' mai il punteggio.
//    Non viene mai fatta una rotazione indipendente per faccia (sarebbe il
//    trucco che nasconde gli errori veri).

import {
  CUBE_COLORS,
  CUBE_FACES,
  CubeState,
  parseAlgorithm,
  type CubeColor,
  type Face,
} from '../../lib/cube.ts';
import { HIGH_CONFIDENCE_THRESHOLD } from '../../lib/inspection-state.ts';

export type FaceletMap = Record<Face, Array<CubeColor | null>>;
export type CompleteFaceletMap = Record<Face, CubeColor[]>;
export type CellConfidenceMap = Record<Face, number[]>;

// Soglia "alta confidenza" per la metrica di calibrazione (vedi
// ConfidenceMetric sotto): riesportata per compatibilita', ma definita una
// sola volta in web/lib/inspection-state.ts, la stessa che usa anche
// l'interfaccia di correzione manuale — cosi' "alta confidenza" significa la
// stessa cosa nel bench e nel prodotto.
export { HIGH_CONFIDENCE_THRESHOLD };

// 24 orientamenti del cubo (6 scelte di faccia in alto x 4 rotazioni attorno
// all'asse verticale). Servono solo alla diagnosi dell'offset sistematico.
const ROTATION_ALGS: string[] = [
  '', 'y', 'y2', "y'",
  'x', 'x y', 'x y2', "x y'",
  "x'", "x' y", "x' y2", "x' y'",
  'x2', 'x2 y', 'x2 y2', "x2 y'",
  'z', 'z y', 'z y2', "z y'",
  "z'", "z' y", "z' y2", "z' y'",
];

const CENTER_INDEX = 4;

const FLAT: Array<[Face, number]> = CUBE_FACES.flatMap(
  (face) => [0, 1, 2, 3, 4, 5, 6, 7, 8].map((index) => [face, index] as [Face, number]),
);

export function referenceFromScramble(scramble: string): CompleteFaceletMap {
  const moves = parseAlgorithm(scramble);
  return CubeState.solved().applyMoves(moves).faceletRecord();
}

// Permutazioni dei 54 indici per i 24 orientamenti di cubo intero, ricavate
// dalla geometria reale di CubeState (una casella "accesa" per volta, ruotata,
// e si registra dove finisce). Servono a diagnosticare un offset di
// orientamento SISTEMATICO anche su ricostruzioni parziali.
function buildOrientationPermutations(): number[][] {
  const probe = (lit: number): CompleteFaceletMap => {
    const map = Object.fromEntries(
      CUBE_FACES.map((face) => [face, Array<CubeColor>(9).fill('white')]),
    ) as CompleteFaceletMap;
    const [face, index] = FLAT[lit];
    map[face][index] = 'red';
    return map;
  };
  return ROTATION_ALGS.map((alg) => {
    const perm = Array<number>(54).fill(-1);
    for (let src = 0; src < 54; src += 1) {
      const rotated = alg
        ? CubeState.fromFacelets(probe(src)).applyMoves(parseAlgorithm(alg)).faceletRecord()
        : probe(src);
      for (let dest = 0; dest < 54; dest += 1) {
        const [face, index] = FLAT[dest];
        if (rotated[face][index] === 'red') {
          perm[dest] = src;
          break;
        }
      }
    }
    return perm;
  });
}

let orientationPermutations: number[][] | null = null;
function getOrientationPermutations(): number[][] {
  if (!orientationPermutations) orientationPermutations = buildOrientationPermutations();
  return orientationPermutations;
}

function flatten(map: FaceletMap | CompleteFaceletMap): Array<CubeColor | null> {
  return FLAT.map(([face, index]) => map[face][index] ?? null);
}

function correctAgainstReference(
  candidateFlat: Array<CubeColor | null>,
  referenceFlat: CubeColor[],
): number {
  let correct = 0;
  for (let i = 0; i < 54; i += 1) {
    if (candidateFlat[i] !== null && candidateFlat[i] === referenceFlat[i]) correct += 1;
  }
  return correct;
}

function countEqual(
  candidate: FaceletMap | CompleteFaceletMap,
  reference: CompleteFaceletMap,
  options: { includeCenters: boolean },
): { correct: number; committed: number; total: number } {
  let correct = 0;
  let committed = 0;
  let total = 0;
  for (const face of CUBE_FACES) {
    for (let index = 0; index < 9; index += 1) {
      if (!options.includeCenters && index === CENTER_INDEX) continue;
      total += 1;
      const got = candidate[face][index] ?? null;
      if (got === null) continue;
      committed += 1;
      if (got === reference[face][index]) correct += 1;
    }
  }
  return { correct, committed, total };
}

function colorHistogram(map: FaceletMap | CompleteFaceletMap): Record<string, number> {
  const histogram: Record<string, number> = { unknown: 0 };
  for (const color of CUBE_COLORS) histogram[color] = 0;
  for (const face of CUBE_FACES) {
    for (let index = 0; index < 9; index += 1) {
      const color = map[face][index] ?? null;
      histogram[color ?? 'unknown'] += 1;
    }
  }
  return histogram;
}

export type FaceScore = {
  face: Face;
  correct: number;
  committed: number;
  mismatches: Array<{ index: number; expected: CubeColor; got: CubeColor | null }>;
};

export type OrientationDiagnostic = {
  available: boolean;
  reason?: string;
  // caselle giuste (allineamento identita') contate allo stesso modo del confronto
  // usato qui: solo celle valorizzate, contro lo stato reale.
  identityCorrect: number;
  bestCorrect: number;
  bestRotation: string;
  // true quando una rotazione di cubo intero batte l'identita' di un margine
  // netto: indica un bug di orientamento sistematico da correggere nel codice.
  systematicOffsetSuspected: boolean;
};

export type ConfidenceMetric = {
  threshold: number;
  // celle impegnate (colore non nullo), non centrali, con confidenza >= soglia
  highConfidenceTotal: number;
  highConfidenceCorrect: number;
  // il caso peggiore: sbagliata ma data per certa dall'app
  highConfidenceWrong: number;
  highConfidencePrecision: number; // highConfidenceCorrect / highConfidenceTotal
  // celle impegnate, non centrali, con confidenza < soglia (incluse quelle a
  // confidenza 0: dedotte dai vincoli dei pezzi o da un consenso fra piu'
  // stati candidati, mai una lettura fotometrica diretta)
  lowConfidenceTotal: number;
  lowConfidenceCorrect: number;
  // errori che l'utente vedrebbe segnalati come incerti: il costo previsto
  lowConfidenceWrong: number;
  // distribuzione grezza delle confidenze sulle celle impegnate non centrali,
  // per giudicare se la soglia scelta separa davvero due popolazioni o taglia
  // a caso in mezzo a una sola
  histogram: Array<{ from: number; to: number; count: number }>;
};

function emptyConfidenceMetric(threshold: number): ConfidenceMetric {
  return {
    threshold,
    highConfidenceTotal: 0,
    highConfidenceCorrect: 0,
    highConfidenceWrong: 0,
    highConfidencePrecision: 0,
    lowConfidenceTotal: 0,
    lowConfidenceCorrect: 0,
    lowConfidenceWrong: 0,
    histogram: [],
  };
}

function scoreConfidenceCalibration(
  facelets: FaceletMap,
  cellConfidence: CellConfidenceMap | undefined,
  reference: CompleteFaceletMap,
  threshold: number,
): ConfidenceMetric {
  if (!cellConfidence) return emptyConfidenceMetric(threshold);
  let highTotal = 0;
  let highCorrect = 0;
  let lowTotal = 0;
  let lowCorrect = 0;
  const bucketSize = 10;
  const bucketCounts = new Map<number, number>();
  for (const face of CUBE_FACES) {
    for (let index = 0; index < 9; index += 1) {
      if (index === CENTER_INDEX) continue;
      const got = facelets[face][index] ?? null;
      if (got === null) continue; // non impegnata: fuori dalla metrica di calibrazione
      const confidence = cellConfidence[face]?.[index] ?? 0;
      const correct = got === reference[face][index];
      if (confidence >= threshold) {
        highTotal += 1;
        if (correct) highCorrect += 1;
      } else {
        lowTotal += 1;
        if (correct) lowCorrect += 1;
      }
      const bucket = Math.min(90, Math.floor(confidence / bucketSize) * bucketSize);
      bucketCounts.set(bucket, (bucketCounts.get(bucket) ?? 0) + 1);
    }
  }
  const histogram = [...bucketCounts.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([from, count]) => ({ from, to: from + bucketSize, count }));
  return {
    threshold,
    highConfidenceTotal: highTotal,
    highConfidenceCorrect: highCorrect,
    highConfidenceWrong: highTotal - highCorrect,
    highConfidencePrecision: highTotal ? highCorrect / highTotal : 0,
    lowConfidenceTotal: lowTotal,
    lowConfidenceCorrect: lowCorrect,
    lowConfidenceWrong: lowTotal - lowCorrect,
    histogram,
  };
}

export type ReconstructionScore = {
  // --- punteggio ufficiale (allineamento identita') ---
  correct: number;              // caselle giuste su 54, centri inclusi
  committed: number;            // caselle su cui la pipeline si e' impegnata / 54
  total: 54;
  correctNonCenter: number;     // caselle giuste su 48 (i centri sono giusti per costruzione)
  committedNonCenter: number;
  accuracyOnCommitted: number;  // giuste / impegnate, sulle 48 non centrali
  status: string;               // stato della ricostruzione (complete/partial/...)
  perFace: FaceScore[];
  histogramExpected: Record<string, number>;
  histogramGot: Record<string, number>;
  histogramDelta: Record<string, number>;
  // --- diagnosi, NON e' il punteggio ---
  orientation: OrientationDiagnostic;
  // --- calibrazione della confidenza (obiettivo: massimizzare le caselle
  // corrette ad alta confidenza, segnalare onestamente le altre — vedi
  // ConfidenceMetric) ---
  confidence: ConfidenceMetric;
};

export function scoreReconstruction(input: {
  facelets: FaceletMap;
  completeFacelets: CompleteFaceletMap | null;
  status?: string;
  scramble: string;
  cellConfidence?: CellConfidenceMap;
  confidenceThreshold?: number;
}): ReconstructionScore {
  const reference = referenceFromScramble(input.scramble);
  const identityAll = countEqual(input.facelets, reference, { includeCenters: true });
  const identityNonCenter = countEqual(input.facelets, reference, { includeCenters: false });

  const perFace: FaceScore[] = CUBE_FACES.map((face) => {
    const mismatches: FaceScore['mismatches'] = [];
    let correct = 0;
    let committed = 0;
    for (let index = 0; index < 9; index += 1) {
      const got = input.facelets[face][index] ?? null;
      const expected = reference[face][index];
      if (got === null) continue;
      committed += 1;
      if (got === expected) correct += 1;
      else mismatches.push({ index, expected, got });
    }
    return { face, correct, committed, mismatches };
  });

  const histogramExpected = colorHistogram(reference);
  const histogramGot = colorHistogram(input.facelets);
  const histogramDelta: Record<string, number> = {};
  for (const key of Object.keys(histogramExpected)) {
    histogramDelta[key] = histogramGot[key] - histogramExpected[key];
  }

  const orientation = diagnoseOrientation(input.facelets, reference);
  const confidence = scoreConfidenceCalibration(
    input.facelets,
    input.cellConfidence,
    reference,
    input.confidenceThreshold ?? HIGH_CONFIDENCE_THRESHOLD,
  );

  return {
    correct: identityAll.correct,
    committed: identityAll.committed,
    total: 54,
    correctNonCenter: identityNonCenter.correct,
    committedNonCenter: identityNonCenter.committed,
    accuracyOnCommitted: identityNonCenter.committed
      ? identityNonCenter.correct / identityNonCenter.committed
      : 0,
    status: input.status ?? 'unknown',
    perFace,
    histogramExpected,
    histogramGot,
    histogramDelta,
    orientation,
    confidence,
  };
}

function diagnoseOrientation(
  facelets: FaceletMap,
  reference: CompleteFaceletMap,
): OrientationDiagnostic {
  const referenceFlat = flatten(reference) as CubeColor[];
  const sourceFlat = flatten(facelets);
  const committed = sourceFlat.filter((cell) => cell !== null).length;
  if (committed === 0) {
    return {
      available: false,
      reason: 'nessuna casella valorizzata da confrontare',
      identityCorrect: 0,
      bestCorrect: 0,
      bestRotation: '',
      systematicOffsetSuspected: false,
    };
  }

  const permutations = getOrientationPermutations();
  const identityCorrect = correctAgainstReference(sourceFlat, referenceFlat);
  let bestCorrect = -1;
  let bestRotation = '';
  permutations.forEach((perm, rotationIndex) => {
    const rotatedFlat = perm.map((src) => sourceFlat[src]);
    const correct = correctAgainstReference(rotatedFlat, referenceFlat);
    if (correct > bestCorrect) {
      bestCorrect = correct;
      bestRotation = ROTATION_ALGS[rotationIndex] || '(identita)';
    }
  });

  return {
    available: true,
    identityCorrect,
    bestCorrect,
    bestRotation,
    // margine netto = piu' di 6 caselle di guadagno spostando SOLO l'orientamento
    // globale: e' un pattern coerente, non rumore sparso.
    systematicOffsetSuspected: bestRotation !== '(identita)' && bestCorrect - identityCorrect > 6,
  };
}

export function formatScoreReport(caseId: string, score: ReconstructionScore): string {
  const lines: string[] = [];
  const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '—');
  lines.push(`# ${caseId}  ·  stato ricostruzione: ${score.status}`);
  lines.push('');
  lines.push(`  PUNTEGGIO (allineamento identita', non ottimistico)`);
  lines.push(`    caselle giuste           ${score.correct}/54   (${pct(score.correct, 54)})`);
  lines.push(`    giuste escludendo centri ${score.correctNonCenter}/48   (${pct(score.correctNonCenter, 48)})`);
  lines.push(`    impegnate (non centri)   ${score.committedNonCenter}/48`);
  lines.push(`    precisione su impegnate  ${score.correctNonCenter}/${score.committedNonCenter}   (${pct(score.correctNonCenter, score.committedNonCenter)})`);
  lines.push('');
  lines.push('  PER FACCIA (giuste / impegnate su 9)');
  for (const face of score.perFace) {
    const detail = face.mismatches
      .map((m) => `#${m.index} ${m.expected}->${m.got}`)
      .join(', ');
    lines.push(`    ${face.face}  ${face.correct}/${face.committed}${detail ? `   ${detail}` : ''}`);
  }
  lines.push('');
  lines.push('  ISTOGRAMMA COLORI (ricostruito vs atteso 9x)');
  for (const color of [...CUBE_COLORS, 'unknown']) {
    const got = score.histogramGot[color] ?? 0;
    const delta = score.histogramDelta[color] ?? 0;
    if (got === 0 && color === 'unknown') continue;
    lines.push(`    ${String(color).padEnd(8)} ${got}${delta ? `   (${delta > 0 ? '+' : ''}${delta})` : ''}`);
  }
  lines.push('');
  lines.push(`  CALIBRAZIONE CONFIDENZA (soglia alta-confidenza: >=${score.confidence.threshold})`);
  const c = score.confidence;
  if (!c.highConfidenceTotal && !c.lowConfidenceTotal) {
    lines.push('    non disponibile: nessuna cellConfidence nel risultato');
  } else {
    lines.push(`    alta confidenza:  ${c.highConfidenceCorrect}/${c.highConfidenceTotal} giuste   (precisione ${pct(c.highConfidenceCorrect, c.highConfidenceTotal)})`);
    lines.push(`      -> sbagliate ma date per certe (PEGGIORE): ${c.highConfidenceWrong}`);
    lines.push(`    bassa confidenza: ${c.lowConfidenceCorrect}/${c.lowConfidenceTotal} giuste`);
    lines.push(`      -> sbagliate e segnalate come incerte (costo: un tap): ${c.lowConfidenceWrong}`);
    lines.push('    distribuzione confidenza sulle celle impegnate (non centrali):');
    for (const bucket of c.histogram) {
      const bar = '#'.repeat(Math.min(40, bucket.count));
      lines.push(`      ${String(bucket.from).padStart(3)}-${String(bucket.to).padEnd(3)} ${bar} ${bucket.count}`);
    }
  }
  lines.push('');
  lines.push('  DIAGNOSI ORIENTAMENTO (non e\' il punteggio)');
  if (!score.orientation.available) {
    lines.push(`    non disponibile: ${score.orientation.reason}`);
  } else {
    lines.push(`    identita: ${score.orientation.identityCorrect}/54   best 24 rotazioni: ${score.orientation.bestCorrect}/54 con "${score.orientation.bestRotation}"`);
    lines.push(score.orientation.systematicOffsetSuspected
      ? '    -> offset di orientamento SISTEMATICO sospetto: bug da correggere nel codice.'
      : '    -> nessun offset sistematico: gli errori sono sparsi (colore/griglia).');
  }
  return lines.join('\n');
}
