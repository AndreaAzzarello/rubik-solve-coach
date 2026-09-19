// Trasforma una SceneRender (geometria pura) nell'annotazione finale:
// applica l'occlusione mano alla visibilita' dei keypoint e converte nel
// formato label di Ultralytics YOLO-pose (una classe, 4 keypoint).
//
// Ordine dei keypoint nell'export: quello geometrico dell'immagine (angolo
// attorno al centroide, in senso orario a partire dal punto piu' in alto),
// NON l'ordine (riga,colonna) intrinseco della faccia usato in scene.ts. E'
// la scelta discussa nel piano: il modello non deve imparare la semantica
// "quale faccia/quale orientamento", solo la geometria; la corrispondenza con
// i 4 angoli nominali della griglia (lib/homography.ts) si risolve a valle
// provando le rotazioni candidate.

import type { Bounds, OccluderEllipse } from './occluder.ts';
import { pointInOccluder } from './occluder.ts';
import type { FaceKeypoints, Point2D, SceneRender } from './scene.ts';

export type AnnotatedCorner = Point2D & { visibility: 0 | 1 | 2 };
export type AnnotatedFace = { face: FaceKeypoints['face']; corners: AnnotatedCorner[] };

function centroid(points: Point2D[]): Point2D {
  return {
    x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
    y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
  };
}

/** Riordina i 4 angoli (con qualunque payload agganciato) in senso orario a partire dal piu' in alto. */
function geometricOrder<T extends Point2D>(corners: T[]): T[] {
  const center = centroid(corners);
  const withAngle = corners.map((point) => ({
    point,
    angle: Math.atan2(point.y - center.y, point.x - center.x),
  }));
  withAngle.sort((a, b) => a.angle - b.angle);
  const topIndex = withAngle.reduce(
    (best, current, index) => (current.point.y < withAngle[best].point.y ? index : best),
    0,
  );
  return [...withAngle.slice(topIndex), ...withAngle.slice(0, topIndex)].map((entry) => entry.point);
}

export function sceneBounds(scene: SceneRender): Bounds {
  const points = scene.faces.flatMap((face) => face.corners);
  return {
    minX: Math.min(...points.map((p) => p.x)),
    minY: Math.min(...points.map((p) => p.y)),
    maxX: Math.max(...points.map((p) => p.x)),
    maxY: Math.max(...points.map((p) => p.y)),
  };
}

export function annotateFaces(scene: SceneRender, occluders: OccluderEllipse[]): AnnotatedFace[] {
  return scene.faces.map(({ face, corners }) => {
    const withVisibility = corners.map((corner): AnnotatedCorner => {
      if (!corner.visible) return { x: corner.x, y: corner.y, visibility: 0 };
      const occluded = occluders.some((shape) => pointInOccluder(shape, corner.x, corner.y));
      return { x: corner.x, y: corner.y, visibility: occluded ? 1 : 2 };
    });
    return { face, corners: geometricOrder(withVisibility) };
  });
}

/** Una riga per istanza, formato Ultralytics pose: class cx cy w h (x y v)*4, tutto normalizzato. */
export function toYoloLines(faces: AnnotatedFace[], width: number, height: number, margin = 0.08): string[] {
  return faces.map(({ corners }) => {
    const xs = corners.map((c) => c.x);
    const ys = corners.map((c) => c.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const padX = (maxX - minX) * margin;
    const padY = (maxY - minY) * margin;
    const boxMinX = Math.max(0, minX - padX);
    const boxMaxX = Math.min(width, maxX + padX);
    const boxMinY = Math.max(0, minY - padY);
    const boxMaxY = Math.min(height, maxY + padY);
    const cx = (boxMinX + boxMaxX) / 2 / width;
    const cy = (boxMinY + boxMaxY) / 2 / height;
    const w = (boxMaxX - boxMinX) / width;
    const h = (boxMaxY - boxMinY) / height;
    const keypoints = corners.flatMap((corner) => [
      (corner.x / width).toFixed(6),
      (corner.y / height).toFixed(6),
      String(corner.visibility),
    ]);
    return ['0', cx.toFixed(6), cy.toFixed(6), w.toFixed(6), h.toFixed(6), ...keypoints].join(' ');
  });
}
