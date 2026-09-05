import {
  type HandDirection,
  type HandSide,
  createHandMotionTracker,
} from './hand-motion.ts';
import {
  type FaceGridObservation,
  type InspectionReconstruction,
  reconstructInspectionState,
} from './inspection-state.ts';
import {
  buildInitialColorCalibration,
  classifyBalancedCubeFacelets,
  classifyCalibratedColor,
  createAdaptiveColorClassifier,
  sampleCentralRoiRgb,
  FALLBACK_REFERENCE,
  type RgbSample,
} from './color-calibration.ts';
import {
  CANONICAL_FACE_COLOR,
  CUBE_COLORS,
  CUBE_FACES,
  type CubeColor,
  type Face,
} from './cube.ts';

export type MotionSample = {
  time: number;
  difference: number;
  sharpness?: number;
  hasTemporalReference?: boolean;
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

export type ObservedCubeColor = CubeColor;
export type ObservedColorCoverage = Record<ObservedCubeColor, number>;

export type CubeObservationSummary = {
  start: number;
  end: number;
  sampledFrames: number;
  stableFrames: number;
  sharpFrames: number;
  multiFaceFrames: number;
  detectedColors: ObservedCubeColor[];
  coverage: ObservedColorCoverage;
  confidence: number;
  patternStatus: 'usable' | 'partial' | 'insufficient';
  keyframes: InspectionKeyframe[];
  reconstruction: InspectionReconstruction;
};

export type InspectionKeyframe = {
  id: string;
  time: number;
  faceColors: ObservedCubeColor[];
  faceCount: number;
  visibleCells: number;
  confidence: number;
  novelty: number;
};

export type InspectionEndDetection = {
  time: number;
  source: 'state-change' | 'motion-density' | 'segmentation' | 'fallback';
  confidence: number;
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
  sharpness: number;
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

const OBSERVED_COLORS = CUBE_COLORS;
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
  rawColor?: RgbSample;
};

function emptyColorCoverage(): ObservedColorCoverage {
  return { white: 0, red: 0, green: 0, yellow: 0, orange: 0, blue: 0 };
}

const median = (values: number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export function stickerComponents(labels: Int8Array, width: number, height: number, pixels?: Uint8ClampedArray) {
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
    const passesShape = (
      area >= 4
      // 0.055 escludeva del tutto le inquadrature molto ravvicinate (il cubo
      // che riempie quasi tutto il fotogramma produce sticker singoli più
      // grandi del 5.5% dell'area totale). 0.16 lascia margine fino a un
      // primo piano stretto, restando comunque ben sotto le dimensioni di un
      // blob di sfondo uniforme.
      && area <= width * height * 0.16
      && componentWidth >= 2
      && componentHeight >= 2
      && aspect >= 0.32
      && aspect <= 3.1
      && fill >= 0.28
    );
    if (passesShape) {
      components.push({
        color: OBSERVED_COLORS[label],
        area,
        x: sumX / area,
        y: sumY / area,
        width: componentWidth,
        height: componentHeight,
        rawColor: pixels ? sampleCentralRoiRgb(pixels, width, height, {
          x: minimumX,
          y: minimumY,
          width: componentWidth,
          height: componentHeight,
        }, 0.25) ?? undefined : undefined,
      });
    }
  }
  return components;
}

// Quando due sticker adiacenti dello stesso colore si toccano (frequente nei
// primi piani, dove il sottile bordo nero tra le caselle non si distingue
// bene), il flood-fill li fonde in un unico blob troppo grande, che viene
// scartato dai controlli di forma. Il colore vero, però, è ancora presente
// nei pixel nel punto esatto dove la geometria prevede quella casella: lo
// leggiamo direttamente lì invece di rinunciare alla casella.
function sampleVirtualCell(
  labels: Int8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  radius: number,
): { label: number; confidence: number } | null {
  const minX = Math.max(0, Math.round(x - radius));
  const maxX = Math.min(width - 1, Math.round(x + radius));
  const minY = Math.max(0, Math.round(y - radius));
  const maxY = Math.min(height - 1, Math.round(y + radius));
  if (maxX <= minX || maxY <= minY) return null;
  const counts = new Map<number, number>();
  let total = 0;
  for (let py = minY; py <= maxY; py += 1) {
    for (let px = minX; px <= maxX; px += 1) {
      const label = labels[py * width + px];
      if (label < 0) continue;
      counts.set(label, (counts.get(label) ?? 0) + 1);
      total += 1;
    }
  }
  if (total < 10) return null;
  let bestLabel = -1;
  let bestCount = 0;
  counts.forEach((count, label) => {
    if (count > bestCount) { bestCount = count; bestLabel = label; }
  });
  const share = bestCount / total;
  if (bestLabel < 0 || share < 0.72) return null;
  return { label: bestLabel, confidence: share };
}

// Il colore del centro è sempre noto in anticipo (i centri non si spostano
// mai l'uno rispetto all'altro). Confrontando il suo campione RGB REALE in
// questo fotogramma con il valore di riferimento, stimiamo un guadagno per
// canale che corregge riflessi o luce forte specifici di questa ripresa,
// prima di riclassificare le altre 8 caselle con la stessa correzione.
function applyLocalCenterCalibration(
  centerColor: ObservedCubeColor,
  rawColors: Array<RgbSample | null>,
  colors: Array<ObservedCubeColor | null>,
  cellConfidences: number[],
) {
  const centerRaw = rawColors[4];
  const reference = FALLBACK_REFERENCE[centerColor];
  if (!centerRaw || !reference) return;
  const gain = {
    red: Math.min(2.2, Math.max(0.45, reference.red / Math.max(24, centerRaw.red))),
    green: Math.min(2.2, Math.max(0.45, reference.green / Math.max(24, centerRaw.green))),
    blue: Math.min(2.2, Math.max(0.45, reference.blue / Math.max(24, centerRaw.blue))),
  };
  // Un guadagno vicino a 1 su tutti i canali significa che il fotogramma è
  // già vicino alle condizioni di riferimento: non c'è nulla da correggere e
  // rischieremmo solo di introdurre rumore.
  if (Math.abs(gain.red - 1) < 0.08 && Math.abs(gain.green - 1) < 0.08 && Math.abs(gain.blue - 1) < 0.08) return;
  for (let index = 0; index < 9; index += 1) {
    if (index === 4) continue;
    const raw = rawColors[index];
    if (!raw) continue;
    const corrected: RgbSample = {
      red: Math.max(0, Math.min(255, Math.round(raw.red * gain.red))),
      green: Math.max(0, Math.min(255, Math.round(raw.green * gain.green))),
      blue: Math.max(0, Math.min(255, Math.round(raw.blue * gain.blue))),
    };
    const classified = classifyCalibratedColor(corrected, FALLBACK_REFERENCE);
    if (classified.color !== colors[index] && classified.confidence >= 0.42) {
      colors[index] = classified.color;
      cellConfidences[index] = Math.round(Math.min(90, Math.max(cellConfidences[index] ?? 0, classified.confidence * 90)));
    }
  }
}

type Point = { x: number; y: number };

// Guscio convesso (monotone chain). Serve a ottenere la silhouette esterna del
// cubo a partire dagli sticker riconosciuti.
function convexHull(points: Point[]): Point[] {
  if (points.length < 3) return points;
  const sorted = [...points].sort((a, b) => (a.x - b.x) || (a.y - b.y));
  const cross = (o: Point, a: Point, b: Point) => (
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  );
  const build = (list: Point[]) => {
    const chain: Point[] = [];
    list.forEach((point) => {
      while (chain.length >= 2 && cross(chain[chain.length - 2], chain[chain.length - 1], point) <= 0) {
        chain.pop();
      }
      chain.push(point);
    });
    chain.pop();
    return chain;
  };
  return [...build(sorted), ...build([...sorted].reverse())];
}

function polygonArea(polygon: Point[]): number {
  let total = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    total += current.x * next.y - next.x * current.y;
  }
  return Math.abs(total) / 2;
}

// Riduce il guscio a `target` vertici togliendo ogni volta quello la cui
// rimozione fa perdere meno area: il risultato approssima la silhouette con un
// poligono semplice (per un cubo di tre quarti, un esagono).
function simplifyPolygon(polygon: Point[], target: number): Point[] {
  const vertices = [...polygon];
  while (vertices.length > target) {
    let bestIndex = 0;
    let bestLoss = Infinity;
    for (let index = 0; index < vertices.length; index += 1) {
      const previous = vertices[(index - 1 + vertices.length) % vertices.length];
      const current = vertices[index];
      const next = vertices[(index + 1) % vertices.length];
      const loss = Math.abs(
        (current.x - previous.x) * (next.y - previous.y)
        - (current.y - previous.y) * (next.x - previous.x),
      ) / 2;
      if (loss < bestLoss) { bestLoss = loss; bestIndex = index; }
    }
    vertices.splice(bestIndex, 1);
  }
  return vertices;
}

export type FaceQuad = { origin: Point; right: Point; down: Point };

export type CubeSilhouette = { quads: FaceQuad[]; hexagon: Point[] };

/**
 * Un cubo visto di tre quarti ha una silhouette esagonale. I suoi 6 vertici
 * più lo spigolo interno (l'angolo del cubo rivolto verso l'osservatore)
 * definiscono esattamente le TRE facce visibili: (C,V0,V1,V2), (C,V2,V3,V4),
 * (C,V4,V5,V0), dove C è lo spigolo interno.
 *
 * Segmentare prima la silhouette e poi leggere ogni faccia impedisce per
 * costruzione che una griglia 3x3 finisca a cavallo di due facce - il difetto
 * principale dell'approccio che parte dalle coppie di sticker vicini.
 */
function detectCubeFaceQuads(components: StickerComponent[]): CubeSilhouette {
  const empty: CubeSilhouette = { quads: [], hexagon: [] };
  if (components.length < 6) return empty;
  const areas = components.map((component) => component.area).sort((a, b) => a - b);
  const medianArea = areas[Math.floor(areas.length / 2)];
  const plausible = components.filter((component) => (
    component.area >= medianArea * 0.3 && component.area <= medianArea * 3.6
  ));
  if (plausible.length < 6) return empty;
  const typicalSide = Math.sqrt(medianArea);
  // Teniamo solo il gruppo spazialmente compatto: gli sticker del cubo stanno
  // entro poche celle l'uno dall'altro, i frammenti di sfondo no.
  const radius = typicalSide * 3.6;
  let cluster: StickerComponent[] = [];
  plausible.forEach((anchor) => {
    const members = plausible.filter((component) => (
      Math.hypot(component.x - anchor.x, component.y - anchor.y) <= radius
    ));
    if (members.length > cluster.length) cluster = members;
  });
  if (cluster.length < 6) return empty;

  // La silhouette esterna passa per i bordi degli sticker periferici, non per
  // i loro centri: usiamo i quattro angoli del riquadro di ciascuno.
  const points: Point[] = [];
  cluster.forEach((component) => {
    const halfWidth = component.width / 2;
    const halfHeight = component.height / 2;
    points.push(
      { x: component.x - halfWidth, y: component.y - halfHeight },
      { x: component.x + halfWidth, y: component.y - halfHeight },
      { x: component.x - halfWidth, y: component.y + halfHeight },
      { x: component.x + halfWidth, y: component.y + halfHeight },
    );
  });
  const hull = convexHull(points);
  if (hull.length < 6) return empty;
  const hexagon = simplifyPolygon(hull, 6);
  if (hexagon.length !== 6) return empty;
  if (polygonArea(hexagon) < typicalSide * typicalSide * 4) return empty;

  // Per ciascuna delle due alternanze possibili stimiamo lo spigolo interno:
  // se (C,Va,Vb,Vc) è un parallelogramma allora C = Va + Vc - Vb. Le tre stime
  // devono concordare; scegliamo l'alternanza in cui concordano di più.
  let bestQuads: FaceQuad[] = [];
  let bestSpread = Infinity;
  for (let offset = 0; offset < 2; offset += 1) {
    const estimates: Point[] = [];
    for (let step = 0; step < 3; step += 1) {
      const a = hexagon[(offset + step * 2) % 6];
      const b = hexagon[(offset + step * 2 + 1) % 6];
      const c = hexagon[(offset + step * 2 + 2) % 6];
      estimates.push({ x: a.x + c.x - b.x, y: a.y + c.y - b.y });
    }
    const center = {
      x: estimates.reduce((total, point) => total + point.x, 0) / 3,
      y: estimates.reduce((total, point) => total + point.y, 0) / 3,
    };
    const spread = estimates.reduce(
      (total, point) => total + Math.hypot(point.x - center.x, point.y - center.y),
      0,
    ) / 3;
    if (spread >= bestSpread) continue;
    const quads: FaceQuad[] = [];
    for (let step = 0; step < 3; step += 1) {
      const a = hexagon[(offset + step * 2) % 6];
      const c = hexagon[(offset + step * 2 + 2) % 6];
      // Una faccia copre 3 celle per lato: il passo è un terzo del lato.
      quads.push({
        origin: center,
        right: { x: (a.x - center.x) / 3, y: (a.y - center.y) / 3 },
        down: { x: (c.x - center.x) / 3, y: (c.y - center.y) / 3 },
      });
    }
    const plausibleScale = quads.every((quad) => {
      const rightLength = Math.hypot(quad.right.x, quad.right.y);
      const downLength = Math.hypot(quad.down.x, quad.down.y);
      return rightLength >= typicalSide * 0.55 && rightLength <= typicalSide * 2.6
        && downLength >= typicalSide * 0.55 && downLength <= typicalSide * 2.6;
    });
    if (!plausibleScale) continue;
    bestSpread = spread;
    bestQuads = quads;
  }
  // Lo spigolo interno stimato deve cadere dentro la silhouette: se le tre
  // stime divergono troppo, il poligono non era un cubo di tre quarti.
  if (bestSpread > typicalSide * 1.5) return empty;
  return { quads: bestQuads, hexagon };
}

export function detectFaceGrids(labels: Int8Array, width: number, height: number, pixels?: Uint8ClampedArray) {
  const minimumStickerArea = Math.max(6, width * height * 0.00012);
  const components = stickerComponents(labels, width, height, pixels)
    .filter((component) => component.area >= minimumStickerArea)
    .sort((left, right) => right.area - left.area)
    .slice(0, 72);
  if (components.length < 6) return [];
  const candidates: Array<Omit<FaceGridObservation, 'time'> & { score: number }> = [];

  components.forEach((center) => {
    // Mani, pelle e sfondo generano molti frammenti colorati piccoli. Usare la
    // mediana globale delle aree faceva quindi scartare proprio gli sticker del
    // cubo. Ogni possibile centro costruisce invece il proprio gruppo locale di
    // componenti con dimensioni e distanza compatibili.
    const local = components.map((component) => {
      const areaRatio = component.area / Math.max(1, center.area);
      const widthRatio = component.width / Math.max(1, center.width);
      const heightRatio = component.height / Math.max(1, center.height);
      const distance = Math.hypot(component.x - center.x, component.y - center.y);
      const compatible = areaRatio >= 0.16
        && areaRatio <= 6.2
        && widthRatio >= 0.24
        && widthRatio <= 4.2
        && heightRatio >= 0.24
        && heightRatio <= 4.2
        && distance <= Math.min(width, height) * 0.46;
      return { component, distance, compatible };
    }).filter((candidate) => candidate.compatible)
      .sort((left, right) => left.distance - right.distance)
      .slice(0, 36)
      .map((candidate) => candidate.component);
    if (local.length < 6) return;
    const vectors = local
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
      .slice(0, 10);

    basisVectors.forEach((right) => basisVectors.forEach((down) => {
      if (right.component === down.component) return;
      const cosine = Math.abs((right.dx * down.dx + right.dy * down.dy) / (right.length * down.length));
      const determinant = right.dx * down.dy - right.dy * down.dx;
      const ratio = right.length / down.length;
      if (cosine > 0.6 || determinant <= 1.8 || ratio < 0.5 || ratio > 2) return;
      // Il passo fra celle adiacenti deve essere compatibile con la dimensione
      // dello sticker centrale: su una faccia reale vale circa un lato di
      // sticker piu' la fuga. Senza questo vincolo l'algoritmo accetta coppie
      // di sticker non adiacenti, producendo griglie molto piu' grandi della
      // faccia (fino a coprire l'intera inquadratura).
      const centerSide = Math.max(3, (center.width + center.height) / 2);
      const stepRatioRight = right.length / centerSide;
      const stepRatioDown = down.length / centerSide;
      if (
        stepRatioRight < 0.62 || stepRatioRight > 2.15
        || stepRatioDown < 0.62 || stepRatioDown > 2.15
      ) return;
      const tolerance = Math.max(2.2, Math.min(right.length, down.length) * 0.3);
      const used = new Set<StickerComponent>();
      const colors = Array<ObservedCubeColor | null>(9).fill(null);
      const rawColors = Array<RgbSample | null>(9).fill(null);
      const cellConfidences = Array<number>(9).fill(0);
      let visibleCells = 0;
      let residual = 0;
      for (let row = -1; row <= 1; row += 1) {
        for (let column = -1; column <= 1; column += 1) {
          const targetX = center.x + right.dx * column + down.dx * row;
          const targetY = center.y + right.dy * column + down.dy * row;
          let best: StickerComponent | null = null;
          let bestDistance = tolerance;
          for (const component of local) {
            if (used.has(component)) continue;
            const distance = Math.hypot(component.x - targetX, component.y - targetY);
            if (distance < bestDistance) {
              best = component;
              bestDistance = distance;
            }
          }
          if (best) {
            used.add(best);
            const cellIndex = (row + 1) * 3 + column + 1;
            colors[cellIndex] = best.color;
            rawColors[cellIndex] = best.rawColor ?? null;
            const geometryConfidence = Math.max(0, 1 - bestDistance / tolerance);
            const areaRatio = best.area / Math.max(1, center.area);
            const areaConfidence = Math.max(0, 1 - Math.min(1, Math.abs(Math.log(Math.max(0.08, areaRatio))) / 1.7));
            cellConfidences[cellIndex] = Math.round(Math.min(96, Math.max(35, geometryConfidence * 72 + areaConfidence * 24)));
            visibleCells += 1;
            residual += bestDistance / tolerance;
          } else {
            const sampleRadius = Math.max(2, Math.min(right.length, down.length) * 0.22);
            const virtual = sampleVirtualCell(labels, width, height, targetX, targetY, sampleRadius);
            if (virtual) {
              const cellIndex = (row + 1) * 3 + column + 1;
              colors[cellIndex] = OBSERVED_COLORS[virtual.label];
              rawColors[cellIndex] = pixels ? sampleCentralRoiRgb(pixels, width, height, {
                x: Math.round(targetX - sampleRadius),
                y: Math.round(targetY - sampleRadius),
                width: Math.round(sampleRadius * 2),
                height: Math.round(sampleRadius * 2),
              }, 0.4) ?? null : null;
              cellConfidences[cellIndex] = Math.round(Math.min(68, Math.max(30, virtual.confidence * 70)));
              visibleCells += 1;
              residual += 0.6;
            }
          }
        }
      }
      if (visibleCells < 6 || colors[4] !== center.color) return;
      applyLocalCenterCalibration(center.color, rawColors, colors, cellConfidences);
      const fit = Math.max(0, 1 - residual / visibleCells);
      const score = visibleCells / 9 * 0.78 + fit * 0.22;
      candidates.push({
        centerColor: center.color,
        colors,
        rawColors,
        cellConfidences,
        visibleCells,
        confidence: Math.round(Math.min(94, Math.max(42, score * 100))),
        imageX: center.x,
        imageY: center.y,
        rightX: right.dx,
        rightY: right.dy,
        downX: down.dx,
        downY: down.dy,
        score,
        gridSource: 'pairs',
      });
    }));
  });

  // Candidati dalla silhouette: segmentiamo prima il cubo nelle sue tre facce
  // visibili, poi leggiamo ciascuna separatamente. Per costruzione nessuna
  // griglia puo' cadere a cavallo di due facce.
  const silhouette = detectCubeFaceQuads(components);
  silhouette.quads.forEach((quad) => {
    const quadColors = Array<ObservedCubeColor | null>(9).fill(null);
    const quadRaw = Array<RgbSample | null>(9).fill(null);
    const quadConfidences = Array<number>(9).fill(0);
    let quadVisible = 0;
    let quadResidual = 0;
    const sampleRadius = Math.max(2, Math.min(
      Math.hypot(quad.right.x, quad.right.y),
      Math.hypot(quad.down.x, quad.down.y),
    ) * 0.3);
    // Il centro della faccia sta a un passo e mezzo dallo spigolo interno
    // lungo entrambi gli assi.
    const faceCenterX = quad.origin.x + (quad.right.x + quad.down.x) * 1.5;
    const faceCenterY = quad.origin.y + (quad.right.y + quad.down.y) * 1.5;
    for (let row = -1; row <= 1; row += 1) {
      for (let column = -1; column <= 1; column += 1) {
        const targetX = faceCenterX + quad.right.x * column + quad.down.x * row;
        const targetY = faceCenterY + quad.right.y * column + quad.down.y * row;
        const virtual = sampleVirtualCell(labels, width, height, targetX, targetY, sampleRadius);
        const cellIndex = (row + 1) * 3 + column + 1;
        if (!virtual) continue;
        quadColors[cellIndex] = OBSERVED_COLORS[virtual.label];
        quadRaw[cellIndex] = pixels ? sampleCentralRoiRgb(pixels, width, height, {
          x: Math.round(targetX - sampleRadius),
          y: Math.round(targetY - sampleRadius),
          width: Math.round(sampleRadius * 2),
          height: Math.round(sampleRadius * 2),
        }, 0.4) ?? null : null;
        quadConfidences[cellIndex] = Math.round(Math.min(90, Math.max(35, virtual.confidence * 90)));
        quadVisible += 1;
        quadResidual += 1 - virtual.confidence;
      }
    }
    const quadCenterColor = quadColors[4];
    if (quadVisible < 6 || !quadCenterColor) return;
    applyLocalCenterCalibration(quadCenterColor, quadRaw, quadColors, quadConfidences);
    const quadFit = Math.max(0, 1 - quadResidual / quadVisible);
    const quadScore = quadVisible / 9 * 0.78 + quadFit * 0.22;
    candidates.push({
      centerColor: quadCenterColor,
      colors: quadColors,
      rawColors: quadRaw,
      cellConfidences: quadConfidences,
      visibleCells: quadVisible,
      confidence: Math.round(Math.min(94, Math.max(42, quadScore * 100))),
      imageX: faceCenterX,
      imageY: faceCenterY,
      rightX: quad.right.x,
      rightY: quad.right.y,
      downX: quad.down.x,
      downY: quad.down.y,
      score: quadScore,
      gridSource: 'silhouette',
      silhouette: silhouette.hexagon,
    });
  });

  // Su un cubo stickerless due cubie dello stesso colore possono apparire come
  // un'unica regione. In quel caso la migliore ipotesi geometrica del singolo
  // frame non è sempre la faccia reale. Manteniamo poche alternative per centro:
  // la coerenza temporale e i vincoli fisici del cubo sceglieranno il cluster.
  const hypothesesPerCenter = new Map<ObservedCubeColor, number>();
  return candidates
    .sort((left, right) => right.score - left.score)
    .filter((candidate) => {
      const count = hypothesesPerCenter.get(candidate.centerColor) ?? 0;
      if (count >= 3) return false;
      hypothesesPerCenter.set(candidate.centerColor, count + 1);
      return true;
    })
    .slice(0, 18)
    .map((candidate) => ({
      centerColor: candidate.centerColor,
      colors: candidate.colors,
      rawColors: candidate.rawColors,
      cellConfidences: candidate.cellConfidences,
      visibleCells: candidate.visibleCells,
      confidence: candidate.confidence,
      imageX: candidate.imageX,
      imageY: candidate.imageY,
      rightX: candidate.rightX,
      rightY: candidate.rightY,
      downX: candidate.downX,
      downY: candidate.downY,
      gridSource: candidate.gridSource,
      silhouette: candidate.silhouette,
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

function frameSignature(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  includeFaceGrids = true,
): FrameSignature {
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
  const adaptiveSamples: RgbSample[] = [];
  const sampleStep = Math.max(2, Math.floor(Math.min(width, height) / 110));
  for (let y = Math.floor(height * 0.1); y <= Math.ceil(height * 0.9); y += sampleStep) {
    for (let x = Math.floor(width * 0.1); x <= Math.ceil(width * 0.9); x += sampleStep) {
      const offset = (y * width + x) * 4;
      adaptiveSamples.push({ red: data[offset], green: data[offset + 1], blue: data[offset + 2] });
    }
  }
  const classifyFrameColor = createAdaptiveColorClassifier(adaptiveSamples);

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
      const classification = classifyFrameColor({ red, green, blue });
      const color = classification?.color ?? null;
      if (color && (classification?.confidence ?? 0) >= 0.16) {
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
  let laplacianTotal = 0;
  let laplacianSquaredTotal = 0;
  let laplacianPixels = 0;
  const minX = Math.max(1, Math.floor(width * 0.08));
  const maxX = Math.min(width - 2, Math.ceil(width * 0.92));
  const minY = Math.max(1, Math.floor(height * 0.08));
  const maxY = Math.min(height - 2, Math.ceil(height * 0.92));
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const index = y * width + x;
      const laplacian = (
        luma[index] * 4
        - luma[index - 1]
        - luma[index + 1]
        - luma[index - width]
        - luma[index + width]
      );
      laplacianTotal += laplacian;
      laplacianSquaredTotal += laplacian * laplacian;
      laplacianPixels += 1;
    }
  }
  const laplacianMean = laplacianTotal / Math.max(1, laplacianPixels);
  const sharpness = Math.sqrt(Math.max(
    0,
    laplacianSquaredTotal / Math.max(1, laplacianPixels) - laplacianMean * laplacianMean,
  ));
  const faceGrids = includeFaceGrids ? detectFaceGrids(pixelLabels, width, height, data) : [];
  return {
    luma,
    chromaBlue,
    chromaRed,
    sharpness,
    visibleColors,
    topFaceColors,
    faceGrids: faceGrids.map((grid) => ({ ...grid, bundleSize: faceGrids.length })),
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

function rotateSignatureGrid(colors: Array<ObservedCubeColor | null>) {
  const signatures: string[] = [];
  let rotated = [...colors];
  for (let turn = 0; turn < 4; turn += 1) {
    signatures.push(rotated.map((color) => color?.[0] ?? '_').join(''));
    const next = Array<ObservedCubeColor | null>(9).fill(null);
    for (let row = 0; row < 3; row += 1) {
      for (let column = 0; column < 3; column += 1) {
        next[column * 3 + (2 - row)] = rotated[row * 3 + column];
      }
    }
    rotated = next;
  }
  return signatures.sort()[0];
}

export function selectInspectionKeyframes(samples: MotionSample[]): InspectionKeyframe[] {
  const framesWithGrids = samples.filter((sample) => (sample.faceGrids?.length ?? 0) >= 1);
  const measuredSharpness = framesWithGrids
    .map((sample) => sample.sharpness)
    .filter((value): value is number => Number.isFinite(value));
  const sharpnessFloor = percentile(measuredSharpness, 0.24);
  const sharpnessCeiling = Math.max(sharpnessFloor + 0.01, percentile(measuredSharpness, 0.88));
  const clearFrames = measuredSharpness.length >= 4
    ? framesWithGrids.filter((sample) => (sample.sharpness ?? sharpnessFloor) >= sharpnessFloor)
    : framesWithGrids;

  // Ogni passaggio del decoder può campionare quasi lo stesso istante. Per ciascun
  // tratto di mezzo secondo conserviamo la vista che contiene più caselle nitide.
  const bestByTimeWindow = new Map<number, { sample: MotionSample; quality: number }>();
  clearFrames.forEach((sample) => {
    const grids = sample.faceGrids ?? [];
    const visibleCells = grids.reduce((total, grid) => total + grid.visibleCells, 0);
    const confidence = grids.reduce((total, grid) => total + grid.confidence, 0) / Math.max(1, grids.length);
    const sharpnessRatio = measuredSharpness.length
      ? Math.min(1, Math.max(0, ((sample.sharpness ?? sharpnessFloor) - sharpnessFloor) / (sharpnessCeiling - sharpnessFloor)))
      : 0.5;
    const quality = visibleCells * 1.5 + confidence + grids.length * 12 + sharpnessRatio * 14;
    const bucket = Math.floor(sample.time / 0.48);
    const existing = bestByTimeWindow.get(bucket);
    if (!existing || quality > existing.quality) bestByTimeWindow.set(bucket, { sample, quality });
  });
  const candidates = [...bestByTimeWindow.values()]
    .map((candidate) => candidate.sample)
    .filter((sample, index, all) => all.findIndex((candidate) => (
      Math.abs(candidate.time - sample.time) < 0.045
      && (candidate.faceGrids ?? []).map((grid) => grid.centerColor).sort().join('-')
        === (sample.faceGrids ?? []).map((grid) => grid.centerColor).sort().join('-')
    )) === index);
  const selected: InspectionKeyframe[] = [];
  const remaining = [...candidates];
  const seenFaces = new Set<ObservedCubeColor>();
  const seenPatterns = new Set<string>();

  while (remaining.length && selected.length < 12) {
    const ranked = remaining.map((sample) => {
      const grids = sample.faceGrids ?? [];
      const patterns = grids.map((grid) => `${grid.centerColor}:${rotateSignatureGrid(grid.colors)}`);
      const newFaces = grids.filter((grid) => !seenFaces.has(grid.centerColor)).length;
      const newPatterns = patterns.filter((pattern) => !seenPatterns.has(pattern)).length;
      const visibleCells = grids.reduce((total, grid) => total + grid.visibleCells, 0);
      const confidence = grids.reduce((total, grid) => total + grid.confidence, 0) / Math.max(1, grids.length);
      const nearestSelected = selected.length
        ? Math.min(...selected.map((keyframe) => Math.abs(keyframe.time - sample.time)))
        : 3;
      const separation = Math.min(3, nearestSelected) / 3;
      const novelty = newFaces * 2 + newPatterns;
      const sharpnessRatio = measuredSharpness.length
        ? Math.min(1, Math.max(0, ((sample.sharpness ?? sharpnessFloor) - sharpnessFloor) / (sharpnessCeiling - sharpnessFloor)))
        : 0.5;
      return {
        sample,
        patterns,
        newFaces,
        newPatterns,
        visibleCells,
        confidence,
        novelty,
        score: confidence + visibleCells * 1.35 + grids.length * 11 + novelty * 13 + separation * 12 + sharpnessRatio * 10,
      };
    }).sort((left, right) => right.score - left.score);
    const best = ranked[0];
    if (!best) break;
    const grids = best.sample.faceGrids ?? [];
    const id = `${best.sample.time.toFixed(3)}-${grids.map((grid) => grid.centerColor[0]).sort().join('')}`;
    selected.push({
      id,
      time: best.sample.time,
      faceColors: grids.map((grid) => grid.centerColor),
      faceCount: grids.length,
      visibleCells: best.visibleCells,
      confidence: Math.round(best.confidence),
      novelty: best.novelty,
    });
    grids.forEach((grid) => seenFaces.add(grid.centerColor));
    best.patterns.forEach((pattern) => seenPatterns.add(pattern));
    for (let index = remaining.length - 1; index >= 0; index -= 1) {
      if (Math.abs(remaining[index].time - best.sample.time) < 0.42) remaining.splice(index, 1);
    }
  }

  return selected.sort((left, right) => left.time - right.time);
}

export function lastInspectionFrameTime(start: number, firstCubeChange: number, nominalFps = 60) {
  const frameDuration = 1 / Math.max(1, nominalFps);
  return Math.max(start, firstCubeChange - frameDuration);
}

export function buildInspectionSampleTimes(start: number, end: number, analysisPass = 0) {
  const duration = Math.max(0, end - start);
  if (duration <= 0.001) return [start];
  const targetCount = Math.min(48, Math.max(12, Math.ceil(duration * 4.2)));
  const step = duration / targetCount;
  const phases = [0, 0.5, 0.25, 0.75];
  const phase = phases[Math.max(0, Math.floor(analysisPass)) % phases.length];
  const offset = step * phase;
  const times: number[] = [];
  for (let time = start + offset; time <= end + 0.0001; time += step) {
    times.push(Math.min(end, time));
  }
  if (phase === 0 && times.at(-1)! < end - step * 0.25) times.push(end);
  return [...new Set(times.map((time) => Number(time.toFixed(4))))];
}

function rotateObservedGrid(colors: Array<ObservedCubeColor | null>) {
  const rotated = Array<ObservedCubeColor | null>(9).fill(null);
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      rotated[column * 3 + (2 - row)] = colors[row * 3 + column];
    }
  }
  return rotated;
}

function compareFacePatterns(
  reference: Array<ObservedCubeColor | null>,
  candidate: Array<ObservedCubeColor | null>,
) {
  let rotated = [...candidate];
  let best: { overlap: number; mismatches: number; ratio: number; score: number } | null = null;
  for (let turns = 0; turns < 4; turns += 1) {
    let overlap = 0;
    let mismatches = 0;
    for (let index = 0; index < 9; index += 1) {
      if (index === 4 || !reference[index] || !rotated[index]) continue;
      overlap += 1;
      if (reference[index] !== rotated[index]) mismatches += 1;
    }
    const ratio = mismatches / Math.max(1, overlap);
    const matches = overlap - mismatches;
    const score = matches * 2.2 - mismatches * 1.4 + overlap * 0.1;
    if (!best || score > best.score) best = { overlap, mismatches, ratio, score };
    rotated = rotateObservedGrid(rotated);
  }
  return best ?? { overlap: 0, mismatches: 0, ratio: 0, score: 0 };
}

function denseFaceTurnStart(events: MotionEvent[], start: number, end: number) {
  const faceTurns = events.filter((event) => (
    event.start >= start + 1.2
    && event.start <= end
    && event.motionKind === 'face-turn'
    && event.cubeStrength >= 28
  ));
  for (let index = 0; index < faceTurns.length; index += 1) {
    const first = faceTurns[index];
    const packet = faceTurns.filter((event) => (
      event.peakTime >= first.peakTime && event.peakTime <= first.peakTime + 2.4
    ));
    const estimatedMoves = packet.reduce((total, event) => total + Math.max(1, event.moveCountEstimate), 0);
    if (packet.length >= 3 && estimatedMoves >= 3) return first.start;
  }
  return null;
}

/**
 * Distingue una rotazione dell'intero cubo da una vera modifica degli sticker.
 * Una rotazione x/y/z conserva il pattern 3×3 di ogni centro (a meno di una
 * rotazione 2D); una face turn cambia invece almeno una parte di quel pattern.
 */
export function inferInspectionEnd(
  samples: MotionSample[],
  events: MotionEvent[],
  start: number,
  searchEnd: number,
  segmentationHint?: number | null,
): InspectionEndDetection {
  const captures = new Map<string, { time: number; grids: FaceGridObservation[] }>();
  samples
    .filter((sample) => sample.time >= start && sample.time <= searchEnd)
    .forEach((sample) => {
      (sample.faceGrids ?? []).forEach((grid) => {
        const captureId = grid.captureId ?? sample.time.toFixed(4);
        const capture = captures.get(captureId) ?? { time: sample.time, grids: [] };
        capture.grids.push(grid);
        captures.set(captureId, capture);
      });
    });

  const history = new Map<ObservedCubeColor, FaceGridObservation[]>();
  const orderedCaptures = [...captures.values()].sort((left, right) => left.time - right.time);
  let stateChange: number | null = null;

  for (const capture of orderedCaptures) {
    const changedVotes = new Map<ObservedCubeColor, number>();
    const unchanged = new Set<FaceGridObservation>();
    capture.grids.forEach((grid) => {
      if (grid.visibleCells < 6 || grid.confidence < 60 || capture.time < start + 0.8) {
        unchanged.add(grid);
        return;
      }
      const uniqueReferences = new Map<string, FaceGridObservation>();
      (history.get(grid.centerColor) ?? [])
        .filter((reference) => reference.time <= capture.time - 0.22)
        .forEach((reference) => {
          const key = reference.captureId ?? reference.time.toFixed(4);
          const existing = uniqueReferences.get(key);
          if (!existing || reference.confidence > existing.confidence) uniqueReferences.set(key, reference);
        });
      const references = [...uniqueReferences.values()].slice(-8);
      const comparisons = references
        .map((reference) => compareFacePatterns(reference.colors, grid.colors))
        .filter((comparison) => comparison.overlap >= 5);
      const agreesWithHistory = comparisons.some((comparison) => (
        comparison.mismatches <= 1 || comparison.ratio <= 0.18
      ));
      const changedReferences = comparisons.filter((comparison) => (
        comparison.mismatches >= 2 && comparison.ratio >= 0.28
      ));
      if (!agreesWithHistory && references.length >= 2 && changedReferences.length >= 2) {
        changedVotes.set(grid.centerColor, (changedVotes.get(grid.centerColor) ?? 0) + 1);
      } else {
        unchanged.add(grid);
      }
    });

    const changedFaces = [...changedVotes.entries()].filter(([, votes]) => votes >= 2);
    const nearbyCubeEvent = events.some((event) => (
      event.motionKind === 'face-turn'
      && event.cubeStrength >= 28
      && Math.abs(event.peakTime - capture.time) <= 0.7
    ));
    if (changedFaces.length >= 1 && nearbyCubeEvent) {
      stateChange = capture.time;
      break;
    }

    unchanged.forEach((grid) => {
      const faceHistory = history.get(grid.centerColor) ?? [];
      faceHistory.push(grid);
      history.set(grid.centerColor, faceHistory.slice(-24));
    });
  }

  const motionStart = denseFaceTurnStart(events, start, searchEnd);
  if (stateChange !== null) {
    const time = motionStart !== null && Math.abs(motionStart - stateChange) <= 1.5
      ? Math.min(motionStart, stateChange)
      : stateChange;
    return { time, source: 'state-change', confidence: motionStart !== null ? 92 : 84 };
  }
  if (motionStart !== null) return { time: motionStart, source: 'motion-density', confidence: 76 };

  const validHint = segmentationHint !== null
    && segmentationHint !== undefined
    && segmentationHint >= start + 2
    && segmentationHint <= searchEnd;
  if (validHint) return { time: segmentationHint, source: 'segmentation', confidence: 62 };

  return {
    time: Math.min(searchEnd, start + Math.max(4, (searchEnd - start) * 0.55)),
    source: 'fallback',
    confidence: 45,
  };
}

export function inspectionCropVariants(portrait: boolean) {
  return portrait
    ? [
      { x: 0.06, y: 0.06, width: 0.88, height: 0.72 },
      { x: 0.02, y: 0.02, width: 0.96, height: 0.88 },
      { x: 0, y: 0, width: 1, height: 1 },
    ]
    : [
      { x: 0.12, y: 0.06, width: 0.76, height: 0.88 },
      { x: 0.04, y: 0.04, width: 0.92, height: 0.92 },
      { x: 0, y: 0, width: 1, height: 1 },
    ];
}

// Le coordinate di una griglia (imageX/Y, rightX/Y, downX/Y) sono salvate nello
// spazio del canvas di analisi (320 o 480px, dopo il ritaglio). Per
// disegnarle sopra un fotogramma a piena risoluzione serve riportarle nello
// spazio dell'intero video, usando il ritaglio indicato in frameId.
export function mapGridGeometryToVideoSpace(
  observation: Pick<FaceGridObservation, 'frameId' | 'imageX' | 'imageY' | 'rightX' | 'rightY' | 'downX' | 'downY'>,
  video: { videoWidth: number; videoHeight: number },
) {
  const { imageX, imageY, rightX, rightY, downX, downY, frameId } = observation;
  if (
    imageX === undefined || imageY === undefined || rightX === undefined
    || rightY === undefined || downX === undefined || downY === undefined
  ) return null;
  const cropIndex = Number(frameId?.split(':crop-')[1] ?? 0) || 0;
  const portrait = video.videoHeight >= video.videoWidth;
  const crop = inspectionCropVariants(portrait)[cropIndex] ?? inspectionCropVariants(portrait)[0];
  const analysisWidth = portrait ? 320 : 480;
  const analysisHeight = Math.round(
    analysisWidth * (video.videoHeight * crop.height) / (video.videoWidth * crop.width),
  );
  const scaleX = (crop.width * video.videoWidth) / analysisWidth;
  const scaleY = (crop.height * video.videoHeight) / analysisHeight;
  const offsetX = crop.x * video.videoWidth;
  const offsetY = crop.y * video.videoHeight;
  return {
    x: offsetX + imageX * scaleX,
    y: offsetY + imageY * scaleY,
    rightX: rightX * scaleX,
    rightY: rightY * scaleY,
    downX: downX * scaleX,
    downY: downY * scaleY,
  };
}

function readHighResolutionInspectionFrame(video: HTMLVideoElement, time: number): MotionSample[] {
  const portrait = video.videoHeight >= video.videoWidth;
  const cropVariants = inspectionCropVariants(portrait);

  const captureId = time.toFixed(4);
  const readings = cropVariants.map((crop, cropIndex) => {
    const analysis = document.createElement('canvas');
    analysis.width = portrait ? 320 : 480;
    analysis.height = Math.round(
      analysis.width * (video.videoHeight * crop.height) / (video.videoWidth * crop.width),
    );
    const context = analysis.getContext('2d', { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(
      video,
      video.videoWidth * crop.x,
      video.videoHeight * crop.y,
      video.videoWidth * crop.width,
      video.videoHeight * crop.height,
      0,
      0,
      analysis.width,
      analysis.height,
    );
    const signature = frameSignature(context, analysis.width, analysis.height);
    const gridScore = signature.faceGrids.reduce((total, grid) => (
      total + grid.visibleCells * 8 + grid.confidence
    ), 0);
    return { signature, cropIndex, score: gridScore + signature.faceGrids.length * 80 };
  }).filter((reading): reading is NonNullable<typeof reading> => reading !== null)
    .sort((left, right) => right.score - left.score);

  // I tre ritagli non sono alternative: ognuno può rendere leggibile una faccia
  // diversa. Restano separati per non confrontare coordinate appartenenti a
  // crop differenti, ma verranno tutti fusi nello stesso stato del cubo.
  return readings.map(({ signature, cropIndex }) => {
    const frameId = `${captureId}:crop-${cropIndex}`;
    const grids = signature.faceGrids.map((grid) => ({
      ...grid,
      time,
      frameId,
      captureId,
      bundleSize: signature.faceGrids.length,
    }));
    return {
      time,
      difference: 0,
      cubeDifference: 0,
      hasTemporalReference: false,
      faceGrids: grids,
      visibleColors: signature.visibleColors,
      sharpness: signature.sharpness,
    };
  });
}

export async function scanInspectionFrames(
  video: HTMLVideoElement,
  start: number,
  end: number,
  options: { analysisPass?: number; onProgress?: (progress: number) => void } = {},
): Promise<MotionSample[]> {
  if (!video.videoWidth || !video.videoHeight || video.readyState < 2) {
    throw new Error('Attendi che il video sia pronto prima di acquisire i fotogrammi.');
  }
  const times = buildInspectionSampleTimes(start, end, options.analysisPass ?? 0);
  const originalTime = video.currentTime;
  const wasPaused = video.paused;
  const samples: MotionSample[] = [];
  video.pause();
  try {
    for (let index = 0; index < times.length; index += 1) {
      const time = times[index];
      await waitForSeek(video, time);
      const frameSamples = readHighResolutionInspectionFrame(video, time);
      frameSamples.forEach((sample) => {
        sample.hasTemporalReference = index > 0;
        samples.push(sample);
      });
      options.onProgress?.((index + 1) / times.length);
    }
  } finally {
    await waitForSeek(video, originalTime).catch(() => undefined);
    if (!wasPaused) await video.play().catch(() => undefined);
  }
  // I canvas e i fotogrammi non escono da questa funzione: rimangono solo le
  // griglie colore 3×3 necessarie alla ricostruzione dello stato.
  return samples;
}

export function summarizeCubeObservation(
  samples: MotionSample[],
  start: number,
  end: number,
): CubeObservationSummary {
  const selected = samples.filter((sample) => sample.time >= start && sample.time <= end && sample.visibleColors);
  const referencedSamples = selected.filter((sample) => sample.hasTemporalReference !== false);
  const differences = referencedSamples.map((sample) => sample.cubeDifference ?? sample.difference);
  const stableLimit = Math.max(2.4, percentile(differences, 0.42));
  const stable = referencedSamples.filter((sample) => (sample.cubeDifference ?? sample.difference) <= stableLimit);
  const gridFrames = selected.filter((sample) => (sample.faceGrids?.length ?? 0) >= 1);
  const measuredSharpness = gridFrames
    .map((sample) => sample.sharpness)
    .filter((value): value is number => Number.isFinite(value));
  const sharpnessFloor = percentile(measuredSharpness, 0.24);
  const sharpFrames = measuredSharpness.length >= 4
    ? gridFrames.filter((sample) => (sample.sharpness ?? sharpnessFloor) >= sharpnessFloor)
    : gridFrames;
  // Non scartiamo un'intera posa solo perché è nel quartile meno nitido: può
  // essere l'unico momento in cui compare una faccia. La nitidezza resta una
  // misura diagnostica, mentre consenso temporale e geometria pesano le celle.
  const useful = gridFrames.length ? gridFrames : selected;
  const originalObservations = useful.flatMap((sample) => sample.faceGrids ?? []);
  // Prima fase: raccogliamo e salviamo le medie robuste dei centri. Solo dopo
  // questa calibrazione iniziale riclassifichiamo le 48 caselle non centrali.
  const calibrationProfile = buildInitialColorCalibration(originalObservations.flatMap((observation) => {
    const center = observation.rawColors?.[4];
    return center ? [{
      color: observation.centerColor,
      sample: center,
      weight: observation.confidence / 100,
    }] : [];
  }));
  const calibration = calibrationProfile.calibration;
  const calibratedCenters = calibrationProfile.calibratedColors;
  const calibratedObservations = calibratedCenters >= 3
    ? originalObservations.map((observation) => {
      if (!observation.rawColors) return observation;
      const colors = observation.colors.map((color, index) => {
        if (index === 4) return observation.centerColor;
        const raw = observation.rawColors?.[index];
        if (!raw) return color;
        const classified = classifyCalibratedColor(raw, calibration);
        return classified.confidence >= 0.22 ? classified.color : color;
      });
      const cellConfidences = observation.cellConfidences?.map((confidence, index) => {
        const raw = observation.rawColors?.[index];
        if (!raw || index === 4) return confidence;
        const classified = classifyCalibratedColor(raw, calibration);
        return Math.round(Math.min(96, Math.max(28, confidence * 0.58 + classified.confidence * 42)));
      });
      return { ...observation, colors, cellConfidences };
    })
    : originalObservations;
  // Quando le sei facce sono leggibili, aggiungiamo una classificazione globale
  // a capacità fissa: 8 caselle libere più il centro = esattamente 9 per colore.
  const rawFacelets = Object.fromEntries(CUBE_FACES.map((face) => {
    const centerColor = CANONICAL_FACE_COLOR[face];
    const strongest = originalObservations
      .filter((observation) => (
        observation.centerColor === centerColor
        && observation.rawColors?.length === 9
        && observation.rawColors.every(Boolean)
      ))
      .sort((left, right) => (
        right.visibleCells * 12 + right.confidence
        - (left.visibleCells * 12 + left.confidence)
      ))[0];
    return [face, strongest?.rawColors ?? Array<RgbSample | null>(9).fill(null)];
  })) as Record<Face, Array<RgbSample | null>>;
  const balanced = calibrationProfile.ready
    ? classifyBalancedCubeFacelets(rawFacelets, calibration)
    : null;
  // Accettiamo il bilanciamento anche quando lo schema non e' completo: con
  // le righe fittizie nessun colore puo' superare le 9 occorrenze, quindi il
  // risultato resta fisicamente coerente, e le caselle non lette restano
  // semplicemente nulle. Richiediamo pero' che i centri siano corretti.
  const balancedUsable = !!balanced && (
    balanced.validation.valid
    || (balanced.observedCells >= 40 && balanced.validation.centersCanonical)
  );
  const balancedObservations = balancedUsable && balanced
    ? CUBE_FACES.map((face) => {
      const centerColor = CANONICAL_FACE_COLOR[face];
      const source = originalObservations
        .filter((observation) => observation.centerColor === centerColor)
        .sort((left, right) => right.confidence - left.confidence)[0];
      const confidenceValues = balanced.confidences[face];
      return {
        ...(source ?? {
          time: start,
          centerColor,
          visibleCells: 9,
          confidence: 72,
        }),
        centerColor,
        colors: balanced.facelets[face],
        cellConfidences: confidenceValues.map((value) => Math.round(value * 100)),
        visibleCells: balanced.facelets[face].filter(Boolean).length,
        confidence: Math.round(confidenceValues.reduce((total, value) => total + value, 0) / 9 * 100),
        sourceFrames: Math.max(2, source?.sourceFrames ?? 1),
        syntheticFusion: true,
      };
    })
    : [];
  const allObservations = [...calibratedObservations, ...balancedObservations];
  const multiFaceObservations = allObservations.filter((observation) => (observation.bundleSize ?? 1) >= 2);
  const reconstruction = reconstructInspectionState(allObservations, {
    observedCells: balanced?.observedCells ?? 0,
    usable: balancedUsable,
  });
  const keyframes = selectInspectionKeyframes(selected);
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
    sharpFrames: sharpFrames.length,
    multiFaceFrames: new Set(multiFaceObservations.map((observation) => observation.time.toFixed(3))).size,
    detectedColors,
    coverage,
    confidence,
    patternStatus: reconstruction.status === 'complete'
      ? 'usable'
      : reconstruction.status === 'partial' || (detectedColors.length >= 4 && useful.length >= 8)
        ? 'partial'
        : 'insufficient',
    keyframes,
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
  canvas.width = portrait ? 160 : 216;
  canvas.height = portrait ? 216 : 160;
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
      // La prima passata serve a trovare movimento e pause; le griglie 3×3
      // vengono cercate nella successiva scansione ad alta risoluzione.
      const current = frameSignature(context, canvas.width, canvas.height, false);
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
        sharpness: current.sharpness,
        hasTemporalReference: previous !== null,
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