'use client';

// Pagina-harness DIAGNOSTICA. Non fa parte del prodotto e non tocca la pipeline.
//
// Espone `window.__debugGrids(videoUrl)` che:
//   1. esegue la STESSA pipeline della pagina principale
//      (`reconstructInspectionFromVideo`) sul video dato;
//   2. legge `reconstruction.faceReference` — la griglia 3x3 che la pipeline ha
//      effettivamente SCELTO per ciascuna delle 6 facce, con il fotogramma
//      (`time`) e il crop (`frameId`) da cui proviene;
//   3. ritrova nell'elenco `samples` restituito dalla pipeline l'osservazione
//      grezza corrispondente a quella referenza, per sapere QUALE COLORE e'
//      stato letto in ognuna delle 9 celle di quel fotogramma;
//   4. riporta quel fotogramma a piena risoluzione e ci disegna sopra: il
//      contorno della griglia, i 9 punti di campionamento e, accanto a ciascuno,
//      il colore letto. Restituisce un PNG in data URL.
//
// Serve solo a vedere a occhio se e quanto la griglia e' disallineata e se i
// colori sono letti dai punti giusti. Il driver `bench/debug-grids.ts` salva i PNG.

import { useEffect, useRef, useState } from 'react';
import {
  CANONICAL_FACE_COLOR,
  COLOR_HEX,
  CUBE_FACES,
  type CubeColor,
  type Face,
} from '../../../lib/cube';
import { reconstructInspectionFromVideo } from '../../../lib/inspection-pipeline';
import { mapGridGeometryToVideoSpace } from '../../../lib/video-decoder';
import type { FaceGridObservation, InspectionReconstruction } from '../../../lib/inspection-state';

const COLOR_CODE: Record<CubeColor, string> = {
  white: 'W', red: 'R', green: 'G', yellow: 'Y', orange: 'O', blue: 'B',
};
const INK_ON: Record<CubeColor, string> = {
  white: '#0f172a', red: '#ffffff', green: '#0f172a', yellow: '#0f172a', orange: '#0f172a', blue: '#ffffff',
};

type FaceGridImage = {
  face: Face;
  centerColor: string;
  time: number;
  frameId: string | null;
  gridSource: string | null;
  hasGeometry: boolean;
  hasSilhouette: boolean;
  colorSource: string;
  readColors: Array<string | null>;
  dataUrl: string;
};

type DebugGridsResult = {
  ok: boolean;
  error?: string;
  status?: string;
  observedFaces?: Face[];
  interval?: { start: number; end: number };
  videoWidth?: number;
  videoHeight?: number;
  facesWithReference?: number;
  images?: FaceGridImage[];
  durationMs?: number;
};

declare global {
  interface Window {
    __debugGrids?: (videoUrl: string) => Promise<DebugGridsResult>;
    __debugGridsReady?: boolean;
  }
}

// Larghezza massima del PNG diagnostico: sotto questa il video viene rimpicciolito
// (mantiene comunque tutto il dettaglio utile a giudicare l'allineamento e tiene
// leggero il trasferimento verso il driver Node).
const MAX_OUTPUT_WIDTH = 1400;

function waitForVideoReady(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error('timeout nel caricamento del video (nessun canplay entro 60s)'));
    }, 60000);
    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener('canplay', onReady);
      video.removeEventListener('loadeddata', onReady);
      video.removeEventListener('error', onError);
    };
    const onReady = () => {
      if (video.readyState >= 2 && Number.isFinite(video.duration) && video.duration > 0) {
        cleanup();
        resolve();
      }
    };
    const onError = () => {
      cleanup();
      reject(new Error(`il browser non riesce a decodificare il video (${video.error?.message ?? 'errore sconosciuto'})`));
    };
    video.addEventListener('canplay', onReady);
    video.addEventListener('loadeddata', onReady);
    video.addEventListener('error', onError);
    onReady();
  });
}

function seekTo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve) => {
    const target = Math.min(video.duration - 0.01, Math.max(0, time));
    if (Math.abs(video.currentTime - target) < 0.005) {
      resolve();
      return;
    }
    const done = () => { video.removeEventListener('seeked', done); resolve(); };
    video.addEventListener('seeked', done);
    video.currentTime = target;
  });
}

type Reference = NonNullable<InspectionReconstruction['faceReference'][Face]>;

// Ritrova, fra tutte le osservazioni grezze prodotte dalla pipeline, quella che
// ha generato la referenza scelta per questa faccia: stesso frameId + stessa
// geometria (a meno di rumore). Serve a leggere i 9 colori esattamente come li
// ha visti l'algoritmo in quel fotogramma. Se la referenza e' una fusione
// sintetica non c'e' un frame unico corrispondente e si torna null.
function matchRawObservation(
  reference: Reference,
  observations: FaceGridObservation[],
): FaceGridObservation | null {
  let best: FaceGridObservation | null = null;
  let bestCost = Infinity;
  for (const observation of observations) {
    if (reference.frameId && observation.frameId !== reference.frameId) continue;
    if (reference.gridSource && observation.gridSource && observation.gridSource !== reference.gridSource) continue;
    if (observation.imageX === undefined || reference.imageX === undefined) continue;
    const centerCost = Math.hypot(
      (observation.imageX ?? 0) - (reference.imageX ?? 0),
      (observation.imageY ?? 0) - (reference.imageY ?? 0),
    );
    const basisCost = Math.hypot(
      (observation.rightX ?? 0) - (reference.rightX ?? 0),
      (observation.rightY ?? 0) - (reference.rightY ?? 0),
    ) + Math.hypot(
      (observation.downX ?? 0) - (reference.downX ?? 0),
      (observation.downY ?? 0) - (reference.downY ?? 0),
    );
    const cost = centerCost + basisCost;
    if (cost < bestCost) {
      bestCost = cost;
      best = observation;
    }
  }
  // Tolleranza generosa: la geometria della referenza e' quella dell'ipotesi
  // vincente, che puo' essere leggermente diversa dall'osservazione originale.
  return bestCost <= 6 ? best : null;
}

// Disegna la griglia scelta, i 9 punti di campionamento e il colore letto in
// ciascuno, sopra il fotogramma gia' presente nel canvas.
function drawOverlay(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  reference: Reference,
  readColors: Array<CubeColor | null>,
  video: HTMLVideoElement,
  scale: number,
) {
  const raw = mapGridGeometryToVideoSpace(reference, video);
  const geometry = raw
    ? {
      x: raw.x * scale,
      y: raw.y * scale,
      rightX: raw.rightX * scale,
      rightY: raw.rightY * scale,
      downX: raw.downX * scale,
      downY: raw.downY * scale,
    }
    : null;

  // --- silhouette esagonale, se la griglia viene da li' ---
  if (geometry && reference.silhouette?.length) {
    const mapped = reference.silhouette.map((vertex) => {
      const m = mapGridGeometryToVideoSpace({
        frameId: reference.frameId,
        imageX: vertex.x,
        imageY: vertex.y,
        rightX: 1, rightY: 0, downX: 0, downY: 1,
      }, video);
      return m ? { x: m.x * scale, y: m.y * scale } : null;
    });
    if (mapped.every(Boolean)) {
      context.beginPath();
      mapped.forEach((point, index) => {
        if (!point) return;
        if (index === 0) context.moveTo(point.x, point.y);
        else context.lineTo(point.x, point.y);
      });
      context.closePath();
      context.strokeStyle = 'rgba(0,0,0,0.8)';
      context.lineWidth = Math.max(5, canvas.width * 0.011);
      context.stroke();
      context.strokeStyle = '#fb923c';
      context.lineWidth = Math.max(2, canvas.width * 0.005);
      context.stroke();
    }
  }

  if (!geometry) {
    context.fillStyle = 'rgba(0,0,0,0.55)';
    context.fillRect(0, canvas.height * 0.44, canvas.width, canvas.height * 0.12);
    context.fillStyle = '#f8fafc';
    context.font = `${Math.round(canvas.width * 0.03)}px sans-serif`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText('Geometria della griglia non disponibile', canvas.width / 2, canvas.height * 0.5);
    return;
  }

  const cellCenter = (row: number, column: number) => ({
    x: geometry.x + geometry.rightX * column + geometry.downX * row,
    y: geometry.y + geometry.rightY * column + geometry.downY * row,
  });
  const cellCorners = (row: number, column: number) => {
    const c = cellCenter(row, column);
    return [-0.5, 0.5].flatMap((dy) => [-0.5, 0.5].map((dx): [number, number] => [
      c.x + geometry.rightX * dx + geometry.downX * dy,
      c.y + geometry.rightY * dx + geometry.downY * dy,
    ]));
  };
  const drawGridPath = () => {
    context.beginPath();
    for (let row = -1; row <= 1; row += 1) {
      for (let column = -1; column <= 1; column += 1) {
        const corners = cellCorners(row, column);
        [[0, 1], [1, 3], [3, 2], [2, 0]].forEach(([a, b]) => {
          context.moveTo(corners[a][0], corners[a][1]);
          context.lineTo(corners[b][0], corners[b][1]);
        });
      }
    }
  };
  context.lineJoin = 'round';
  context.strokeStyle = 'rgba(0,0,0,0.85)';
  context.lineWidth = Math.max(5, canvas.width * 0.012);
  drawGridPath();
  context.stroke();
  context.strokeStyle = '#22d3ee';
  context.lineWidth = Math.max(2, canvas.width * 0.006);
  drawGridPath();
  context.stroke();

  // Cella centrale evidenziata: e' il suo colore che diventa il "centro" della faccia.
  const centerCorners = cellCorners(0, 0);
  context.beginPath();
  context.moveTo(centerCorners[0][0], centerCorners[0][1]);
  [centerCorners[1], centerCorners[3], centerCorners[2]].forEach(([x, y]) => context.lineTo(x, y));
  context.closePath();
  context.strokeStyle = '#facc15';
  context.lineWidth = Math.max(2, canvas.width * 0.006);
  context.stroke();

  // --- i 9 PUNTI DI CAMPIONAMENTO + colore letto ---
  // La pipeline legge il colore di ogni cella da un intorno del centro cella:
  // raggio ~0.22 del passo per le griglie da coppie di sticker, ~0.3 per quelle
  // dalla silhouette (vedi detectFaceGrids / detectCubeFaceQuads).
  const rightLen = Math.hypot(geometry.rightX, geometry.rightY);
  const downLen = Math.hypot(geometry.downX, geometry.downY);
  const radiusFactor = reference.gridSource === 'silhouette' ? 0.3 : 0.22;
  const sampleRadius = Math.max(2, Math.min(rightLen, downLen) * radiusFactor);
  const dot = Math.max(3, canvas.width * 0.005);
  const swatch = Math.max(16, canvas.width * 0.03);
  const fontSize = Math.round(swatch * 0.7);

  let cellIndex = 0;
  for (let row = -1; row <= 1; row += 1) {
    for (let column = -1; column <= 1; column += 1, cellIndex += 1) {
      const c = cellCenter(row, column);
      // intorno effettivamente mediato per leggere il colore
      context.beginPath();
      context.arc(c.x, c.y, sampleRadius, 0, Math.PI * 2);
      context.strokeStyle = 'rgba(0,0,0,0.7)';
      context.lineWidth = Math.max(3, canvas.width * 0.005);
      context.stroke();
      context.strokeStyle = '#f472b6';
      context.lineWidth = Math.max(1.5, canvas.width * 0.0022);
      context.stroke();
      // punto di campionamento
      context.beginPath();
      context.arc(c.x, c.y, dot, 0, Math.PI * 2);
      context.fillStyle = '#f472b6';
      context.fill();
      context.lineWidth = Math.max(1.5, canvas.width * 0.002);
      context.strokeStyle = '#ffffff';
      context.stroke();

      // pastiglia col colore letto, appena sopra-a-destra del punto
      const read = readColors[cellIndex] ?? null;
      const sw = swatch * 1.15;
      const sx = c.x + dot + Math.max(3, canvas.width * 0.004);
      const sy = c.y - swatch / 2;
      context.fillStyle = read ? COLOR_HEX[read] : '#1e293b';
      context.fillRect(sx, sy, sw, swatch);
      context.lineWidth = Math.max(2, canvas.width * 0.0028);
      context.strokeStyle = 'rgba(0,0,0,0.9)';
      context.strokeRect(sx, sy, sw, swatch);
      context.fillStyle = read ? INK_ON[read] : '#94a3b8';
      context.font = `bold ${fontSize}px ui-monospace, monospace`;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(read ? COLOR_CODE[read] : '·', sx + swatch * 0.575, sy + swatch * 0.54);
    }
  }
}

function drawCaption(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  text: string,
) {
  const pad = Math.round(canvas.width * 0.01);
  const fontSize = Math.round(canvas.width * 0.02);
  context.font = `bold ${fontSize}px ui-monospace, monospace`;
  context.textAlign = 'left';
  context.textBaseline = 'top';
  const metrics = context.measureText(text);
  context.fillStyle = 'rgba(2,6,23,0.82)';
  context.fillRect(0, 0, metrics.width + pad * 2, fontSize + pad * 2);
  context.fillStyle = '#e2e8f0';
  context.fillText(text, pad, pad);
}

export default function DebugGridsHarness() {
  const stageRef = useRef<HTMLDivElement>(null);
  const [log, setLog] = useState<string[]>(['harness diagnostica pronta']);

  useEffect(() => {
    const append = (line: string) => setLog((current) => [...current, line]);

    window.__debugGrids = async (videoUrl: string): Promise<DebugGridsResult> => {
      const startedAt = performance.now();
      const video = document.createElement('video');
      video.crossOrigin = 'anonymous';
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
      video.controls = false;
      video.style.width = '320px';
      video.style.opacity = '0';
      video.style.pointerEvents = 'none';
      video.src = videoUrl;
      stageRef.current?.appendChild(video);
      append(`carico ${videoUrl}`);

      try {
        await waitForVideoReady(video);
        append(`video pronto: ${video.videoWidth}x${video.videoHeight}, ${video.duration.toFixed(2)}s`);

        const run = await reconstructInspectionFromVideo(video, {
          onPhase: (phase) => append(`fase: ${phase}`),
        });
        if (!run) return { ok: false, error: 'pipeline annullata' };

        const reconstruction = run.summary.reconstruction;
        const faceReference = reconstruction.faceReference ?? {};
        const allObservations = run.samples.flatMap((sample) => sample.faceGrids ?? []);
        append(`stato: ${reconstruction.status} · facce ${reconstruction.observedFaces.length}/6 · referenze ${Object.keys(faceReference).length} · osservazioni grezze ${allObservations.length}`);

        const scale = Math.min(1, MAX_OUTPUT_WIDTH / video.videoWidth);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        const context = canvas.getContext('2d');
        if (!context) return { ok: false, error: 'canvas 2D non disponibile' };

        const images: FaceGridImage[] = [];
        for (const face of CUBE_FACES) {
          const reference = faceReference[face];
          if (!reference) {
            append(`  ${face}: nessuna referenza (faccia non osservata)`);
            continue;
          }

          // Match per frameId + geometria: sufficientemente specifico da non
          // servire un filtro sul colore del centro (che potrebbe essere
          // proprio la lettura sbagliata da mostrare).
          const rawMatch = matchRawObservation(reference, allObservations);
          const readColors: Array<CubeColor | null> = rawMatch
            ? rawMatch.colors.slice(0, 9)
            : reconstruction.facelets[face].slice(0, 9);
          const colorSource = rawMatch ? 'osservazione' : 'facelet-fuso';

          await seekTo(video, reference.time);
          context.clearRect(0, 0, canvas.width, canvas.height);
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          drawOverlay(context, canvas, reference, readColors, video, scale);
          const centerColor = CANONICAL_FACE_COLOR[face];
          drawCaption(
            context,
            canvas,
            `${face} (${centerColor})  ·  ${reference.gridSource ?? 'n/d'}  ·  t=${reference.time.toFixed(3)}s  ·  colori: ${colorSource}  ·  ${reference.frameId ?? 'frameId?'}`,
          );
          images.push({
            face,
            centerColor,
            time: reference.time,
            frameId: reference.frameId ?? null,
            gridSource: reference.gridSource ?? null,
            hasGeometry: reference.imageX !== undefined,
            hasSilhouette: (reference.silhouette?.length ?? 0) > 0,
            colorSource,
            readColors: readColors.map((c) => c ?? null),
            dataUrl: canvas.toDataURL('image/png'),
          });
          append(`  ${face}: ok (${reference.gridSource ?? 'n/d'}, t=${reference.time.toFixed(3)}s, colori ${colorSource})`);
        }

        return {
          ok: true,
          status: reconstruction.status,
          observedFaces: reconstruction.observedFaces,
          interval: run.interval,
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
          facesWithReference: Object.keys(faceReference).length,
          images,
          durationMs: Math.round(performance.now() - startedAt),
        };
      } catch (caught) {
        const error = caught instanceof Error ? caught.message : String(caught);
        append(`errore: ${error}`);
        return { ok: false, error, durationMs: Math.round(performance.now() - startedAt) };
      } finally {
        video.removeAttribute('src');
        video.load();
        video.remove();
      }
    };

    window.__debugGridsReady = true;
    append('window.__debugGrids registrata');

    return () => {
      delete window.__debugGrids;
      window.__debugGridsReady = false;
    };
  }, []);

  return (
    <main style={{ fontFamily: 'ui-monospace, monospace', padding: 24, maxWidth: 900 }}>
      <h1 style={{ fontSize: 16, fontWeight: 800 }}>Debug griglie · allineamento 3×3</h1>
      <p style={{ fontSize: 12, color: '#64748b' }}>
        Pagina diagnostica. Il driver <code>bench/debug-grids.ts</code> chiama{' '}
        <code>window.__debugGrids(url)</code> e salva un PNG per faccia con la
        griglia scelta, i 9 punti di campionamento e il colore letto in ciascuno,
        sovrapposti al fotogramma reale.
      </p>
      <div ref={stageRef} aria-hidden />
      <pre
        style={{
          marginTop: 16,
          padding: 12,
          background: '#0f172a',
          color: '#e2e8f0',
          borderRadius: 8,
          fontSize: 11,
          lineHeight: 1.6,
          whiteSpace: 'pre-wrap',
        }}
      >
        {log.join('\n')}
      </pre>
    </main>
  );
}
