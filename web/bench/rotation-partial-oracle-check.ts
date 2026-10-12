// Esperimento #18, Parte 2 (vedi docs/pipeline-experiments.md): estende
// l'oracolo sintetico con facce ruotate (0/90/180/270°, come l'esperimento
// #17 Passo 2) E copertura parziale (30/48 caselle casuali, seed
// dichiarato, come la variante 1c dell'esperimento #15). Solo diagnosi,
// nessuna modifica alla pipeline, nessun browser (reconstructInspectionState
// e' una funzione pura).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CubeState, parseAlgorithm } from '../lib/cube.ts';
import { reconstructInspectionState, CANONICAL_FACE_COLOR, type FaceGridObservation, type PartialFacelets } from '../lib/inspection-state.ts';
import { CUBE_FACES, type CubeColor, type Face } from '../lib/cube.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORACLE_SEED = 20261012; // stesso seed dichiarato della variante 1c (esperimento #15)

function mulberry32(seed: number) {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ROT90 = [6, 3, 0, 7, 4, 1, 8, 5, 2];
function rotate(colors: Array<CubeColor | null>, turns: number): Array<CubeColor | null> {
  let result = colors;
  for (let t = 0; t < turns; t += 1) result = ROT90.map((i) => result[i]);
  return result;
}

function matches(a: Array<CubeColor | null>, reference: CubeColor[]): number {
  let m = 0;
  a.forEach((color, index) => {
    if (index === 4 || color === null) return;
    if (color === reference[index]) m += 1;
  });
  return m;
}

function main() {
  const cases = JSON.parse(fs.readFileSync(path.join(HERE, 'cases.json'), 'utf8')).cases as Array<{ id: string; scramble: string }>;

  let wrongOrientationCommitted = 0;
  let wrongOrientationLeftOpen = 0;
  const details: string[] = [];

  cases.forEach((entry, caseIndex) => {
    const cube = CubeState.solved().applyMoves(parseAlgorithm(entry.scramble));
    const reference = cube.faceletRecord();

    const random = mulberry32(ORACLE_SEED + caseIndex);
    const allCells = CUBE_FACES.flatMap((face) => [0, 1, 2, 3, 5, 6, 7, 8].map((index) => ({ face, index })));
    for (let i = allCells.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [allCells[i], allCells[j]] = [allCells[j], allCells[i]];
    }
    const revealedByFace = new Map<Face, Set<number>>(CUBE_FACES.map((face) => [face, new Set<number>()]));
    allCells.slice(0, 30).forEach((cell) => revealedByFace.get(cell.face)!.add(cell.index));

    const rotationByFace = new Map<Face, number>();
    const observations: FaceGridObservation[] = CUBE_FACES.map((face, faceIndex) => {
      const turns = (faceIndex + caseIndex) % 4;
      rotationByFace.set(face, turns);
      const revealedTrueIndices = revealedByFace.get(face)!;
      // Si sceglie quali caselle rivelare negli indici VERI (come la
      // variante 1c), si costruisce la griglia parziale nell'orientamento
      // vero (null altrove), POI si ruota l'intera griglia: i null si
      // spostano insieme alle caselle rivelate, senza bisogno di
      // ricalcolare gli indici a mano.
      const trueFace = cube.facelets(face);
      const partialTrue = trueFace.map((color, index) => (
        index === 4 || revealedTrueIndices.has(index) ? color : null
      ));
      const colors = rotate(partialTrue, turns);
      return {
        time: 0,
        centerColor: CANONICAL_FACE_COLOR[face],
        colors,
        confidence: 95,
        visibleCells: colors.filter(Boolean).length,
        sourceFrames: 3,
      };
    }).filter((o) => o.visibleCells >= 5);

    const result = reconstructInspectionState(observations, { observedCells: 0, usable: false });
    const facelets: PartialFacelets = result.completeFacelets ?? result.facelets;

    CUBE_FACES.forEach((face) => {
      const committed = facelets[face];
      const committedNonNull = committed.filter((c, i) => i !== 4 && c !== null).length;
      if (committedNonNull === 0) return; // nulla da giudicare, faccia lasciata aperta per intero
      const actualMatches = matches(committed, reference[face]);
      const bestPossible = Math.max(...[0, 1, 2, 3].map((t) => matches(rotate(committed, t), reference[face])));
      const wrong = actualMatches < committedNonNull; // almeno una casella committed sbagliata
      const orientationExplainsIt = bestPossible > actualMatches; // ruotare il COMMITTED migliora
      if (wrong && orientationExplainsIt) {
        wrongOrientationCommitted += 1; // per definizione e' committed (committedNonNull>0)
        details.push(`${entry.id}/${face}: committed match=${actualMatches}/${committedNonNull}, ruotando=${bestPossible}, rotazione-vera-applicata=${rotationByFace.get(face)}`);
      }
    });
    // Facce lasciate aperte (nessuna casella committed) non contano come
    // "impegnate": sono gia' il comportamento sicuro, le si conta a parte.
    CUBE_FACES.forEach((face) => {
      const committed = facelets[face];
      const committedNonNull = committed.filter((c, i) => i !== 4 && c !== null).length;
      if (committedNonNull > 0) return;
      const observedForFace = observations.find((o) => o.centerColor === CANONICAL_FACE_COLOR[face]);
      if (observedForFace && observedForFace.colors.some((c) => c !== null)) {
        wrongOrientationLeftOpen += 1; // aveva evidenza ma e' stata lasciata aperta (sicuro)
      }
    });
  });

  console.log('\n' + '='.repeat(72));
  console.log('ESPERIMENTO #18, PARTE 2 - oracolo ruotato + copertura parziale (30/48)');
  console.log('='.repeat(72));
  console.log(`  orientamenti finali sbagliati E impegnati (non lasciati vuoti): ${wrongOrientationCommitted}`);
  console.log(`  facce con evidenza ma lasciate aperte (nessuna casella impegnata): ${wrongOrientationLeftOpen}`);
  console.log('  dettaglio:');
  details.forEach((d) => console.log(`    ${d}`));
  console.log('='.repeat(72));
}

main();
