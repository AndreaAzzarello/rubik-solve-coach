// Percorso geometrico "a coppie di sticker": rileva le facce del cubo dai
// blob di colore classificati pixel-per-pixel, senza modello ONNX. Isolato
// dal resto di lib/video-decoder.ts (Fase D della revisione, punto 8): non e'
// piu' il percorso di produzione (il default e' il modello, vedi
// video-decoder.ts) ma resta la baseline di confronto del bench
// (BENCH_FACE_SOURCE=geometric) e lo strumento diagnostico
// app/bench/sticker-areas/page.tsx. Comportamento INVARIATO rispetto a prima
// dello spostamento - verificato bit-per-bit via bench.

import { type Point } from './homography.ts';
import { CUBE_COLORS, type CubeColor } from './cube.ts';
import { sampleCentralRoiRgb, type RgbSample } from './color-calibration.ts';
import { applyLocalCenterCalibration, sampleVirtualCell } from './cell-sampling.ts';
import type { FaceGridObservation } from './inspection-state.ts';

const OBSERVED_COLORS = CUBE_COLORS;

type StickerComponent = {
  color: CubeColor;
  area: number;
  x: number;
  y: number;
  width: number;
  height: number;
  rawColor?: RgbSample;
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

// Guscio convesso (monotone chain). Serve a ottenere la silhouette esterna del
// cubo a partire dagli sticker riconosciuti. Esportata: vision/annotate la
// riusa per ridurre una maschera SAM a un poligono pulito prima di
// semplificarla a 4 vertici con simplifyPolygon.
export function convexHull(points: Point[]): Point[] {
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
export function simplifyPolygon(polygon: Point[], target: number): Point[] {
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
      // Il passo nominale fra centroidi adiacenti e' ~1x il lato dello sticker
      // (piu' il sottile bordo nero); la prospettiva puo' allargarlo un po' sul
      // lato vicino. 2.15 lasciava passare griglie che scavalcano una casella
      // (es. faccia F ~1.8x troppo larga): 1.6 le esclude tenendo margine per
      // lo scorcio.
      if (
        stepRatioRight < 0.62 || stepRatioRight > 1.6
        || stepRatioDown < 0.62 || stepRatioDown > 1.6
      ) return;
      const tolerance = Math.max(2.2, Math.min(right.length, down.length) * 0.3);
      const used = new Set<StickerComponent>();
      const colors = Array<CubeColor | null>(9).fill(null);
      const rawColors = Array<RgbSample | null>(9).fill(null);
      const cellConfidences = Array<number>(9).fill(0);
      // Celle riempite da uno sticker reale (non dal fallback virtuale): servono
      // a distinguere un vero centro faccia da uno sticker di bordo usato come
      // ancora (che avrebbe un vicino ortogonale fuori faccia).
      const realCell = Array<boolean>(9).fill(false);
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
            realCell[cellIndex] = true;
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
      // Anti-traslazione di ~1 cella: un'ancora che e' davvero il centro faccia
      // ha stickers su tutti e quattro i lati (celle 1/3/5/7 = N/O/E/S). Se un
      // vicino ortogonale manca, o meno di due sono stickers reali, l'ancora e'
      // un bordo/spigolo e la griglia scivolerebbe fuori faccia.
      const orthoIndices = [1, 3, 5, 7];
      const orthoPresent = orthoIndices.filter((i) => colors[i] !== null).length;
      const orthoReal = orthoIndices.filter((i) => realCell[i]).length;
      if (orthoPresent < 4 || orthoReal < 2) return;
      applyLocalCenterCalibration(center.color, rawColors, colors, cellConfidences);
      const fit = Math.max(0, 1 - residual / visibleCells);
      const score = visibleCells / 9 * 0.7 + fit * 0.18 + orthoReal / 4 * 0.12;
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
    const quadColors = Array<CubeColor | null>(9).fill(null);
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
  const hypothesesPerCenter = new Map<CubeColor, number>();
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
