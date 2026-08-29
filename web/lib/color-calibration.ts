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

export type GuidedFaceCapture = {
  face: Face;
  centerColor: CubeColor;
  cells: RgbSample[];
  quality: number;
  capturedAt: number;
};

const COLORS = CUBE_COLORS;
const FACES = CUBE_FACES;

const FALLBACK_REFERENCE: Record<CubeColor, RgbSample> = {
  white: { red: 232, green: 235, blue: 238 },
  red: { red: 231, green: 55, blue: 53 },
  green: { red: 39, green: 184, blue: 94 },
  yellow: { red: 247, green: 204, blue: 31 },
  orange: { red: 248, green: 133, blue: 35 },
  blue: { red: 54, green: 116, blue: 221 },
};

const clampByte = (value: number) => Math.max(0, Math.min(255, Math.round(value)));

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

function rgbToLab(sample: RgbSample) {
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

function rgbToHsv(sample: RgbSample) {
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

export function buildColorCalibration(references: ColorReference[]): ColorCalibration {
  return Object.fromEntries(COLORS.flatMap((color) => {
    const samples = references
      .filter((reference) => reference.color === color && (reference.weight ?? 1) >= 0.35)
      .map((reference) => reference.sample);
    return samples.length ? [[color, medianRgb(samples)]] : [];
  })) as ColorCalibration;
}

export function classifyCalibratedColor(sample: RgbSample, calibration: ColorCalibration) {
  const references = completedReferences(calibration);
  const sourceLab = rgbToLab(sample);
  const sourceHsv = rgbToHsv(sample);
  const ranked = COLORS.map((color) => {
    const reference = references[color];
    const targetLab = rgbToLab(reference);
    const targetHsv = rgbToHsv(reference);
    const labDistance = Math.hypot(
      (sourceLab.lightness - targetLab.lightness) * 0.68,
      sourceLab.a - targetLab.a,
      sourceLab.b - targetLab.b,
    );
    const hueDelta = Math.min(
      Math.abs(sourceHsv.hue - targetHsv.hue),
      360 - Math.abs(sourceHsv.hue - targetHsv.hue),
    );
    const saturationPenalty = Math.abs(sourceHsv.saturation - targetHsv.saturation) * 18;
    const huePenalty = Math.min(sourceHsv.saturation, targetHsv.saturation) * hueDelta * 0.1;
    return { color, distance: labDistance + saturationPenalty + huePenalty };
  }).sort((left, right) => left.distance - right.distance);
  const best = ranked[0];
  const second = ranked[1];
  const margin = Math.max(0, (second?.distance ?? best.distance + 20) - best.distance);
  const confidence = Math.max(0, Math.min(1, 0.28 + margin / 42 - Math.max(0, best.distance - 34) / 90));
  return { color: best.color, confidence, distance: best.distance };
}

export function classifyGuidedCaptures(captures: GuidedFaceCapture[]) {
  const calibration = buildColorCalibration(captures.map((capture) => ({
    color: capture.centerColor,
    sample: capture.cells[4],
    weight: capture.quality,
  })));
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
  return { calibration, facelets, confidences };
}

export function rgbDifference(left: RgbSample, right: RgbSample) {
  return Math.hypot(left.red - right.red, left.green - right.green, left.blue - right.blue) / Math.sqrt(3);
}
