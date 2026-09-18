import { CANONICAL_FACE_COLOR, CUBE_FACES, type CubeColor, type Face } from './cube';
import type { PartialFacelets } from './inspection-state';

export const FACE_LABELS: Record<Face, string> = {
  U: 'Sopra', R: 'Destra', F: 'Fronte', D: 'Sotto', L: 'Sinistra', B: 'Retro',
};

export const NET_POSITION: Record<Face, string> = {
  U: 'col-start-2 row-start-1',
  L: 'col-start-1 row-start-2',
  F: 'col-start-2 row-start-2',
  R: 'col-start-3 row-start-2',
  B: 'col-start-4 row-start-2',
  D: 'col-start-2 row-start-3',
};

export function createBlankFacelets(): PartialFacelets {
  return Object.fromEntries(CUBE_FACES.map((face) => {
    const colors = Array<CubeColor | null>(9).fill(null);
    colors[4] = CANONICAL_FACE_COLOR[face];
    return [face, colors];
  })) as PartialFacelets;
}

export function copyFacelets(facelets: PartialFacelets): PartialFacelets {
  return Object.fromEntries(CUBE_FACES.map((face) => [face, [...facelets[face]]])) as PartialFacelets;
}

/** Nessuna casella corretta a mano: stato iniziale del bollino "edited" di CubeNet. */
export function createBlankEditedCells(): Record<Face, boolean[]> {
  return Object.fromEntries(CUBE_FACES.map((face) => [face, Array<boolean>(9).fill(false)])) as Record<Face, boolean[]>;
}

export function copyEditedCells(editedCells: Record<Face, boolean[]>): Record<Face, boolean[]> {
  return Object.fromEntries(CUBE_FACES.map((face) => [face, [...editedCells[face]]])) as Record<Face, boolean[]>;
}
