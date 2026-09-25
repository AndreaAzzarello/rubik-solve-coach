// Sfondi procedurali (nessuna foto disponibile nel repo). Non punta al
// fotorealismo: punta a non lasciare mai lo sfondo costante, cosi' il modello
// non impara a usarlo come scorciatoia per trovare il cubo.

function randomHsl(): string {
  const hue = Math.floor(Math.random() * 360);
  const saturation = 15 + Math.random() * 60;
  const lightness = 20 + Math.random() * 65;
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

export type BackgroundSpec =
  | { kind: 'solid'; color: string }
  | { kind: 'gradient'; from: string; to: string; angleDeg: number }
  | { kind: 'vignette'; center: string; edge: string };

export function randomBackground(): BackgroundSpec {
  const roll = Math.random();
  if (roll < 0.34) return { kind: 'solid', color: randomHsl() };
  if (roll < 0.67) return { kind: 'gradient', from: randomHsl(), to: randomHsl(), angleDeg: Math.random() * 360 };
  return { kind: 'vignette', center: randomHsl(), edge: randomHsl() };
}
