// Camera pinhole minimale: pura matematica, nessuna dipendenza da WebGL/Three.js.
// Basta a proiettare punti 3D su pixel per generare annotazioni esatte; la
// resa visiva (riempimento poligoni) resta un problema separato (scene.ts).

import type { Vec3 } from './cube-geometry.ts';

export type CameraParams = {
  /** Radianti, attorno all'asse Y, 0 = guarda verso -Z. */
  azimuth: number;
  /** Radianti, 0 = orizzontale, positivo = dall'alto. */
  elevation: number;
  /** Distanza dell'occhio dall'origine (dove guarda la camera). */
  distance: number;
  /** Rotazione in-plane della camera (un telefono in mano non è mai perfettamente livellato). */
  roll: number;
  /** Campo visivo verticale, radianti. */
  fovY: number;
  width: number;
  height: number;
};

type Basis = { eye: Vec3; right: Vec3; up: Vec3; forward: Vec3 };

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const norm = (a: Vec3): Vec3 => {
  const length = Math.hypot(a.x, a.y, a.z) || 1;
  return { x: a.x / length, y: a.y / length, z: a.z / length };
};
const rotateAroundForward = (vector: Vec3, forward: Vec3, angle: number): Vec3 => {
  // Rodrigues, asse = forward (normalizzato).
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const k = forward;
  const kCrossV = cross(k, vector);
  const kDotV = dot(k, vector);
  return {
    x: vector.x * cos + kCrossV.x * sin + k.x * kDotV * (1 - cos),
    y: vector.y * cos + kCrossV.y * sin + k.y * kDotV * (1 - cos),
    z: vector.z * cos + kCrossV.z * sin + k.z * kDotV * (1 - cos),
  };
};

export function buildBasis(params: CameraParams): Basis {
  const { azimuth, elevation, distance, roll } = params;
  const eye: Vec3 = {
    x: distance * Math.cos(elevation) * Math.sin(azimuth),
    y: distance * Math.sin(elevation),
    z: distance * Math.cos(elevation) * Math.cos(azimuth),
  };
  const forward = norm({ x: -eye.x, y: -eye.y, z: -eye.z });
  const worldUp: Vec3 = { x: 0, y: 1, z: 0 };
  let right = norm(cross(forward, worldUp));
  if (!Number.isFinite(right.x) || Math.hypot(right.x, right.y, right.z) < 1e-6) {
    right = { x: 1, y: 0, z: 0 };
  }
  let up = cross(right, forward);
  right = rotateAroundForward(right, forward, roll);
  up = rotateAroundForward(up, forward, roll);
  return { eye, right, up, forward };
}

export type Projected = { x: number; y: number; depth: number; behindCamera: boolean };

/** Proietta un punto 3D su pixel immagine. `depth` = distanza lungo lo sguardo (per l'ordinamento pittorico). */
export function projectPoint(params: CameraParams, basis: Basis, point: Vec3): Projected {
  const relative = sub(point, basis.eye);
  const cameraX = dot(relative, basis.right);
  const cameraY = dot(relative, basis.up);
  const cameraZ = dot(relative, basis.forward);
  const behindCamera = cameraZ <= 1e-6;
  const focal = params.height / 2 / Math.tan(params.fovY / 2);
  const safeZ = behindCamera ? 1e-6 : cameraZ;
  return {
    x: params.width / 2 + (cameraX / safeZ) * focal,
    y: params.height / 2 - (cameraY / safeZ) * focal,
    depth: cameraZ,
    behindCamera,
  };
}
