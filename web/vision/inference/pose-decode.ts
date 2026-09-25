// Decodifica pura dell'output grezzo di un export ONNX YOLOv8/11-pose (nessuna
// dipendenza da onnxruntime: prende gia' il Float32Array e le sue dimensioni).
//
// Formato dell'output (verificato sul modello reale, non assunto): tensore
// [1, 4 + nc + 3*K, N] dove nc=numero classi (1, "cube_face"), K=numero
// keypoint (4), N=numero anchor (5376 per input 512x512, dipende da imgsz).
// Il box (cx,cy,w,h) e i keypoint sono GIA' decodificati in pixel dello
// spazio di input del modello (Ultralytics include il decode nel grafo
// esportato) - qui restano solo soglia di confidenza + NMS, non anchor/DFL.

export type Box = { x: number; y: number; w: number; h: number }; // cx,cy,w,h
export type Keypoint = { x: number; y: number; conf: number };
export type Detection = { score: number; box: Box; keypoints: Keypoint[] };

export function decodePoseOutput(
  data: Float32Array | number[],
  numAnchors: number,
  numKeypoints: number,
  confThreshold: number,
): Detection[] {
  const detections: Detection[] = [];
  for (let anchor = 0; anchor < numAnchors; anchor += 1) {
    const at = (channel: number) => data[channel * numAnchors + anchor];
    const score = at(4);
    if (score < confThreshold) continue;
    const box: Box = { x: at(0), y: at(1), w: at(2), h: at(3) };
    const keypoints: Keypoint[] = [];
    for (let k = 0; k < numKeypoints; k += 1) {
      const base = 5 + k * 3;
      keypoints.push({ x: at(base), y: at(base + 1), conf: at(base + 2) });
    }
    detections.push({ score, box, keypoints });
  }
  return detections;
}

function boxCorners(box: Box) {
  return {
    x1: box.x - box.w / 2,
    y1: box.y - box.h / 2,
    x2: box.x + box.w / 2,
    y2: box.y + box.h / 2,
  };
}

export function boxIou(a: Box, b: Box): number {
  const ca = boxCorners(a);
  const cb = boxCorners(b);
  const ix1 = Math.max(ca.x1, cb.x1);
  const iy1 = Math.max(ca.y1, cb.y1);
  const ix2 = Math.min(ca.x2, cb.x2);
  const iy2 = Math.min(ca.y2, cb.y2);
  const interArea = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
  const union = a.w * a.h + b.w * b.h - interArea;
  return union > 0 ? interArea / union : 0;
}

/** Classe singola: NMS greedy standard, ordina per score e scarta i sovrapposti. */
export function nonMaxSuppression(detections: Detection[], iouThreshold: number): Detection[] {
  const sorted = [...detections].sort((a, b) => b.score - a.score);
  const kept: Detection[] = [];
  sorted.forEach((candidate) => {
    if (kept.every((k) => boxIou(k.box, candidate.box) < iouThreshold)) kept.push(candidate);
  });
  return kept;
}
