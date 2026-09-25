// Occlusore mano, molto approssimato: 1-2 ellissi opache tono-pelle vicino al
// bordo basso/laterale del riquadro del cubo, come le dita che lo reggono nei
// video reali (causa nota di rumore nella segmentazione colore classica, vedi
// il commento in lib/video-decoder.ts su "mani, pelle e sfondo"). Non e'
// realistico ne' vuole esserlo: serve a insegnare al modello che una parte
// del bordo puo' mancare, non a duplicare un rendering di mani.

export type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

export type OccluderEllipse = {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  rotation: number; // radianti
  color: string;
};

function randomSkinTone(): string {
  const hue = 15 + Math.random() * 25;
  const saturation = 35 + Math.random() * 30;
  const lightness = 35 + Math.random() * 35;
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

/** Con probabilita' ~70% genera 1-2 ellissi vicino a un bordo casuale del riquadro. */
export function randomOccluders(bounds: Bounds): OccluderEllipse[] {
  if (Math.random() > 0.7) return [];
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const count = Math.random() < 0.6 ? 1 : 2;
  const edges: Array<'bottom' | 'left' | 'right'> = ['bottom', 'left', 'right'];

  return Array.from({ length: count }, () => {
    const edge = edges[Math.floor(Math.random() * edges.length)];
    const rx = width * (0.14 + Math.random() * 0.12);
    const ry = height * (0.14 + Math.random() * 0.12);
    const along = Math.random();
    let cx: number;
    let cy: number;
    if (edge === 'bottom') {
      cx = bounds.minX + width * along;
      cy = bounds.maxY - height * (0.02 + Math.random() * 0.08);
    } else if (edge === 'left') {
      cx = bounds.minX + width * (0.02 + Math.random() * 0.08);
      cy = bounds.minY + height * along;
    } else {
      cx = bounds.maxX - width * (0.02 + Math.random() * 0.08);
      cy = bounds.minY + height * along;
    }
    return { cx, cy, rx, ry, rotation: Math.random() * Math.PI, color: randomSkinTone() };
  });
}

export function pointInOccluder(shape: OccluderEllipse, x: number, y: number): boolean {
  const cos = Math.cos(-shape.rotation);
  const sin = Math.sin(-shape.rotation);
  const dx = x - shape.cx;
  const dy = y - shape.cy;
  const localX = dx * cos - dy * sin;
  const localY = dx * sin + dy * cos;
  return (localX * localX) / (shape.rx * shape.rx) + (localY * localY) / (shape.ry * shape.ry) <= 1;
}
