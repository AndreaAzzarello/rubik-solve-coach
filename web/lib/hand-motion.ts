export type HandSide = 'left' | 'right' | 'both' | 'unknown';

export type HandDirection = 'left' | 'right' | 'up' | 'down' | 'mixed';

export type HandPoint = {
  x: number;
  y: number;
  z: number;
};

export type TrackedHand = {
  side: Exclude<HandSide, 'both'>;
  landmarks: HandPoint[];
};

export type HandFrame = {
  hands: TrackedHand[];
};

export type HandMotionMeasurement = {
  handMotion: number;
  fingerMotion: number;
  wristMotion: number;
  handCount: number;
  dominantHand: HandSide;
  handDirection: HandDirection;
};

export type HandMotionTracker = {
  sample: (source: HTMLVideoElement | HTMLCanvasElement, timestampMs: number) => HandMotionMeasurement;
  close: () => void;
};

const PALM_LANDMARKS = [0, 5, 9, 13, 17] as const;
const FINGER_LANDMARKS = [2, 3, 4, 6, 7, 8, 10, 11, 12, 14, 15, 16, 18, 19, 20] as const;
const FINGERTIPS = [4, 8, 12, 16, 20] as const;
const MEDIAPIPE_WASM_ROOT = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm';
const HAND_LANDMARKER_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

const zeroMeasurement = (handCount = 0): HandMotionMeasurement => ({
  handMotion: 0,
  fingerMotion: 0,
  wristMotion: 0,
  handCount,
  dominantHand: 'unknown',
  handDirection: 'mixed',
});

const distance = (left: HandPoint, right: HandPoint) => Math.hypot(
  left.x - right.x,
  left.y - right.y,
  left.z - right.z,
);

function meanPoint(points: HandPoint[]) {
  if (!points.length) return { x: 0, y: 0, z: 0 };
  return points.reduce(
    (total, point) => ({ x: total.x + point.x, y: total.y + point.y, z: total.z + point.z }),
    { x: 0, y: 0, z: 0 },
  );
}

function averagePoint(points: HandPoint[]) {
  const total = meanPoint(points);
  return {
    x: total.x / Math.max(1, points.length),
    y: total.y / Math.max(1, points.length),
    z: total.z / Math.max(1, points.length),
  };
}

function vector(from: HandPoint, to: HandPoint) {
  return { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z };
}

function vectorLength(value: HandPoint) {
  return Math.hypot(value.x, value.y, value.z);
}

function directionFromVector(value: HandPoint): HandDirection {
  const horizontal = Math.abs(value.x);
  const vertical = Math.abs(value.y);
  if (Math.max(horizontal, vertical) < 0.003) return 'mixed';
  if (horizontal > vertical * 1.25) return value.x > 0 ? 'right' : 'left';
  if (vertical > horizontal * 1.25) return value.y > 0 ? 'down' : 'up';
  return 'mixed';
}

function matchPreviousHand(current: TrackedHand, previous: TrackedHand[], used: Set<number>) {
  let bestIndex = -1;
  let bestCost = Number.POSITIVE_INFINITY;
  previous.forEach((candidate, index) => {
    if (used.has(index)) return;
    const sidePenalty = candidate.side === current.side || candidate.side === 'unknown' || current.side === 'unknown' ? 0 : 0.16;
    const cost = distance(current.landmarks[0], candidate.landmarks[0]) + sidePenalty;
    if (cost < bestCost) {
      bestCost = cost;
      bestIndex = index;
    }
  });
  return bestIndex;
}

/**
 * Confronta due set di landmark senza dipendere da MediaPipe. Il movimento
 * rigido del palmo e quello residuo delle dita restano due segnali distinti:
 * questo evita che un semplice regrip venga scambiato automaticamente per una
 * fingertrick.
 */
export function measureHandMotion(previous: HandFrame | null, current: HandFrame): HandMotionMeasurement {
  if (!previous?.hands.length || !current.hands.length) return zeroMeasurement(current.hands.length);

  const usedPrevious = new Set<number>();
  const measurements: Array<HandMotionMeasurement & { score: number; directionVector: HandPoint }> = [];

  current.hands.forEach((hand) => {
    if (hand.landmarks.length < 21) return;
    const matchIndex = matchPreviousHand(hand, previous.hands, usedPrevious);
    if (matchIndex < 0) return;
    const oldHand = previous.hands[matchIndex];
    if (oldHand.landmarks.length < 21) return;
    usedPrevious.add(matchIndex);

    const oldPalm = averagePoint(PALM_LANDMARKS.map((index) => oldHand.landmarks[index]));
    const newPalm = averagePoint(PALM_LANDMARKS.map((index) => hand.landmarks[index]));
    const palmDelta = vector(oldPalm, newPalm);
    const palmScale = Math.max(
      0.035,
      distance(hand.landmarks[0], hand.landmarks[9]),
      distance(hand.landmarks[5], hand.landmarks[17]) * 0.72,
    );
    const wristMotion = vectorLength(palmDelta) / palmScale;

    const residualVectors = FINGER_LANDMARKS.map((index) => {
      const landmarkDelta = vector(oldHand.landmarks[index], hand.landmarks[index]);
      return {
        x: landmarkDelta.x - palmDelta.x,
        y: landmarkDelta.y - palmDelta.y,
        z: landmarkDelta.z - palmDelta.z,
      };
    });
    const fingerMotion = residualVectors.reduce((total, value) => total + vectorLength(value), 0)
      / residualVectors.length
      / palmScale;
    const tipDirection = averagePoint(FINGERTIPS.map((index) => {
      const landmarkDelta = vector(oldHand.landmarks[index], hand.landmarks[index]);
      return {
        x: landmarkDelta.x - palmDelta.x,
        y: landmarkDelta.y - palmDelta.y,
        z: landmarkDelta.z - palmDelta.z,
      };
    }));
    const score = fingerMotion * 1.18 + wristMotion * 0.54;

    measurements.push({
      handMotion: score,
      fingerMotion,
      wristMotion,
      handCount: current.hands.length,
      dominantHand: hand.side,
      handDirection: directionFromVector(tipDirection),
      score,
      directionVector: tipDirection,
    });
  });

  if (!measurements.length) return zeroMeasurement(current.hands.length);
  measurements.sort((left, right) => right.score - left.score);
  const primary = measurements[0];
  const secondary = measurements[1];
  const bothActive = Boolean(secondary && secondary.score >= primary.score * 0.68);
  return {
    handMotion: primary.handMotion + (secondary?.handMotion ?? 0) * 0.24,
    fingerMotion: primary.fingerMotion + (secondary?.fingerMotion ?? 0) * 0.2,
    wristMotion: primary.wristMotion + (secondary?.wristMotion ?? 0) * 0.16,
    handCount: current.hands.length,
    dominantHand: bothActive ? 'both' : primary.dominantHand,
    handDirection: bothActive && secondary?.handDirection !== primary.handDirection ? 'mixed' : primary.handDirection,
  };
}

function normalizeSide(categoryName?: string): Exclude<HandSide, 'both'> {
  const normalized = categoryName?.toLowerCase();
  if (normalized === 'left' || normalized === 'right') return normalized;
  return 'unknown';
}

export async function createHandMotionTracker(): Promise<HandMotionTracker> {
  const { FilesetResolver, HandLandmarker } = await import('@mediapipe/tasks-vision');
  const fileset = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_ROOT);
  const landmarker = await HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: HAND_LANDMARKER_MODEL },
    runningMode: 'VIDEO',
    numHands: 2,
    minHandDetectionConfidence: 0.42,
    minHandPresenceConfidence: 0.42,
    minTrackingConfidence: 0.38,
  });
  let previous: HandFrame | null = null;
  let lastTimestamp = -1;

  return {
    sample(source, timestampMs) {
      const monotonicTimestamp = Math.max(lastTimestamp + 1, Math.round(timestampMs));
      lastTimestamp = monotonicTimestamp;
      const result = landmarker.detectForVideo(source, monotonicTimestamp);
      const current: HandFrame = {
        hands: result.landmarks.map((landmarks, index) => ({
          side: normalizeSide(result.handedness[index]?.[0]?.categoryName),
          landmarks: landmarks.map((point) => ({ x: point.x, y: point.y, z: point.z })),
        })),
      };
      const measurement = measureHandMotion(previous, current);
      previous = current;
      return measurement;
    },
    close() {
      landmarker.close();
    },
  };
}
