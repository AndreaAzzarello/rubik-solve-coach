// Campionamento di una singola casella 3x3 a partire da una mappa colore
// per-pixel gia' classificata, e ricalibrazione locale sul centro - condivisi
// dal percorso geometrico a coppie di sticker (lib/geometric-sticker-detection.ts)
// e dal percorso modello (lib/face-keypoint-model.ts): stesso identico
// criterio di lettura colore per entrambi, estratto qui per evitare un ciclo
// di import fra i due moduli che lo usano.

import { FALLBACK_REFERENCE, classifyCalibratedColor, type RgbSample } from './color-calibration.ts';
import type { CubeColor } from './cube.ts';

// Quando due sticker adiacenti dello stesso colore si toccano (frequente nei
// primi piani, dove il sottile bordo nero tra le caselle non si distingue
// bene), il flood-fill li fonde in un unico blob troppo grande, che viene
// scartato dai controlli di forma. Il colore vero, però, è ancora presente
// nei pixel nel punto esatto dove la geometria prevede quella casella: lo
// leggiamo direttamente lì invece di rinunciare alla casella.
export function sampleVirtualCell(
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
  const roiArea = (maxX - minX + 1) * (maxY - minY + 1);
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
  // Un punto che cade davvero al centro di una casella ha l'intorno quasi
  // interamente classificato come colore del cubo. Se meno di meta' dei pixel
  // dell'intorno hanno un colore-cubo (bordo nero, ombra, pelle, sfondo), il
  // punto e' fuori faccia: meglio nessuna lettura che un "rosso/arancio" caldo.
  if (total / roiArea < 0.5) return null;
  let bestLabel = -1;
  let bestCount = 0;
  counts.forEach((count, label) => {
    if (count > bestCount) { bestCount = count; bestLabel = label; }
  });
  const share = bestCount / total;
  // Soglia di accordo alzata da 0.72 a 0.80: una casella vera e' un colore
  // pieno, una regione ambigua a cavallo di due caselle no.
  if (bestLabel < 0 || share < 0.8) return null;
  return { label: bestLabel, confidence: share };
}

// Il colore del centro è sempre noto in anticipo (i centri non si spostano
// mai l'uno rispetto all'altro). Confrontando il suo campione RGB REALE in
// questo fotogramma con il valore di riferimento, stimiamo un guadagno per
// canale che corregge riflessi o luce forte specifici di questa ripresa,
// prima di riclassificare le altre 8 caselle con la stessa correzione.
export function applyLocalCenterCalibration(
  centerColor: CubeColor,
  rawColors: Array<RgbSample | null>,
  colors: Array<CubeColor | null>,
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
