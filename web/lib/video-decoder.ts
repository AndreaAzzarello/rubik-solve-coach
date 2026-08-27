import {
  HandDirection,
  HandSide,
  createHandMotionTracker,
} from './hand-motion';
import {
  type FaceGridObservation,
  type InspectionReconstruction,
  reconstructInspectionState,
} from './inspection-state';

export type MotionSample = {
  time: number;
  difference: number;
  coverage?: number;
  centerBias?: number;
  cubeDifference?: number;
  handMotion?: number;
  fingerMotion?: number;
  wristMotion?: number;
  handCount?: number;
  dominantHand?: HandSide;
  handDirection?: HandDirection;
  cubeEvidence?: number;
  handEvidence?: number;
  changeCentroidX?: number;
  changeCentroidY?: number;
  visibleColors?: ObservedColorCoverage;
  topFaceColors?: ObservedColorCoverage;
  faceGrids?: FaceGridObservation[];
};

export type MotionKind = 'face-turn' | 'global-motion';
export type MotionEvidence = 'cube' | 'hands' | 'combined';

export type MotionEvent = {
  id: number;
  start: number;
  end: number;
  peakTime: number;
  peakDifference: number;
  confidence: number;
  motionKind: MotionKind;
  evidence: MotionEvidence;
  cubeStrength: number;
  handStrength: number;
  dominantHand: HandSide;
  handDirection: HandDirection;
  candidateMove: string;
  candidateConfidence: number;
  candidateAlternatives: string[];
  candidateMoves: string[];
  internalPeakTimes: number[];
  moveCountEstimate: number;
  supportingRuns?: number;
};

export type ObservedCubeColor = 'white' | 'red' | 'green' | 'yellow' | 'orange' | 'blue';
export type ObservedColorCoverage = Record<ObservedCubeColor, number>;

export type CubeObservationSummary = {
  start: number;
  end: number;
  sampledFrames: number;
  stableFrames: number;
  detectedColors: ObservedCubeColor[];
  coverage: ObservedColorCoverage;
  confidence: number;
  patternStatus: 'usable' | 'partial' | 'insufficient';
  reconstruction: InspectionReconstruction;
};

export type PllColorSummary = {
  pllColor: ObservedCubeColor;
  crossColor: ObservedCubeColor;
  confidence: number;
  sampledFrames: number;
  stableFrames: number;
  alternatives: ObservedCubeColor[];
};

export type HandTrackingSummary = {
  available: boolean;
  framesWithHands: number;
  totalFrames: number;
  message?: string;
};

export type VideoDecodeResult = {
  events: MotionEvent[];
  samples: MotionSample[];
  threshold: number;
  sampleInterval: number;
  analyzedRegion: 'cube-focus';
  handTracking: HandTrackingSummary;
};

export type VideoStageKind = 'scramble' | 'inspection' | 'solve';

export type VideoStage = {
  kind: VideoStageKind;
  start: number;
  end: number;
  eventIds: number[];
};

export type SolveWindow = {
  id: number;
  start: number;
  end: number;
  eventIds: number[];
  confidence: number;
  startState: 'solved-likely' | 'scrambled-likely' | 'unknown';
  stages: VideoStage[];
};

export type VideoSegmentation = {
  windows: SolveWindow[];
  defaultWindowId: number | null;
  pauseThreshold: number;
};

type DecodeOptions = {
  startTime: number;
  endTime: number;
  analysisPass?: number;
  onProgress?: (progress: number) => void;
};

type FrameSignature = {
  luma: Uint8Array;
  chromaBlue: Uint8Array;
  chromaRed: Uint8Array;
  visibleColors: ObservedColorCoverage;
  topFaceColors: ObservedColorCoverage;
  faceGrids: Array<Omit<FaceGridObservation, 'time'>>;
};

type DifferenceMeasurement = {
  score: number;
  coverage: number;
  centerBias: number;
  changeCentroidX: number;
  changeCentroidY: number;
};

const OBSERVED_COLORS: ObservedCubeColor[] = ['white', 'red', 'green', 'yellow', 'orange', 'blue'];
const OPPOSITE_COLOR: Record<ObservedCubeColor, ObservedCubeColor> = {
  white: 'yellow',
  yellow: 'white',
  red: 'orange',
  orange: 'red',
  green: 'blue',
  blue: 'green',
};

type StickerComponent = {
  color: ObservedCubeColor;
  area: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

function emptyColorCoverage(): ObservedColorCoverage {
  return { white: 0, red: 0, green: 0, yellow: 0, orange: 0, blue: 0 };
}

function rgbToObservedColor(red: number, green: number, blue: number): ObservedCubeColor | null {
  const maximum = Math.max(red, green, blue) / 255;
  const minimum = Math.min(red, green, blue) / 255;
  const delta = maximum - minimum;
  const saturation = maximum <= 0 ? 0 : delta / maximum;
  if (maximum >= 0.58 && saturation <= 0.24) return 'white';
  if (maximum < 0.24 || saturation < 0.34) return null;

  let hue = 0;
  const normalizedRed = red / 255;
  const normalizedGreen = green / 255;
  const normalizedBlue = blue / 255;
  if (delta > 0) {
    if (maximum === normalizedRed) hue = 60 * (((normalizedGreen - normalizedBlue) / delta) % 6);
    else if (maximum === normalizedGreen) hue = 60 * ((normalizedBlue - normalizedRed) / delta + 2);
    else hue = 60 * ((normalizedRed - normalizedGreen) / delta + 4);
  }
  if (hue < 0) hue += 360;
  if (hue < 13 || hue >= 345) return 'red';
  if (hue < 42) return 'orange';
  if (hue < 76) return 'yellow';
  if (hue < 175) return 'green';
  if (hue < 270) return 'blue';
  return 'red';
}

const median = (values: number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

function stickerComponents(labels: Int8Array, width: number, height: number) {
  const visited = new Uint8Array(labels.length);
  const queue = new Int32Array(labels.length);
  const components: StickerComponent[] = [];
  for (let seed = 0; seed < labels.length; seed += 1) {
    const label = labels[seed];
    if (label < 0 || visited[seed]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = seed;
    visited[seed] = 1;
    let area = 0;
    let sumX = 0;
    let sumY = 0;
    let minimumX = width;
    let maximumX = 0;
    let minimumY = height;
    let maximumY = 0;
    while (head < tail) {
      const index = queue[head++];
      const x = index % width;
      const y = Math.floor(index / width);
      area += 1;
      sumX += x;
      sumY += y;
      minimumX = Math.min(minimumX, x);
      maximumX = Math.max(maximumX, x);
      minimumY = Math.min(minimumY, y);
      maximumY = Math.max(maximumY, y);
      const neighbors = [index - 1, index + 1, index - width, index + width];
      neighbors.forEach((neighbor, direction) => {
        if (neighbor < 0 || neighbor >= labels.length || visited[neighbor] || labels[neighbor] !== label) return;
        if (direction === 0 && x === 0) return;
        if (direction === 1 && x === width - 1) return;
        visited[neighbor] = 1;
        queue[tail++] = neighbor;
      });
    }
    const componentWidth = maximumX - minimumX + 1;
    const componentHeight = maximumY - minimumY + 1;
    const fill = area / Math.max(1, componentWidth * componentHeight);
    const aspect = componentWidth / Math.max(1, componentHeight);
    if (
      area >= 4
      && area <= width * height * 0.055
      && componentWidth >= 2
      && componentHeight >= 2
      && aspect >= 0.32
      && aspect <= 3.1
      && fill >= 0.28
    ) {
      components.push({
        color: OBSERVED_COLORS[label],
        area,
        x: sumX / area,
        y: sumY / area,
        width: componentWidth,
        height: componentHeight,
      });
    }
  }
  return components;
}

function detectFaceGrids(labels: Int8Array, width: number, height: number) {
  const components = stickerComponents(labels, width, height);
  if (components.length < 6) return [];
  const areas = components.map((component) => component.area);
  const typicalArea = median(areas);
  const usable = components.filter((component) => (
    component.area >= typicalArea * 0.22 && component.area <= typicalArea * 4.5
  ));
  const candidates: Array<Omit<FaceGridObservation, 'time'> & { score: number }> = [];

  usable.forEach((center) => {
    const vectors = usable
      .filter((component) => component !== center)
      .map((component) => ({
        component,
        dx: component.x - center.x,
        dy: component.y - center.y,
        length: Math.hypot(component.x - center.x, component.y - center.y),
      }))
      .filter((vector) => vector.length >= 2.4 && vector.length <= Math.min(width, height) * 0.34);
    // The cube may be held at any roll angle during inspection. Candidate
    // axes therefore come from the nearest sticker centroids, not only from
    // vectors pointing right/down in image coordinates.
    const basisVectors = [...vectors]
      .sort((left, right) => left.length - right.length)
      .slice(0, 14);

    basisVectors.forEach((right) => basisVectors.forEach((down) => {
      if (right.component === down.component) return;
      const cosine = Math.abs((right.dx * down.dx + right.dy * down.dy) / (right.length * down.length));
      const determinant = right.dx * down.dy - right.dy * down.dx;
      const ratio = right.length / down.length;
      if (cosine > 0.64 || determinant <= 1.8 || ratio < 0.42 || ratio > 2.4) return;
      const tolerance = Math.max(2.2, Math.min(right.length, down.length) * 0.43);
      const used = new Set<StickerComponent>();
      const colors = Array<ObservedCubeColor | null>(9).fill(null);
      let visibleCells = 0;
      let residual = 0;
      for (let row = -1; row <= 1; row += 1) {
        for (let column = -1; column <= 1; column += 1) {
          const targetX = center.x + right.dx * column + down.dx * row;
          const targetY = center.y + right.dy * column + down.dy * row;
          let best: StickerComponent | null = null;
          let bestDistance = tolerance;
          usable.forEach((component) => {
            if (used.has(component)) return;
            const distance = Math.hypot(component.x - targetX, component.y - targetY);
            if (distance < bestDistance) {
              best = component;
              bestDistance = distance;
            }
          });
          if (best) {
            used.add(best);
            colors[(row + 1) * 3 + column + 1] = best.color;
            visibleCells += 1;
            residual += bestDistance / tolerance;
          }
        }
      }
      if (visibleCells < 6 || colors[4] !== center.color) return;
      const fit = Math.max(0, 1 - residual / visibleCells);
      const score = visibleCells / 9 * 0.78 + fit * 0.22;
      candidates.push({
        centerColor: center.color,
        colors,
        visibleCells,
        confidence: Math.round(Math.min(94, Math.max(42, score * 100))),
        score,
      });
    }));
  });

  const bestByCenter = new Map<ObservedCubeColor, (typeof candidates)[number]>();
  candidates.sort((left, right) => right.score - left.score).forEach((candidate) => {
    if (!bestByCenter.has(candidate.centerColor)) bestByCenter.set(candidate.centerColor, candidate);
  });
  return [...bestByCenter.values()]
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
    .map((candidate) => ({
      centerColor: candidate.centerColor,
      colors: candidate.colors,
      visibleCells: candidate.visibleCells,
      confidence: candidate.confidence,
    }));
}

function waitForSeek(video: HTMLVideoElement, time: number) {
  return new Promise<void>((resolve, reject) => {
    const target = Math.min(Math.max(0, time), Math.max(0, video.duration - 0.01));
    if (video.readyState >= 2 && Math.abs(video.currentTime - target) < 0.01) {
      window.requestAnimationFrame(() => resolve());
      return;
    }

    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error('Il browser non riesce a leggere questo punto del video.'));
    }, 8000);

    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
    };
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('Errore durante la lettura del video.'));
    };

    video.addEventListener('seeked', onSeeked, { once: true });
    video.addEventListener('error', onError, { once: true });
    video.currentTime = target;
  });
}

function frameSignature(context: CanvasRenderingContext2D, width: number, height: number): FrameSignature {
  const { data } = context.getImageData(0, 0, width, height);
  const size = width * height;
  const luma = new Uint8Array(size);
  const chromaBlue = new Uint8Array(size);
  const chromaRed = new Uint8Array(size);
  const colorCounts = emptyColorCoverage();
  const topColorCounts = emptyColorCoverage();
  const pixelLabels = new Int8Array(size);
  pixelLabels.fill(-1);
  let classifiedPixels = 0;
  let classifiedTopPixels = 0;

  for (let source = 0, target = 0; source < data.length; source += 4, target += 1) {
    const red = data[source];
    const green = data[source + 1];
    const blue = data[source + 2];
    const brightness = Math.round(red * 0.299 + green * 0.587 + blue * 0.114);
    luma[target] = brightness;
    chromaBlue[target] = Math.round(Math.min(255, Math.max(0, 128 + (blue - brightness) * 0.565)));
    chromaRed[target] = Math.round(Math.min(255, Math.max(0, 128 + (red - brightness) * 0.713)));
    const x = target % width;
    const y = Math.floor(target / width);
    if (x >= width * 0.12 && x <= width * 0.88 && y >= height * 0.12 && y <= height * 0.88) {
      const color = rgbToObservedColor(red, green, blue);
      if (color) {
        pixelLabels[target] = OBSERVED_COLORS.indexOf(color);
        colorCounts[color] += 1;
        classifiedPixels += 1;
        if (x >= width * 0.22 && x <= width * 0.78 && y >= height * 0.18 && y <= height * 0.52) {
          topColorCounts[color] += 1;
          classifiedTopPixels += 1;
        }
      }
    }
  }

  const visibleColors = emptyColorCoverage();
  const topFaceColors = emptyColorCoverage();
  OBSERVED_COLORS.forEach((color) => {
    visibleColors[color] = colorCounts[color] / Math.max(1, classifiedPixels);
    topFaceColors[color] = topColorCounts[color] / Math.max(1, classifiedTopPixels);
  });
  return {
    luma,
    chromaBlue,
    chromaRed,
    visibleColors,
    topFaceColors,
    faceGrids: detectFaceGrids(pixelLabels, width, height),
  };
}

function frameDifference(
  previous: FrameSignature,
  current: FrameSignature,
  width: number,
  height: number,
): DifferenceMeasurement {
  let exposureShift = 0;
  for (let index = 0; index < current.luma.length; index += 1) {
    exposureShift += current.luma[index] - previous.luma[index];
  }
  exposureShift /= current.luma.length;

  let centerTotal = 0;
  let centerWeight = 0;
  let outerTotal = 0;
  let outerWeight = 0;
  let changedWeight = 0;
  let totalWeight = 0;
  let changeMass = 0;
  let changeX = 0;
  let changeY = 0;

  for (let index = 0; index < current.luma.length; index += 1) {
    const x = index % width;
    const y = Math.floor(index / width);
    const normalizedX = (x + 0.5) / width;
    const normalizedY = (y + 0.5) / height;
    const isCenter = normalizedX >= 0.14 && normalizedX <= 0.86 && normalizedY >= 0.12 && normalizedY <= 0.88;
    const weight = isCenter ? 1.35 : 0.48;
    const lumaDelta = Math.abs((current.luma[index] - previous.luma[index]) - exposureShift);
    const chromaDelta = (
      Math.abs(current.chromaBlue[index] - previous.chromaBlue[index])
      + Math.abs(current.chromaRed[index] - previous.chromaRed[index])
    ) / 2;
    const pixelDifference = Math.min(64, lumaDelta * 0.58 + chromaDelta * 0.42);

    if (isCenter) {
      centerTotal += pixelDifference * weight;
      centerWeight += weight;
    } else {
      outerTotal += pixelDifference * weight;
      outerWeight += weight;
    }
    if (pixelDifference >= 9.5) changedWeight += weight;
    if (pixelDifference >= 7.5) {
      const mass = pixelDifference * weight;
      changeMass += mass;
      changeX += normalizedX * mass;
      changeY += normalizedY * mass;
    }
    totalWeight += weight;
  }

  const centerMean = centerTotal / Math.max(1, centerWeight);
  const outerMean = outerTotal / Math.max(1, outerWeight);
  const coverage = changedWeight / Math.max(1, totalWeight);
  const centerBias = centerMean / Math.max(0.6, outerMean);

  return {
    score: centerMean * 0.74 + outerMean * 0.12 + coverage * 12,
    coverage,
    centerBias,
    changeCentroidX: changeMass ? changeX / changeMass : 0.5,
    changeCentroidY: changeMass ? changeY / changeMass : 0.5,
  };
}

function suffixFromDirection(base: string, direction: HandDirection) {
  if (direction === 'mixed') return '';
  const positive = base === 'U' || base === 'D' || base === 'y'
    ? direction === 'right'
    : base === 'R' || base === 'L' || base === 'x'
      ? direction === 'down'
      : direction === 'right' || direction === 'down';
  return positive ? '' : "'";
}

function inferMoveCandidate(peak: MotionSample, motionKind: MotionKind, evidence: MotionEvidence) {
  const direction = peak.handDirection ?? 'mixed';
  const x = peak.changeCentroidX ?? 0.5;
  const y = peak.changeCentroidY ?? 0.5;
  let base = 'F';
  let alternatives: string[] = [];
  let spatialConfidence = 42;

  if (motionKind === 'global-motion') {
    if (direction === 'left' || direction === 'right') {
      base = 'y';
      alternatives = ['Uw', 'E'];
    } else if (direction === 'up' || direction === 'down') {
      base = 'x';
      alternatives = ['Rw', 'M'];
    } else {
      base = 'z';
      alternatives = ['Fw', 'S'];
    }
    spatialConfidence = direction === 'mixed' ? 38 : 54;
  } else if (y < 0.38) {
    base = 'U';
    alternatives = ['B', 'F'];
    spatialConfidence = 58;
  } else if (y > 0.7) {
    base = 'D';
    alternatives = ['F', 'L'];
    spatialConfidence = 52;
  } else if (x > 0.62) {
    base = 'R';
    alternatives = ['F', 'B'];
    spatialConfidence = 58;
  } else if (x < 0.38) {
    base = 'L';
    alternatives = ['F', 'B'];
    spatialConfidence = 58;
  } else if (peak.dominantHand === 'right' && (direction === 'up' || direction === 'down')) {
    base = 'R';
    alternatives = ['F', 'U'];
    spatialConfidence = 49;
  } else if (peak.dominantHand === 'left' && (direction === 'up' || direction === 'down')) {
    base = 'L';
    alternatives = ['F', 'U'];
    spatialConfidence = 49;
  } else {
    base = 'F';
    alternatives = ['U', peak.dominantHand === 'left' ? 'L' : 'R'];
  }

  const suffix = suffixFromDirection(base, direction);
  const evidenceBonus = evidence === 'combined' ? 7 : evidence === 'hands' ? 2 : -3;
  const directionBonus = direction === 'mixed' ? -5 : 3;
  const candidateConfidence = Math.round(Math.min(68, Math.max(28, spatialConfidence + evidenceBonus + directionBonus)));
  return {
    candidateMove: `${base}${suffix}`,
    candidateConfidence,
    candidateAlternatives: alternatives.map((alternative) => `${alternative}${suffix}`),
  };
}

function percentile(values: number[], ratio: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)))];
}

function channelActivity(values: number[], minimumSpread: number) {
  const sorted = [...values].sort((left, right) => left - right);
  const quietBand = sorted.slice(0, Math.max(3, Math.ceil(sorted.length * 0.58)));
  const baseline = median(quietBand);
  const deviation = median(quietBand.map((value) => Math.abs(value - baseline)));
  const spread = Math.max(
    minimumSpread,
    deviation * 6,
    percentile(sorted, 0.9) - baseline,
  );
  return values.map((value) => Math.max(0, (value - baseline) / spread));
}

/**
 * Porta variazione degli sticker e traiettorie delle mani sulla stessa scala.
 * La finestra anticipata permette a una fingertrick di sostenere la mossa che
 * diventa visibile sul cubo pochi fotogrammi dopo.
 */
export function fuseMotionEvidence(samples: MotionSample[]) {
  if (!samples.length) return samples;
  const cubeValues = samples.map((sample) => sample.cubeDifference ?? sample.difference);
  const handValues = samples.map((sample) => sample.handMotion ?? 0);
  const cubeActivity = channelActivity(cubeValues, 2.4);
  const handActivity = channelActivity(handValues, 0.035);
  const cubeBaseline = median([...cubeValues].sort((left, right) => left - right).slice(0, Math.max(3, Math.ceil(samples.length * 0.58))));
  const cubeSpread = Math.max(2.8, percentile(cubeValues, 0.9) - cubeBaseline);

  return samples.map((sample, index) => {
    let handSupport = handActivity[index] ?? 0;
    // Le dita spesso iniziano 60–180 ms prima che gli sticker cambino.
    for (let lead = 1; lead <= 3; lead += 1) {
      handSupport = Math.max(handSupport, (handActivity[index - lead] ?? 0) * (1 - lead * 0.08));
    }
    handSupport = Math.max(handSupport, (handActivity[index + 1] ?? 0) * 0.72);
    const cubeSupport = cubeActivity[index] ?? 0;
    const primary = Math.max(cubeSupport, handSupport * 0.96);
    const agreement = Math.min(cubeSupport, handSupport);
    return {
      ...sample,
      cubeDifference: cubeValues[index],
      cubeEvidence: cubeSupport,
      handEvidence: handSupport,
      difference: cubeBaseline + cubeSpread * (primary + agreement * 0.28),
    };
  });
}

function smoothSamples(samples: MotionSample[]) {
  return samples.map((sample, index) => {
    const previous = samples[Math.max(0, index - 1)].difference;
    const next = samples[Math.min(samples.length - 1, index + 1)].difference;
    return { ...sample, difference: previous * 0.22 + sample.difference * 0.56 + next * 0.22 };
  });
}

export function compactDoubleTurns(tokens: string[]) {
  const compacted: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const next = tokens[index + 1];
    if (/^[URFDLB]'?$/.test(token) && token === next) {
      compacted.push(`${token[0]}2`);
      index += 1;
    } else {
      compacted.push(token);
    }
  }
  return compacted;
}

function packMotionEvents(events: MotionEvent[], sampleInterval: number) {
  if (!events.length) return events;
  const maximumGap = Math.min(0.62, Math.max(0.3, sampleInterval * 6.2));
  const maximumPacketDuration = 1.35;
  const groups: MotionEvent[][] = [];

  events.forEach((event) => {
    const current = groups.at(-1);
    const previous = current?.at(-1);
    const packetStart = current?.[0].start ?? event.start;
    const belongsToCurrent = Boolean(
      current
      && previous
      && event.start - previous.end <= maximumGap
      && event.end - packetStart <= maximumPacketDuration,
    );
    if (belongsToCurrent) current!.push(event);
    else groups.push([event]);
  });

  return groups.map((group, packetIndex) => {
    const strongest = [...group].sort((left, right) => right.peakDifference - left.peakDifference)[0];
    const candidateMoves = compactDoubleTurns(group.flatMap((event) => event.candidateMoves));
    const confidence = Math.round(group.reduce((total, event) => total + event.confidence, 0) / group.length);
    const candidateConfidence = Math.round(
      group.reduce((total, event) => total + event.candidateConfidence, 0) / group.length,
    );
    const cubeStrength = Math.max(...group.map((event) => event.cubeStrength));
    const handStrength = Math.max(...group.map((event) => event.handStrength));
    const directions = new Set(group.map((event) => event.handDirection));
    const hands = new Set(group.map((event) => event.dominantHand).filter((hand) => hand !== 'unknown'));
    const hasCube = group.some((event) => event.evidence === 'cube' || event.evidence === 'combined');
    const hasHands = group.some((event) => event.evidence === 'hands' || event.evidence === 'combined');
    return {
      ...strongest,
      id: packetIndex + 1,
      start: group[0].start,
      end: group.at(-1)!.end,
      confidence: Math.min(98, confidence + Math.min(6, group.length - 1)),
      motionKind: group.some((event) => event.motionKind === 'global-motion')
        ? 'global-motion' as const
        : 'face-turn' as const,
      evidence: hasCube && hasHands ? 'combined' as const : hasHands ? 'hands' as const : 'cube' as const,
      cubeStrength,
      handStrength,
      dominantHand: hands.size > 1 ? 'both' as const : group.find((event) => event.dominantHand !== 'unknown')?.dominantHand ?? 'unknown',
      handDirection: directions.size === 1 ? group[0].handDirection : 'mixed' as const,
      candidateMove: candidateMoves.join(' '),
      candidateMoves,
      candidateConfidence: Math.max(24, candidateConfidence - Math.max(0, group.length - 2) * 2),
      candidateAlternatives: Array.from(new Set(group.flatMap((event) => event.candidateAlternatives))).slice(0, 5),
      internalPeakTimes: group.flatMap((event) => event.internalPeakTimes),
      moveCountEstimate: candidateMoves.length,
    };
  });
}

export function detectMotionEvents(samples: MotionSample[], sampleInterval: number): Omit<VideoDecodeResult, 'sampleInterval' | 'analyzedRegion' | 'handTracking'> {
  if (samples.length < 3) return { events: [], samples, threshold: 0 };

  const smoothed = smoothSamples(samples);
  const sortedDifferences = smoothed.slice(1).map((sample) => sample.difference).sort((left, right) => left - right);
  const quietBand = sortedDifferences.slice(0, Math.max(3, Math.ceil(sortedDifferences.length * 0.58)));
  const baseline = median(quietBand);
  const deviation = median(quietBand.map((value) => Math.abs(value - baseline)));
  const noiseThreshold = baseline + Math.max(1.35, deviation * 4.2);
  const activityCeiling = sortedDifferences[Math.floor((sortedDifferences.length - 1) * 0.72)];
  const threshold = Math.max(2.6, Math.min(noiseThreshold, activityCeiling));
  const releaseThreshold = Math.min(
    threshold * 0.76,
    Math.max(1.8, baseline + Math.max(0.72, deviation * 1.9)),
  );
  const peakRadius = Math.max(1, Math.round(0.1 / sampleInterval));
  const minimumPeakGap = Math.max(0.14, sampleInterval * 1.65);

  const candidates = smoothed
    .slice(1, -1)
    .filter((sample, offset) => {
      const index = offset + 1;
      if (sample.difference < threshold) return false;
      const start = Math.max(0, index - peakRadius);
      const end = Math.min(smoothed.length - 1, index + peakRadius);
      for (let neighbor = start; neighbor <= end; neighbor += 1) {
        if (smoothed[neighbor].difference > sample.difference) return false;
      }
      return true;
    })
    .sort((left, right) => right.difference - left.difference);

  const selectedPeaks: MotionSample[] = [];
  candidates.forEach((candidate) => {
    if (selectedPeaks.every((peak) => Math.abs(peak.time - candidate.time) >= minimumPeakGap)) {
      selectedPeaks.push(candidate);
    }
  });
  selectedPeaks.sort((left, right) => left.time - right.time);

  const atomicEvents = selectedPeaks.map((peak, index) => {
    const peakIndex = smoothed.indexOf(peak);
    const maximumRadius = Math.max(2, Math.ceil(0.75 / sampleInterval));
    let startIndex = peakIndex;
    let endIndex = peakIndex;

    while (
      startIndex > 0
      && peakIndex - startIndex < maximumRadius
      && smoothed[startIndex - 1].difference >= releaseThreshold
    ) startIndex -= 1;
    while (
      endIndex < smoothed.length - 1
      && endIndex - peakIndex < maximumRadius
      && smoothed[endIndex + 1].difference >= releaseThreshold
    ) endIndex += 1;

    const evidenceWindow = smoothed.slice(Math.max(0, startIndex - 3), Math.min(smoothed.length, endIndex + 2));
    const cubeEvidence = Math.max(0, ...evidenceWindow.map((sample) => sample.cubeEvidence ?? 0));
    const handEvidence = Math.max(0, ...evidenceWindow.map((sample) => sample.handEvidence ?? 0));
    const handPeak = [...evidenceWindow].sort(
      (left, right) => (right.handEvidence ?? 0) - (left.handEvidence ?? 0),
    )[0];
    const hasCubeEvidence = cubeEvidence >= 0.38;
    const hasHandEvidence = handEvidence >= 0.32;
    const evidence: MotionEvidence = hasCubeEvidence && hasHandEvidence
      ? 'combined'
      : hasHandEvidence && (!hasCubeEvidence || handEvidence > cubeEvidence)
        ? 'hands'
        : 'cube';
    const strength = (peak.difference - threshold) / Math.max(1, threshold);
    const focusBonus = Math.max(-8, Math.min(10, ((peak.centerBias ?? 1) - 1) * 12));
    const agreementBonus = evidence === 'combined' ? 9 : evidence === 'hands' ? -4 : 0;
    // A large changed area is a useful warning for wide moves, cube rotations
    // and regrips. It is deliberately a category, not an automatic move label.
    const globalMotion = (peak.coverage ?? 0) >= 0.52;
    const motionKind = globalMotion ? 'global-motion' as const : 'face-turn' as const;
    const moveCandidate = inferMoveCandidate({
      ...peak,
      dominantHand: handPeak?.dominantHand ?? peak.dominantHand,
      handDirection: handPeak?.handDirection ?? peak.handDirection,
    }, motionKind, evidence);
    return {
      id: index + 1,
      start: Math.max(0, smoothed[startIndex].time - sampleInterval),
      end: smoothed[endIndex].time + sampleInterval,
      peakTime: peak.time,
      peakDifference: peak.difference,
      confidence: Math.round(Math.min(98, Math.max(34, 52 + strength * 54 + focusBonus + agreementBonus))),
      motionKind,
      evidence,
      cubeStrength: Math.round(Math.min(100, cubeEvidence * 100)),
      handStrength: Math.round(Math.min(100, handEvidence * 100)),
      dominantHand: handPeak?.dominantHand ?? 'unknown',
      handDirection: handPeak?.handDirection ?? 'mixed',
      ...moveCandidate,
      candidateMoves: [moveCandidate.candidateMove],
      internalPeakTimes: [peak.time],
      moveCountEstimate: 1,
    };
  });

  for (let index = 0; index < atomicEvents.length - 1; index += 1) {
    if (atomicEvents[index].end > atomicEvents[index + 1].start) {
      const midpoint = (atomicEvents[index].peakTime + atomicEvents[index + 1].peakTime) / 2;
      atomicEvents[index].end = midpoint;
      atomicEvents[index + 1].start = midpoint;
    }
  }

  return { events: packMotionEvents(atomicEvents, sampleInterval).slice(0, 160), samples, threshold };
}

export function summarizeCubeObservation(
  samples: MotionSample[],
  start: number,
  end: number,
): CubeObservationSummary {
  const selected = samples.filter((sample) => sample.time >= start && sample.time <= end && sample.visibleColors);
  const differences = selected.map((sample) => sample.cubeDifference ?? sample.difference);
  const stableLimit = Math.max(2.4, percentile(differences, 0.42));
  const stable = selected.filter((sample) => (sample.cubeDifference ?? sample.difference) <= stableLimit);
  const useful = stable.length >= 3 ? stable : selected;
  const reconstruction = reconstructInspectionState(
    useful.flatMap((sample) => sample.faceGrids ?? []),
  );
  const coverage = emptyColorCoverage();
  useful.forEach((sample) => {
    OBSERVED_COLORS.forEach((color) => {
      coverage[color] += sample.visibleColors?.[color] ?? 0;
    });
  });
  OBSERVED_COLORS.forEach((color) => {
    coverage[color] /= Math.max(1, useful.length);
  });
  const detectedColors = OBSERVED_COLORS.filter((color) => (
    useful.filter((sample) => (sample.visibleColors?.[color] ?? 0) >= 0.012).length
      >= Math.max(2, Math.ceil(useful.length * 0.035))
  ));
  const frameScore = Math.min(24, useful.length * 0.55);
  const colorScore = detectedColors.length / OBSERVED_COLORS.length * 66;
  const confidence = Math.round(Math.min(96, Math.max(
    frameScore + colorScore,
    reconstruction.confidence,
  )));
  return {
    start,
    end,
    sampledFrames: selected.length,
    stableFrames: stable.length,
    detectedColors,
    coverage,
    confidence,
    patternStatus: reconstruction.status === 'complete'
      ? 'usable'
      : reconstruction.status === 'partial' || (detectedColors.length >= 4 && stable.length >= 8)
        ? 'partial'
        : 'insufficient',
    reconstruction,
  };
}

export function inferPllAndCrossColor(
  samples: MotionSample[],
  solveStart: number,
  solveEnd: number,
): PllColorSummary | null {
  const duration = Math.max(0.5, solveEnd - solveStart);
  const analysisStart = Math.max(solveStart, solveEnd - Math.min(4.5, Math.max(1.35, duration * 0.22)));
  const selected = samples.filter((sample) => (
    sample.time >= analysisStart
    && sample.time <= solveEnd
    && sample.topFaceColors
  ));
  if (selected.length < 3) return null;

  const differences = selected.map((sample) => sample.cubeDifference ?? sample.difference);
  const stableLimit = Math.max(2.5, percentile(differences, 0.5));
  const stable = selected.filter((sample) => (sample.cubeDifference ?? sample.difference) <= stableLimit);
  const useful = stable.length >= 3 ? stable : selected;
  const scores = OBSERVED_COLORS.map((color) => {
    const values = useful.map((sample) => sample.topFaceColors?.[color] ?? 0);
    const persistentFrames = values.filter((value) => value >= 0.16).length;
    return {
      color,
      score: median(values) * 0.72 + percentile(values, 0.78) * 0.28,
      persistentRatio: persistentFrames / Math.max(1, values.length),
    };
  }).sort((left, right) => right.score - left.score);

  const best = scores[0];
  const second = scores[1];
  if (!best || best.score < 0.12) return null;
  const gap = Math.max(0, best.score - (second?.score ?? 0));
  const confidence = Math.round(Math.min(88, Math.max(
    34,
    28 + best.score * 38 + gap * 125 + best.persistentRatio * 10 + Math.min(8, stable.length * 0.45),
  )));
  return {
    pllColor: best.color,
    crossColor: OPPOSITE_COLOR[best.color],
    confidence,
    sampledFrames: selected.length,
    stableFrames: stable.length,
    alternatives: scores.slice(1, 3).map((candidate) => candidate.color),
  };
}

function groupEventsByPause(events: MotionEvent[], pauseThreshold: number) {
  const groups: MotionEvent[][] = [];
  events.forEach((event) => {
    const current = groups.at(-1);
    const previous = current?.at(-1);
    if (!current || !previous || event.peakTime - previous.peakTime > pauseThreshold) {
      groups.push([event]);
    } else {
      current.push(event);
    }
  });
  return groups;
}

export function inferVideoSegmentation(
  events: MotionEvent[],
  rangeStart: number,
  rangeEnd: number,
): VideoSegmentation {
  if (!events.length) return { windows: [], defaultWindowId: null, pauseThreshold: 1.8 };

  const ordered = [...events].sort((left, right) => left.peakTime - right.peakTime);
  const duration = Math.max(1, rangeEnd - rangeStart);
  const sessionPauseThreshold = Math.min(45, Math.max(24, duration * 0.18));
  const sessions = groupEventsByPause(ordered, sessionPauseThreshold);
  const usableSessions = sessions.filter((session) => (
    session.reduce((total, packet) => total + packet.moveCountEstimate, 0) >= 4
  ));
  const candidateSessions = usableSessions.length ? usableSessions : [ordered];

  const windows: SolveWindow[] = candidateSessions.map((session, index) => {
    const gaps = session.slice(1).map((event, gapIndex) => event.peakTime - session[gapIndex].peakTime);
    const typicalGap = median(gaps.filter((gap) => gap <= 3.5));
    const pauseThreshold = Math.min(6, Math.max(1.45, typicalGap * 3.4));
    const minimumSuffix = Math.min(
      Math.max(2, Math.floor(session.length * 0.3)),
      Math.max(1, session.length - 1),
    );
    let splitIndex = -1;
    let selectedPause = 0;
    let bestSplitScore = 0;

    for (let cut = 1; cut <= session.length - minimumSuffix; cut += 1) {
      const gap = session[cut].peakTime - session[cut - 1].peakTime;
      const tail = session.slice(Math.max(0, cut - 4), cut);
      const extendedRatio = tail.filter((event) => event.motionKind === 'global-motion').length / tail.length;
      const splitScore = gap + extendedRatio * 2.6 + (cut / session.length) * 0.35;
      if (gap >= pauseThreshold && splitScore > bestSplitScore) {
        selectedPause = gap;
        bestSplitScore = splitScore;
        splitIndex = cut;
      }
    }

    const preparationEvents = splitIndex > 0 ? session.slice(0, splitIndex) : [];
    const solveEvents = splitIndex > 0 ? session.slice(splitIndex) : session;
    const start = Math.max(rangeStart, solveEvents[0].start);
    const end = Math.min(rangeEnd, solveEvents.at(-1)!.end);
    const preparationMoveCount = preparationEvents.reduce((total, packet) => total + packet.moveCountEstimate, 0);
    const solveMoveCount = solveEvents.reduce((total, packet) => total + packet.moveCountEstimate, 0);
    const solvedStartLikely = preparationMoveCount >= Math.max(8, Math.floor(solveMoveCount * 0.18));
    const stages: VideoStage[] = [];

    if (solvedStartLikely) {
      let inspectionCut = preparationEvents.length;
      let largestPreparationGap = 0;
      preparationEvents.slice(1).forEach((event, eventIndex) => {
        const cut = eventIndex + 1;
        const gap = event.peakTime - preparationEvents[eventIndex].peakTime;
        const hasUsefulInspectionTail = preparationEvents.length - cut >= 2;
        if (hasUsefulInspectionTail && gap > Math.max(1.1, typicalGap * 2.1) && gap > largestPreparationGap) {
          inspectionCut = cut;
          largestPreparationGap = gap;
        }
      });
      if (inspectionCut === preparationEvents.length && preparationEvents.length >= 10) {
        inspectionCut = Math.max(2, Math.floor(preparationEvents.length * 0.78));
      }
      const scrambleEvents = preparationEvents.slice(0, inspectionCut);
      const inspectionEvents = preparationEvents.slice(inspectionCut);
      stages.push({
        kind: 'scramble',
        start: Math.max(rangeStart, scrambleEvents[0]?.start ?? rangeStart),
        end: scrambleEvents.at(-1)?.end ?? start,
        eventIds: scrambleEvents.map((event) => event.id),
      });
      stages.push({
        kind: 'inspection',
        start: scrambleEvents.at(-1)?.end ?? rangeStart,
        end: start,
        eventIds: inspectionEvents.map((event) => event.id),
      });
    } else {
      stages.push({
        kind: 'inspection',
        start: Math.max(rangeStart, preparationEvents[0]?.start ?? rangeStart),
        end: start,
        eventIds: preparationEvents.map((event) => event.id),
      });
    }
    stages.push({
      kind: 'solve',
      start,
      end,
      eventIds: solveEvents.map((event) => event.id),
    });

    return {
      id: index + 1,
      start,
      end,
      eventIds: solveEvents.map((event) => event.id),
      confidence: Math.round(Math.min(94, 56 + solveMoveCount * 0.38 + Math.min(14, selectedPause))),
      startState: solvedStartLikely
        ? 'solved-likely' as const
        : preparationEvents.length
          ? 'scrambled-likely' as const
          : 'unknown' as const,
      stages,
    };
  });

  return {
    windows,
    defaultWindowId: windows.at(-1)?.id ?? null,
    pauseThreshold: sessionPauseThreshold,
  };
}

export async function decodeVideoMotion(video: HTMLVideoElement, options: DecodeOptions): Promise<VideoDecodeResult> {
  if (!Number.isFinite(video.duration) || video.duration <= 0 || !video.videoWidth || !video.videoHeight) {
    throw new Error('Attendi che il video sia pronto prima di avviare l’analisi.');
  }

  const startTime = Math.max(0, Math.min(options.startTime, video.duration));
  const endTime = Math.max(startTime, Math.min(options.endTime, video.duration));
  const duration = endTime - startTime;
  if (duration < 1) throw new Error('Seleziona almeno un secondo di video da analizzare.');

  // Il set di calibrazione include riprese lente a 30 fps e veloci a 60 fps.
  // Circa 16 campioni al secondo conservano i picchi delle fingertrick veloci
  // senza far crescere oltre misura l'analisi locale dei filmati lunghi.
  const sampleInterval = Math.max(0.06, duration / 1050);
  const analysisPass = Math.max(0, Math.floor(options.analysisPass ?? 0));
  const samplePhases = [0, 1 / 3, 2 / 3, 1 / 6, 1 / 2, 5 / 6];
  const sampleOffset = samplePhases[analysisPass % samplePhases.length] * sampleInterval;
  const sampleCount = Math.max(2, Math.floor((duration - sampleOffset) / sampleInterval) + 1);
  const portrait = video.videoHeight >= video.videoWidth;
  const canvas = document.createElement('canvas');
  canvas.width = portrait ? 96 : 128;
  canvas.height = portrait ? 128 : 96;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Il browser non supporta l’analisi dei fotogrammi.');
  const handCanvas = document.createElement('canvas');
  handCanvas.width = portrait ? 384 : 512;
  handCanvas.height = portrait ? 512 : 384;
  const handContext = handCanvas.getContext('2d');

  const sourceWidth = video.videoWidth * (portrait ? 0.88 : 0.74);
  const sourceHeight = video.videoHeight * (portrait ? 0.68 : 0.86);
  const cropJitters = [0, -0.012, 0.012, 0.006, -0.006, 0.018];
  const cropJitter = cropJitters[analysisPass % cropJitters.length];
  const sourceX = Math.max(0, Math.min(
    video.videoWidth - sourceWidth,
    (video.videoWidth - sourceWidth) / 2 + video.videoWidth * cropJitter,
  ));
  const baseSourceY = portrait
    ? Math.max(0, Math.min(video.videoHeight - sourceHeight, video.videoHeight * 0.08))
    : (video.videoHeight - sourceHeight) / 2;
  const sourceY = Math.max(0, Math.min(
    video.videoHeight - sourceHeight,
    baseSourceY + video.videoHeight * cropJitter * 0.45,
  ));

  const originalTime = video.currentTime;
  const wasPaused = video.paused;
  video.pause();
  const samples: MotionSample[] = [];
  let previous: FrameSignature | null = null;
  let handTracker: Awaited<ReturnType<typeof createHandMotionTracker>> | null = null;
  let handTrackingMessage: string | undefined;
  let framesWithHands = 0;

  try {
    handTracker = await createHandMotionTracker();
  } catch {
    handTrackingMessage = 'Il modello mani non è stato caricato: questa analisi usa il solo cambiamento del cubo.';
  }

  try {
    for (let index = 0; index < sampleCount; index += 1) {
      const time = Math.min(endTime, startTime + sampleOffset + index * sampleInterval);
      await waitForSeek(video, time);
      context.drawImage(
        video,
        sourceX,
        sourceY,
        sourceWidth,
        sourceHeight,
        0,
        0,
        canvas.width,
        canvas.height,
      );
      const current = frameSignature(context, canvas.width, canvas.height);
      const measurement = previous
        ? frameDifference(previous, current, canvas.width, canvas.height)
        : { score: 0, coverage: 0, centerBias: 1, changeCentroidX: 0.5, changeCentroidY: 0.5 };
      let handMeasurement = {
        handMotion: 0,
        fingerMotion: 0,
        wristMotion: 0,
        handCount: 0,
        dominantHand: 'unknown' as HandSide,
        handDirection: 'mixed' as HandDirection,
      };
      if (handTracker && handContext) {
        try {
          handContext.drawImage(video, 0, 0, video.videoWidth, video.videoHeight, 0, 0, handCanvas.width, handCanvas.height);
          handMeasurement = handTracker.sample(handCanvas, time * 1000);
          if (handMeasurement.handCount > 0) framesWithHands += 1;
        } catch {
          handTracker.close();
          handTracker = null;
          handTrackingMessage = 'Il tracciamento delle mani si è interrotto; il decoder ha continuato con le variazioni del cubo.';
        }
      }
      samples.push({
        time,
        difference: measurement.score,
        cubeDifference: measurement.score,
        coverage: measurement.coverage,
        centerBias: measurement.centerBias,
        changeCentroidX: measurement.changeCentroidX,
        changeCentroidY: measurement.changeCentroidY,
        visibleColors: current.visibleColors,
        topFaceColors: current.topFaceColors,
        faceGrids: current.faceGrids.map((grid) => ({ ...grid, time })),
        ...handMeasurement,
      });
      previous = current;
      options.onProgress?.((index + 1) / sampleCount);
    }
  } finally {
    handTracker?.close();
    await waitForSeek(video, originalTime).catch(() => undefined);
    if (!wasPaused) await video.play().catch(() => undefined);
  }

  const fusedSamples = fuseMotionEvidence(samples);
  return {
    ...detectMotionEvents(fusedSamples, sampleInterval),
    sampleInterval,
    analyzedRegion: 'cube-focus',
    handTracking: {
      available: framesWithHands > 0,
      framesWithHands,
      totalFrames: sampleCount,
      message: handTrackingMessage,
    },
  };
}
