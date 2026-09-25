// Riduce una maschera binaria (SAM) a un quadrilatero di 4 vertici: guscio
// convesso dei pixel di bordo, poi semplificato a 4 punti scartando ogni
// volta il vertice la cui rimozione perde meno area. Riusa le stesse due
// funzioni gia' scritte e testate per il fitting dell'esagono nella pipeline
// classica (lib/video-decoder.ts) - stesso identico problema (poligono
// rumoroso -> N vertici puliti), zero motivo di reimplementarlo.

import { convexHull, simplifyPolygon, type Point } from '../../lib/video-decoder.ts';

const MIN_BOUNDARY_POINTS = 8;

function boundaryPoints(mask: Uint8Array, width: number, height: number): Point[] {
  const at = (x: number, y: number) => mask[y * width + x];
  const points: Point[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!at(x, y)) continue;
      const isEdge = x === 0 || y === 0 || x === width - 1 || y === height - 1
        || !at(x - 1, y) || !at(x + 1, y) || !at(x, y - 1) || !at(x, y + 1);
      if (isEdge) points.push({ x, y });
    }
  }
  return points;
}

/** `mask`: 0/1 per pixel, row-major, `width*height` elementi. Torna null se la maschera è troppo piccola/degenere. */
export function maskToQuad(mask: Uint8Array, width: number, height: number): Point[] | null {
  const boundary = boundaryPoints(mask, width, height);
  if (boundary.length < MIN_BOUNDARY_POINTS) return null;
  const hull = convexHull(boundary);
  if (hull.length < 4) return null;
  return simplifyPolygon(hull, 4);
}
