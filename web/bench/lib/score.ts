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

export type FaceletMap = Record<Face, Array<CubeColor | null>>;
export type CompleteFaceletMap = Record<Face, CubeColor[]>;

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
};

export function scoreReconstruction(input: {
  facelets: FaceletMap;
  completeFacelets: CompleteFaceletMap | null;
  status?: string;
  scramble: string;
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
