import { diff as ciede2000Diff } from 'color-diff';
import {
  CANONICAL_FACE_COLOR,
  CUBE_COLORS,
  CUBE_FACES,
  type CubeColor,
  type Face,
} from './cube.ts';

export type RgbSample = {
  red: number;
  green: number;
  blue: number;
};

export type ColorReference = {
  color: CubeColor;
  sample: RgbSample;
  weight?: number;
};

export type ColorCalibration = Partial<Record<CubeColor, RgbSample>>;

export type CubeColorValidation = {
  valid: boolean;
  complete: boolean;
  eachColorNine: boolean;
  centersUnique: boolean;
  centersCanonical: boolean;
  colorCounts: Record<CubeColor, number>;
  issues: string[];
};

export type InitialColorCalibration = {
  calibration: ColorCalibration;
  referenceCounts: Record<CubeColor, number>;
  calibratedColors: number;
  ready: boolean;
  missingColors: CubeColor[];
};

export type GuidedFaceCapture = {
  face: Face;
  centerColor: CubeColor;
  cells: RgbSample[];
  quality: number;
  capturedAt: number;
};

const COLORS = CUBE_COLORS;
const FACES = CUBE_FACES;

export const FALLBACK_REFERENCE: Record<CubeColor, RgbSample> = {
  white: { red: 232, green: 235, blue: 238 },
  red: { red: 231, green: 55, blue: 53 },
  green: { red: 39, green: 184, blue: 94 },
  yellow: { red: 247, green: 204, blue: 31 },
  orange: { red: 248, green: 133, blue: 35 },
  blue: { red: 54, green: 116, blue: 221 },
};

const clampByte = (value: number) => Math.max(0, Math.min(255, Math.round(value)));

const percentile = (values: number[], ratio: number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)))];
};

export function medianRgb(samples: RgbSample[]): RgbSample {
  if (!samples.length) return { red: 0, green: 0, blue: 0 };
  const channelMedian = (channel: keyof RgbSample) => {
    const values = samples.map((sample) => sample[channel]).sort((left, right) => left - right);
    const middle = Math.floor(values.length / 2);
    return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
  };
  return {
    red: channelMedian('red'),
    green: channelMedian('green'),
    blue: channelMedian('blue'),
  };
}

export function rgbToLab(sample: RgbSample) {
  const linear = (value: number) => {
    const normalized = value / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  const red = linear(sample.red);
  const green = linear(sample.green);
  const blue = linear(sample.blue);
  const x = (red * 0.4124564 + green * 0.3575761 + blue * 0.1804375) / 0.95047;
  const y = red * 0.2126729 + green * 0.7151522 + blue * 0.072175;
  const z = (red * 0.0193339 + green * 0.119192 + blue * 0.9503041) / 1.08883;
  const pivot = (value: number) => value > 0.008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116;
  const fx = pivot(x);
  const fy = pivot(y);
  const fz = pivot(z);
  return { lightness: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

export function rgbToHsv(sample: RgbSample) {
  const red = sample.red / 255;
  const green = sample.green / 255;
  const blue = sample.blue / 255;
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const delta = maximum - minimum;
  let hue = 0;
  if (delta > 0) {
    if (maximum === red) hue = 60 * (((green - blue) / delta) % 6);
    else if (maximum === green) hue = 60 * ((blue - red) / delta + 2);
    else hue = 60 * ((red - green) / delta + 4);
  }
  if (hue < 0) hue += 360;
  return { hue, saturation: maximum ? delta / maximum : 0, value: maximum };
}

/**
 * Legge soltanto il 25% centrale (in area) di una ROI. Il lato campionato è
 * quindi metà del lato originale: bordi neri, fughe e riflessi periferici non
 * entrano nel profilo colore. La mediana rende innocui anche pochi highlight.
 */
export function sampleCentralRoiRgb(
  pixels: Uint8ClampedArray,
  imageWidth: number,
  imageHeight: number,
  roi: { x: number; y: number; width: number; height: number },
  centralAreaFraction = 0.25,
): RgbSample | null {
  const linearFraction = Math.sqrt(Math.max(0.04, Math.min(1, centralAreaFraction)));
  const sampledWidth = roi.width * linearFraction;
  const sampledHeight = roi.height * linearFraction;
  const minimumX = Math.max(0, Math.floor(roi.x + (roi.width - sampledWidth) / 2));
  const maximumX = Math.min(imageWidth - 1, Math.ceil(roi.x + (roi.width + sampledWidth) / 2) - 1);
  const minimumY = Math.max(0, Math.floor(roi.y + (roi.height - sampledHeight) / 2));
  const maximumY = Math.min(imageHeight - 1, Math.ceil(roi.y + (roi.height + sampledHeight) / 2) - 1);
  const samples: RgbSample[] = [];
  const step = Math.max(1, Math.floor(Math.min(sampledWidth, sampledHeight) / 18));
  for (let y = minimumY; y <= maximumY; y += step) {
    for (let x = minimumX; x <= maximumX; x += step) {
      const offset = (y * imageWidth + x) * 4;
      const sample = { red: pixels[offset], green: pixels[offset + 1], blue: pixels[offset + 2] };
      if (Math.max(sample.red, sample.green, sample.blue) < 18) continue;
      samples.push(sample);
    }
  }
  return samples.length >= 4 ? medianRgb(samples) : null;
}

function referenceChannelGains(calibration: ColorCalibration) {
  const gains = (['red', 'green', 'blue'] as const).map((channel) => {
    const ratios = COLORS.flatMap((color) => {
      const measured = calibration[color];
      const expected = FALLBACK_REFERENCE[color];
      if (!measured || expected[channel] < 24) return [];
      return [measured[channel] / expected[channel]];
    }).sort((left, right) => left - right);
    if (!ratios.length) return 1;
    return ratios[Math.floor(ratios.length / 2)];
  });
  return { red: gains[0], green: gains[1], blue: gains[2] };
}

function completedReferences(calibration: ColorCalibration) {
  const gains = referenceChannelGains(calibration);
  return Object.fromEntries(COLORS.map((color) => {
    const measured = calibration[color];
    if (measured) return [color, measured];
    const fallback = FALLBACK_REFERENCE[color];
    return [color, {
      red: clampByte(fallback.red * gains.red),
      green: clampByte(fallback.green * gains.green),
      blue: clampByte(fallback.blue * gains.blue),
    }];
  })) as Record<CubeColor, RgbSample>;
}

function robustWeightedMean(references: ColorReference[]) {
  if (!references.length) return null;
  const seed = medianRgb(references.map((reference) => reference.sample));
  const seedLab = rgbToLab(seed);
  const ranked = references.map((reference) => {
    const lab = rgbToLab(reference.sample);
    return {
      ...reference,
      distance: Math.hypot(lab.lightness - seedLab.lightness, lab.a - seedLab.a, lab.b - seedLab.b),
    };
  }).sort((left, right) => left.distance - right.distance);
  const retained = ranked.slice(0, Math.max(1, Math.ceil(ranked.length * 0.84)));
  let totalWeight = 0;
  const total = { red: 0, green: 0, blue: 0 };
  retained.forEach((reference) => {
    const weight = Math.max(0.2, reference.weight ?? 1);
    total.red += reference.sample.red * weight;
    total.green += reference.sample.green * weight;
    total.blue += reference.sample.blue * weight;
    totalWeight += weight;
  });
  return {
    red: clampByte(total.red / totalWeight),
    green: clampByte(total.green / totalWeight),
    blue: clampByte(total.blue / totalWeight),
  };
}

/** Prima fase: salva in memoria la media robusta dei sei centri del filmato. */
export function buildInitialColorCalibration(references: ColorReference[]): InitialColorCalibration {
  const referenceCounts = Object.fromEntries(COLORS.map((color) => [color, 0])) as Record<CubeColor, number>;
  const calibration = Object.fromEntries(COLORS.flatMap((color) => {
    const accepted = references.filter((reference) => (
      reference.color === color && (reference.weight ?? 1) >= 0.35
    ));
    referenceCounts[color] = accepted.length;
    const mean = robustWeightedMean(accepted);
    return mean ? [[color, mean]] : [];
  })) as ColorCalibration;
  const missingColors = COLORS.filter((color) => !calibration[color]);
  return {
    calibration,
    referenceCounts,
    calibratedColors: COLORS.length - missingColors.length,
    ready: missingColors.length === 0,
    missingColors,
  };
}

export function buildColorCalibration(references: ColorReference[]): ColorCalibration {
  return buildInitialColorCalibration(references).calibration;
}

function rankedCalibratedColors(sample: RgbSample, calibration: ColorCalibration) {
  const references = completedReferences(calibration);
  const sourceColor = { R: sample.red, G: sample.green, B: sample.blue };
  return COLORS.map((color) => {
    const reference = references[color];
    const distance = ciede2000Diff(sourceColor, { R: reference.red, G: reference.green, B: reference.blue });
    return { color, distance };
  }).sort((left, right) => left.distance - right.distance);
}

export function classifyCalibratedColor(sample: RgbSample, calibration: ColorCalibration) {
  const ranked = rankedCalibratedColors(sample, calibration);
  const best = ranked[0];
  const second = ranked[1];
  const margin = Math.max(0, (second?.distance ?? best.distance + 8) - best.distance);
  // Scala ricalibrata per il deltaE CIEDE2000 (tipicamente 0-30 tra colori
  // ben distinti), molto più piccola della vecchia distanza LAB/HSV fatta in
  // casa (tipicamente 0-140).
  const confidence = Math.max(0, Math.min(1, 0.3 + margin / 11 - Math.max(0, best.distance - 9) / 24));
  return { color: best.color, confidence, distance: best.distance };
}

/**
 * Crea un classificatore per il singolo fotogramma. Le soglie di buio,
 * saturazione e bianco derivano dai pixel del frame; il colore finale è scelto
 * per distanza HSV/Lab dai riferimenti calibrati, non con intervalli hue fissi.
 */
export function createAdaptiveColorClassifier(
  frameSamples: RgbSample[],
  calibration: ColorCalibration = {},
) {
  const hsvSamples = frameSamples.map(rgbToHsv);
  const values = hsvSamples.map((sample) => sample.value);
  const saturations = hsvSamples.map((sample) => sample.saturation);
  const darkFloor = Math.max(0.07, Math.min(0.3, percentile(values, 0.16) * 0.86));
  const whiteFloor = Math.max(0.34, percentile(values, 0.62) * 0.78);
  const whiteSaturation = Math.max(0.1, Math.min(0.34, percentile(saturations, 0.34) * 0.82 + 0.035));
  // Gli sticker di un cubo sono colori pieni (saturazione tipica 0.75-0.90),
  // la pelle no (0.38-0.48 anche in pieno sole). Senza questa soglia le mani
  // producono falsi rossi/arancioni molto convinti, che rubano il posto alla
  // faccia realmente rossa. La soglia si adatta alla scena ma resta dentro
  // il divario fra i due gruppi.
  const chromaFloor = Math.max(0.54, Math.min(0.68, percentile(saturations, 0.78) * 0.72));
  return (sample: RgbSample) => {
    const hsv = rgbToHsv(sample);
    if (hsv.value < darkFloor) return null;
    if (hsv.saturation <= whiteSaturation && hsv.value < whiteFloor) return null;
    const classified = classifyCalibratedColor(sample, calibration);
    if (classified.color !== 'white' && hsv.saturation < chromaFloor) return null;
    if (classified.distance > 22 && classified.confidence < 0.18) return null;
    return classified;
  };
}

function minimumCostAssignment(costs: number[][]) {
  const size = costs.length;
  if (!size || costs.some((row) => row.length !== size)) return [];
  const rowPotential = Array<number>(size + 1).fill(0);
  const columnPotential = Array<number>(size + 1).fill(0);
  const matchedRow = Array<number>(size + 1).fill(0);
  const previousColumn = Array<number>(size + 1).fill(0);
  for (let row = 1; row <= size; row += 1) {
    matchedRow[0] = row;
    let column0 = 0;
    const minimum = Array<number>(size + 1).fill(Number.POSITIVE_INFINITY);
    const used = Array<boolean>(size + 1).fill(false);
    do {
      used[column0] = true;
      const row0 = matchedRow[column0];
      let delta = Number.POSITIVE_INFINITY;
      let column1 = 0;
      for (let column = 1; column <= size; column += 1) {
        if (used[column]) continue;
        const current = costs[row0 - 1][column - 1] - rowPotential[row0] - columnPotential[column];
        if (current < minimum[column]) {
          minimum[column] = current;
          previousColumn[column] = column0;
        }
        if (minimum[column] < delta) {
          delta = minimum[column];
          column1 = column;
        }
      }
      for (let column = 0; column <= size; column += 1) {
        if (used[column]) {
          rowPotential[matchedRow[column]] += delta;
          columnPotential[column] -= delta;
        } else {
          minimum[column] -= delta;
        }
      }
      column0 = column1;
    } while (matchedRow[column0] !== 0);
    do {
      const column1 = previousColumn[column0];
      matchedRow[column0] = matchedRow[column1];
      column0 = column1;
    } while (column0 !== 0);
  }
  const assignment = Array<number>(size).fill(-1);
  for (let column = 1; column <= size; column += 1) {
    if (matchedRow[column]) assignment[matchedRow[column] - 1] = column - 1;
  }
  return assignment;
}

export function validateCubeColorDistribution(
  facelets: Record<Face, Array<CubeColor | null>>,
): CubeColorValidation {
  const colorCounts = Object.fromEntries(COLORS.map((color) => [color, 0])) as Record<CubeColor, number>;
  let complete = true;
  FACES.forEach((face) => facelets[face].forEach((color) => {
    if (!color) complete = false;
    else colorCounts[color] += 1;
  }));
  const centers = FACES.map((face) => facelets[face][4]);
  const centersUnique = centers.every(Boolean) && new Set(centers).size === COLORS.length;
  const centersCanonical = FACES.every((face) => facelets[face][4] === CANONICAL_FACE_COLOR[face]);
  const eachColorNine = COLORS.every((color) => colorCounts[color] === 9);
  const issues: string[] = [];
  if (!complete) issues.push('Lo schema non contiene ancora 54 caselle.');
  if (!eachColorNine) issues.push('Ogni colore deve comparire esattamente 9 volte.');
  if (!centersUnique) issues.push('I sei centri devono avere colori univoci.');
  if (!centersCanonical) issues.push('I centri non rispettano la convenzione bianco U e verde F.');
  return {
    valid: complete && eachColorNine && centersUnique && centersCanonical,
    complete,
    eachColorNine,
    centersUnique,
    centersCanonical,
    colorCounts,
    issues,
  };
}

/** Classificazione globale con capacità: 8 adesivi + centro = 9 per colore. */
export function classifyBalancedCubeFacelets(
  rawFacelets: Record<Face, Array<RgbSample | null>>,
  calibration: ColorCalibration,
) {
  const entries = FACES.flatMap((face) => rawFacelets[face].flatMap((sample, index) => (
    index !== 4 && sample ? [{ face, index, sample }] : []
  )));
  // Il bilanciamento globale e' proprio il meccanismo che corregge gli errori
  // di classificazione della singola casella (forzando 9 sticker per colore),
  // quindi e' quando la lettura e' IMPERFETTA che serve di piu'. Pretendere
  // tutte e 48 le caselle lo disattivava esattamente nei casi utili.
  if (entries.length < 40) return null;
  const slots = COLORS.flatMap((color) => Array<CubeColor>(8).fill(color));
  const realCosts = entries.map((entry) => {
    const distances = new Map(rankedCalibratedColors(entry.sample, calibration)
      .map((candidate) => [candidate.color, candidate.distance]));
    return slots.map((color) => distances.get(color) ?? 999);
  });
  // minimumCostAssignment richiede una matrice quadrata: completiamo con righe
  // fittizie a costo nullo, che assorbono gli slot delle caselle non lette
  // senza influenzare l'assegnazione di quelle reali.
  const costs = [
    ...realCosts,
    ...Array.from({ length: slots.length - entries.length }, () => Array<number>(slots.length).fill(0)),
  ];
  const assignment = minimumCostAssignment(costs);
  if (assignment.length !== costs.length || assignment.some((slot) => slot < 0)) return null;
  const facelets = Object.fromEntries(FACES.map((face) => {
    const colors = Array<CubeColor | null>(9).fill(null);
    colors[4] = CANONICAL_FACE_COLOR[face];
    return [face, colors];
  })) as Record<Face, Array<CubeColor | null>>;
  const confidences = Object.fromEntries(FACES.map((face) => [face, Array<number>(9).fill(0)])) as Record<Face, number[]>;
  FACES.forEach((face) => { confidences[face][4] = 1; });
  entries.forEach((entry, row) => {
    const color = slots[assignment[row]];
    facelets[entry.face][entry.index] = color;
    const ranking = rankedCalibratedColors(entry.sample, calibration);
    const selected = ranking.find((candidate) => candidate.color === color);
    const alternative = ranking.find((candidate) => candidate.color !== color);
    const margin = Math.max(0, (alternative?.distance ?? 100) - (selected?.distance ?? 100));
    confidences[entry.face][entry.index] = Math.max(0.12, Math.min(1, 0.3 + margin / 48));
  });
  const validation = validateCubeColorDistribution(facelets);
  // Numero di caselle realmente lette dal video (esclusi i sei centri): serve
  // a chi consuma il risultato per distinguere uno schema completo da uno
  // parziale ma comunque bilanciato.
  return { facelets, confidences, validation, observedCells: entries.length };
}

export function classifyGuidedCaptures(captures: GuidedFaceCapture[]) {
  const calibrationProfile = buildInitialColorCalibration(captures.map((capture) => ({
    color: capture.centerColor,
    sample: capture.cells[4],
    weight: capture.quality,
  })));
  const calibration = calibrationProfile.calibration;
  const facelets = Object.fromEntries(FACES.map((face) => [face, Array<CubeColor | null>(9).fill(null)])) as Record<Face, Array<CubeColor | null>>;
  const confidences = Object.fromEntries(FACES.map((face) => [face, Array<number>(9).fill(0)])) as Record<Face, number[]>;
  FACES.forEach((face) => {
    facelets[face][4] = CANONICAL_FACE_COLOR[face];
    confidences[face][4] = 1;
  });
  captures.forEach((capture) => {
    capture.cells.forEach((sample, index) => {
      if (index === 4) {
        facelets[capture.face][index] = capture.centerColor;
        confidences[capture.face][index] = 1;
        return;
      }
      const classified = classifyCalibratedColor(sample, calibration);
      facelets[capture.face][index] = classified.color;
      confidences[capture.face][index] = classified.confidence;
    });
  });
  if (calibrationProfile.ready && captures.length >= 6) {
    const rawFacelets = Object.fromEntries(FACES.map((face) => {
      const capture = captures.find((candidate) => candidate.face === face);
      return [face, capture?.cells ?? Array<RgbSample | null>(9).fill(null)];
    })) as Record<Face, Array<RgbSample | null>>;
    const balanced = classifyBalancedCubeFacelets(rawFacelets, calibration);
    if (balanced) return { calibration, calibrationProfile, ...balanced };
  }
  return {
    calibration,
    calibrationProfile,
    facelets,
    confidences,
    validation: validateCubeColorDistribution(facelets),
  };
}

export function rgbDifference(left: RgbSample, right: RgbSample) {
  return Math.hypot(left.red - right.red, left.green - right.green, left.blue - right.blue) / Math.sqrt(3);
}
