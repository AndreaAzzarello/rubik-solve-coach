// Geometria 3D pura del cubo per il generatore sintetico. Nessuna dipendenza
// dal browser: deriva TUTTO da `lib/cube.ts` (faceletPosition, FACE_NORMALS)
// per garantire che gli assi riga/colonna per faccia siano identici a quelli
// usati dal resto dell'app - zero reimplementazione, zero rischio di
// trasposizione/specchio per faccia (bug noto, vedi bench/README.md).
//
// Convenzione dimensionale: un cubo con spigolo 3 (meta'-lato 1.5), stessa
// idea di "passo unitario tra centri sticker adiacenti, contorno faccia a
// mezza cella oltre l'ultimo centro" gia' usata in lib/homography.ts
// (CORNER_MARGIN = 1.5). `faceletPosition` posiziona pero' il piano faccia a
// distanza 1 (unita' scelta per l'indicizzazione dei livelli nelle mosse, non
// per il rendering): qui la spostiamo a 1.5 lungo la normale per ottenere un
// cubo vero (stessa meta'-estensione su tutti e tre gli assi). Le coordinate
// nel piano (riga/colonna) restano quelle di faceletPosition, invariate.

import { FACE_NORMALS, faceletPosition, type Face } from '../../lib/cube.ts';

export type Vec3 = { x: number; y: number; z: number };

const NORMAL_OFFSET = 0.5;
// Meta'-larghezza di uno sticker in unita' riga/colonna (passo 1 tra centri):
// < 0.5 lascia una fuga visibile tra sticker adiacenti, come su un cubo vero.
const STICKER_HALF = 0.42;
// Meta' oltre il centro sticker piu' esterno = confine reale della faccia.
const FACE_HALF = 1.5;

function toVec3([x, y, z]: readonly [number, number, number]): Vec3 {
  return { x, y, z };
}

/** Posizione 3D di un punto a coordinate (riga, colonna) anche non intere. */
export function facePoint(face: Face, row: number, column: number): Vec3 {
  const base = faceletPosition(face, row, column);
  const normal = FACE_NORMALS[face];
  return toVec3([
    base[0] + normal[0] * NORMAL_OFFSET,
    base[1] + normal[1] * NORMAL_OFFSET,
    base[2] + normal[2] * NORMAL_OFFSET,
  ]);
}

/** I 4 angoli del singolo sticker (row, column in [0,1,2]), in ordine orario nel proprio piano. */
export function stickerCorners(face: Face, row: number, column: number): [Vec3, Vec3, Vec3, Vec3] {
  return [
    facePoint(face, row - STICKER_HALF, column - STICKER_HALF),
    facePoint(face, row - STICKER_HALF, column + STICKER_HALF),
    facePoint(face, row + STICKER_HALF, column + STICKER_HALF),
    facePoint(face, row + STICKER_HALF, column - STICKER_HALF),
  ];
}

/**
 * I 4 angoli ESTERNI della faccia (il bersaglio dell'annotazione): il
 * contorno vero della griglia 3x3, non del singolo sticker. Ordine fisso,
 * legato al sistema (riga, colonna) intrinseco della faccia - non alla
 * prospettiva della camera (che verra' gestita a valle, vedi conversazione
 * sul piano: l'ambiguita' di rotazione del quadrilatero si risolve dopo,
 * qui l'ordine serve solo a essere riproducibile e debuggabile).
 */
export function faceOuterCorners(face: Face): [Vec3, Vec3, Vec3, Vec3] {
  const near = 0 - FACE_HALF + 1; // -0.5
  const far = 2 + FACE_HALF - 1; // 2.5
  return [
    facePoint(face, near, near),
    facePoint(face, near, far),
    facePoint(face, far, far),
    facePoint(face, far, near),
  ];
}

export function faceCenter(face: Face): Vec3 {
  return facePoint(face, 1, 1);
}

export function faceNormal(face: Face): Vec3 {
  return toVec3(FACE_NORMALS[face]);
}
