// Parser puro delle label Ultralytics pose (formato scritto da
// vision/dataset/annotation.ts): una riga per istanza, classe + bbox + 4
// keypoint (x,y,visibilita'), tutto normalizzato [0,1].

export type LabeledFace = {
  box: { x: number; y: number; w: number; h: number }; // pixel, centro
  keypoints: Array<{ x: number; y: number; visibility: 0 | 1 | 2 }>;
};

export function parseYoloPoseLabels(text: string, width: number, height: number): LabeledFace[] {
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const parts = line.trim().split(/\s+/).map(Number);
      const [, cx, cy, w, h] = parts;
      const keypoints: LabeledFace['keypoints'] = [];
      for (let i = 0; i < 4; i += 1) {
        const base = 5 + i * 3;
        keypoints.push({
          x: parts[base] * width,
          y: parts[base + 1] * height,
          visibility: parts[base + 2] as 0 | 1 | 2,
        });
      }
      return {
        box: { x: cx * width, y: cy * height, w: w * width, h: h * height },
        keypoints,
      };
    });
}
