// Costruisce la scena 2D (poligoni sticker + keypoint faccia) pronta per un
// pittore "stupido" (canvas 2D, nessuna conoscenza del cubo). Tutta la
// geometria/logica-cubo vive qui e in cube-geometry.ts; il payload prodotto è
// solo punti pixel + colori, sia per il rendering "pulito" (dataset vero) sia
// per l'overlay di debug (questo controllo).

import { CUBE_FACES, COLOR_HEX, type CubeColor, type Face } from '../../lib/cube.ts';
import { faceCenter, faceNormal, faceOuterCorners, stickerCorners, type Vec3 } from './cube-geometry.ts';
import { buildBasis, projectPoint, type CameraParams } from './camera.ts';
import { shadeColor, type LightParams } from './lighting.ts';

const STICKER_JITTER = 0.06;

export type Point2D = { x: number; y: number };

export type StickerPolygon = {
  face: Face;
  row: number;
  column: number;
  color: string;
  points: Point2D[];
  depth: number;
};

export type FaceKeypoints = {
  face: Face;
  corners: Array<Point2D & { visible: boolean }>;
};

export type SceneRender = {
  width: number;
  height: number;
  polygons: StickerPolygon[]; // già ordinati da dipingere in quest'ordine (pittorico)
  faces: FaceKeypoints[]; // solo facce rivolte verso la camera
};

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

function isFrontFacing(face: Face, eye: Vec3): boolean {
  const center = faceCenter(face);
  const normal = faceNormal(face);
  return dot(normal, sub(eye, center)) > 0;
}

export function buildScene(
  facelets: Record<Face, CubeColor[]>,
  camera: CameraParams,
  light: LightParams,
): SceneRender {
  const basis = buildBasis(camera);
  const visibleFaces = CUBE_FACES.filter((face) => isFrontFacing(face, basis.eye));

  const polygons: StickerPolygon[] = [];
  visibleFaces.forEach((face) => {
    const normal = faceNormal(face);
    for (let row = 0; row < 3; row += 1) {
      for (let column = 0; column < 3; column += 1) {
        const corners3d = stickerCorners(face, row, column);
        const projected = corners3d.map((point) => projectPoint(camera, basis, point));
        const depth = projected.reduce((sum, point) => sum + point.depth, 0) / projected.length;
        const baseColor = COLOR_HEX[facelets[face][row * 3 + column]];
        polygons.push({
          face,
          row,
          column,
          color: shadeColor(baseColor, normal, light, STICKER_JITTER),
          points: projected.map(({ x, y }) => ({ x, y })),
          depth,
        });
      }
    }
  });
  // Pittorico: piu' lontano prima, cosi' il piu' vicino resta sopra. Corretto
  // per un solido convesso con le facce posteriori gia' scartate sopra.
  polygons.sort((a, b) => b.depth - a.depth);

  const faces: FaceKeypoints[] = visibleFaces.map((face) => {
    const corners3d = faceOuterCorners(face);
    const projected = corners3d.map((point) => projectPoint(camera, basis, point));
    return {
      face,
      corners: projected.map(({ x, y, behindCamera }) => ({
        x,
        y,
        visible: !behindCamera && x >= 0 && x <= camera.width && y >= 0 && y <= camera.height,
      })),
    };
  });

  return { width: camera.width, height: camera.height, polygons, faces };
}
