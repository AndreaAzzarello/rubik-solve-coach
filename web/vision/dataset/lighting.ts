// Ombreggiatura Lambertiana pura (nessun WebGL): dato il colore base di uno
// sticker e la normale della sua faccia, calcola il colore "illuminato".
// Deliberatamente semplice - basta a rompere la monotonia del colore piatto,
// che altrimenti sarebbe un segnale di dominio sintetico facilmente
// riconoscibile da un modello (e diverso da qualunque foto reale).

import type { Vec3 } from './cube-geometry.ts';

export type LightParams = {
  direction: Vec3; // verso la sorgente, normalizzato
  ambient: number; // 0..1
  intensity: number; // moltiplicatore complessivo
  colorTint: [number, number, number]; // moltiplicatori per canale, ~1
};

function hexToRgb(hex: string): [number, number, number] {
  const value = parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  const clamp = (channel: number) => Math.max(0, Math.min(255, Math.round(channel)));
  return `#${[r, g, b].map((c) => clamp(c).toString(16).padStart(2, '0')).join('')}`;
}

const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

/** `jitter` in [0,1): rumore casuale indipendente per sticker (usura/stampa/micro-variazioni di luce). */
export function shadeColor(baseHex: string, normal: Vec3, light: LightParams, jitter: number): string {
  const diffuse = Math.max(0, dot(normal, light.direction));
  const factor = light.intensity * (light.ambient + (1 - light.ambient) * diffuse);
  const noise = 1 + (Math.random() * 2 - 1) * jitter;
  const [r, g, b] = hexToRgb(baseHex);
  return rgbToHex([
    r * factor * light.colorTint[0] * noise,
    g * factor * light.colorTint[1] * noise,
    b * factor * light.colorTint[2] * noise,
  ]);
}
