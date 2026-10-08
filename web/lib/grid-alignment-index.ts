// Indice geometrico di qualità della griglia (esperimento #10, vedi
// docs/pipeline-experiments.md): in un cubo senza bordi neri, se la griglia
// 3x3 è posizionata bene i confini tra colori diversi cadono sulle linee
// interne della griglia; se è storta, li tagliano dentro le celle. Questo
// modulo misura quell'energia — SOLO pixel grezzi dell'immagine, mai colori
// classificati/confidenza/dati di fusione — per poterla usare come segnale
// di qualità indipendente dalla lettura che deve giudicare.
//
// Diagnosticato offline in vision/eval/grid-alignment-signal.ts (AUC 0.971
// su 52 osservazioni giuste/52 sbagliate, 5 video campione) prima di essere
// portato qui: stessa identica definizione, nessuna logica duplicata altrove
// (l'eval script importa questa stessa funzione).
//
// Definizione esatta: spazio colore Lab. Omografia proiettiva vera
// (fitHomography sui 4 vertici). "Energia riga": gradiente locale
// (differenza centrale a +-2px, norma euclidea in Lab) campionato in una
// fascia di +-0.07 unità di griglia attorno a ciascuna delle 4 linee
// interne (x/y=+-0.5), lungo tutta la loro lunghezza (coordinata
// perpendicolare da -1.1 a 1.1, passo 0.05). "Energia cella": stesso
// gradiente nel 40% centrale (margine 0.3 unità di griglia da ogni bordo)
// di ciascuna delle 9 celle. Indice = energia_riga / energia_cella.

import { fitHomography, applyHomography, NOMINAL_CORNERS, type Point } from './homography.ts';
import { rgbToLab } from './color-calibration.ts';

function pixelLab(pixels: Uint8ClampedArray, width: number, height: number, x: number, y: number) {
  const clampedX = Math.max(0, Math.min(width - 1, Math.round(x)));
  const clampedY = Math.max(0, Math.min(height - 1, Math.round(y)));
  const offset = (clampedY * width + clampedX) * 4;
  return rgbToLab({ red: pixels[offset], green: pixels[offset + 1], blue: pixels[offset + 2] });
}

function gradientEnergyAt(pixels: Uint8ClampedArray, width: number, height: number, point: Point): number {
  const step = 2;
  const left = pixelLab(pixels, width, height, point.x - step, point.y);
  const right = pixelLab(pixels, width, height, point.x + step, point.y);
  const up = pixelLab(pixels, width, height, point.x, point.y - step);
  const down = pixelLab(pixels, width, height, point.x, point.y + step);
  const dx = Math.hypot(right.lightness - left.lightness, right.a - left.a, right.b - left.b);
  const dy = Math.hypot(down.lightness - up.lightness, down.a - up.a, down.b - up.b);
  return Math.hypot(dx, dy);
}

const LINE_BAND_HALF_WIDTH = 0.07;
const LINE_POSITIONS = [-0.5, 0.5];
const LINE_RANGE_FROM = -1.1;
const LINE_RANGE_TO = 1.1;
const LINE_RANGE_STEP = 0.05;
const CELL_MARGIN = 0.2;
const CELL_STEP = 0.08;

export function gridAlignmentIndex(
  keypoints: Point[],
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): number | null {
  if (keypoints.length !== NOMINAL_CORNERS.length) return null;
  const homography = fitHomography(keypoints.map((image, index) => ({ grid: NOMINAL_CORNERS[index], image })));
  if (!homography) return null;

  const lineEnergies: number[] = [];
  LINE_POSITIONS.forEach((linePos) => {
    for (let along = LINE_RANGE_FROM; along <= LINE_RANGE_TO; along += LINE_RANGE_STEP) {
      [-LINE_BAND_HALF_WIDTH, 0, LINE_BAND_HALF_WIDTH].forEach((offset) => {
        const vertical = applyHomography(homography, { x: linePos + offset, y: along });
        const horizontal = applyHomography(homography, { x: along, y: linePos + offset });
        lineEnergies.push(gradientEnergyAt(pixels, width, height, vertical));
        lineEnergies.push(gradientEnergyAt(pixels, width, height, horizontal));
      });
    }
  });

  const cellEnergies: number[] = [];
  for (let row = -1; row <= 1; row += 1) {
    for (let column = -1; column <= 1; column += 1) {
      for (let dx = -CELL_MARGIN; dx <= CELL_MARGIN + 1e-9; dx += CELL_STEP) {
        for (let dy = -CELL_MARGIN; dy <= CELL_MARGIN + 1e-9; dy += CELL_STEP) {
          const gridPoint = applyHomography(homography, { x: column + dx, y: row + dy });
          cellEnergies.push(gradientEnergyAt(pixels, width, height, gridPoint));
        }
      }
    }
  }

  const mean = (values: number[]) => values.reduce((total, value) => total + value, 0) / Math.max(1, values.length);
  const lineEnergy = mean(lineEnergies);
  const cellEnergy = mean(cellEnergies);
  return lineEnergy / Math.max(1e-6, cellEnergy);
}
