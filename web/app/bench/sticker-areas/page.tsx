'use client';

// Pagina-harness DIAGNOSTICA. Non fa parte del prodotto e non tocca la pipeline.
//
// Espone `window.__stickerAreas(videoUrl, times)` che, per ogni istante di
// `times` e per ognuno dei 3 ritagli usati davvero dalla pipeline
// (`inspectionCropVariants`), ricalcola ESATTAMENTE la stessa classificazione
// per-pixel usata da `frameSignature` (stessa soglia di confidenza 0.16,
// stessa ROI 12%-88%, stesso passo di campionamento adattivo) e passa le
// etichette risultanti a `stickerComponents` (gia' esportata, invariata).
//
// Serve SOLO a misurare la distribuzione di area/aspect-ratio delle componenti
// connesse — niente hand-motion, niente MediaPipe, niente CDN, niente
// ricostruzione: per questo e' molto piu' veloce e non dipende dalla rete.

import { useEffect, useRef, useState } from 'react';
import { CUBE_COLORS, type CubeColor } from '../../../lib/cube';
import { inspectionCropVariants, stickerComponents } from '../../../lib/video-decoder';
import { createAdaptiveColorClassifier, type RgbSample } from '../../../lib/color-calibration';

type ComponentSample = {
  time: number;
  crop: number;
  color: CubeColor;
  area: number;
  width: number;
  height: number;
  aspect: number;
};

type StickerAreasResult = {
  ok: boolean;
  error?: string;
  videoWidth?: number;
  videoHeight?: number;
  duration?: number;
  totalFrames?: number;
  components?: ComponentSample[];
  durationMs?: number;
};

declare global {
  interface Window {
    __stickerAreas?: (videoUrl: string, times: number[]) => Promise<StickerAreasResult>;
    __stickerAreasReady?: boolean;
  }
}

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

// Timeout per singolo seek: se il browser non riesce a raggiungere quel punto
// del video (indice corrotto, timestamp oltre la durata reale) la misura non
// deve restare bloccata in silenzio — meglio saltare il fotogramma.
function seekTo(video: HTMLVideoElement, time: number): Promise<boolean> {
  return new Promise((resolve) => {
    const target = Math.min(video.duration - 0.01, Math.max(0, time));
    if (Math.abs(video.currentTime - target) < 0.005) {
      resolve(true);
      return;
    }
    const timeout = window.setTimeout(() => {
      cleanup();
      resolve(false);
    }, 8000);
    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener('seeked', done);
    };
    const done = () => { cleanup(); resolve(true); };
    video.addEventListener('seeked', done);
    video.currentTime = target;
  });
}

// Riproduce esattamente il classificatore per-pixel di `frameSignature` in
// lib/video-decoder.ts (stessa ROI, stesso passo, stessa soglia 0.16) — non
// importabile perche' privata del modulo, quindi duplicata qui (solo bench).
function classifyFrame(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): Int8Array {
  const size = width * height;
  const pixelLabels = new Int8Array(size).fill(-1);
  const adaptiveSamples: RgbSample[] = [];
  const sampleStep = Math.max(2, Math.floor(Math.min(width, height) / 110));
  for (let y = Math.floor(height * 0.1); y <= Math.ceil(height * 0.9); y += sampleStep) {
    for (let x = Math.floor(width * 0.1); x <= Math.ceil(width * 0.9); x += sampleStep) {
      const offset = (y * width + x) * 4;
      adaptiveSamples.push({ red: data[offset], green: data[offset + 1], blue: data[offset + 2] });
    }
  }
  const classify = createAdaptiveColorClassifier(adaptiveSamples);
  for (let y = Math.floor(height * 0.12); y <= Math.ceil(height * 0.88); y += 1) {
    for (let x = Math.floor(width * 0.12); x <= Math.ceil(width * 0.88); x += 1) {
      const target = y * width + x;
      const offset = target * 4;
      const classification = classify({ red: data[offset], green: data[offset + 1], blue: data[offset + 2] });
      if (classification?.color && (classification.confidence ?? 0) >= 0.16) {
        pixelLabels[target] = CUBE_COLORS.indexOf(classification.color);
      }
    }
  }
  return pixelLabels;
}

export default function StickerAreasHarness() {
  const stageRef = useRef<HTMLDivElement>(null);
  const [log, setLog] = useState<string[]>(['harness diagnostica pronta']);

  useEffect(() => {
    const append = (line: string) => setLog((current) => [...current, line].slice(-400));

    window.__stickerAreas = async (videoUrl: string, times: number[]): Promise<StickerAreasResult> => {
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

        const portrait = video.videoHeight >= video.videoWidth;
        const crops = inspectionCropVariants(portrait);
        const analysisWidth = portrait ? 320 : 480;
        const components: ComponentSample[] = [];
        const totalFrames = times.length * crops.length;
        let frameCount = 0;

        for (const time of times) {
          const seeked = await seekTo(video, time);
          if (!seeked) {
            frameCount += crops.length;
            console.log(`[sticker-areas] t=${time.toFixed(2)} SEEK TIMEOUT, salto (${frameCount}/${totalFrames})`);
            continue;
          }
          for (let cropIndex = 0; cropIndex < crops.length; cropIndex += 1) {
            const crop = crops[cropIndex];
            const canvas = document.createElement('canvas');
            canvas.width = analysisWidth;
            canvas.height = Math.round(
              analysisWidth * (video.videoHeight * crop.height) / (video.videoWidth * crop.width),
            );
            const context = canvas.getContext('2d', { willReadFrequently: true });
            frameCount += 1;
            if (!context) {
              console.log(`[sticker-areas] t=${time.toFixed(2)} crop=${cropIndex} SENZA CONTEXT 2D (${frameCount}/${totalFrames})`);
              continue;
            }
            context.drawImage(
              video,
              video.videoWidth * crop.x,
              video.videoHeight * crop.y,
              video.videoWidth * crop.width,
              video.videoHeight * crop.height,
              0,
              0,
              canvas.width,
              canvas.height,
            );
            const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
            const labels = classifyFrame(data, canvas.width, canvas.height);
            const found = stickerComponents(labels, canvas.width, canvas.height);
            found.forEach((component) => {
              components.push({
                time,
                crop: cropIndex,
                color: component.color,
                area: component.area,
                width: component.width,
                height: component.height,
                aspect: component.width / Math.max(1, component.height),
              });
            });
            console.log(`[sticker-areas] t=${time.toFixed(2)} crop=${cropIndex} -> ${found.length} componenti (${frameCount}/${totalFrames})`);
          }
        }

        return {
          ok: true,
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
          duration: video.duration,
          totalFrames,
          components,
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

    window.__stickerAreasReady = true;
    append('window.__stickerAreas registrata');

    return () => {
      delete window.__stickerAreas;
      window.__stickerAreasReady = false;
    };
  }, []);

  return (
    <main style={{ fontFamily: 'ui-monospace, monospace', padding: 24, maxWidth: 900 }}>
      <h1 style={{ fontSize: 16, fontWeight: 800 }}>Aree componenti connesse (sticker merging)</h1>
      <p style={{ fontSize: 12, color: '#64748b' }}>
        Pagina diagnostica. Il driver <code>bench/sticker-areas.ts</code> chiama{' '}
        <code>window.__stickerAreas(url, times)</code> e riceve area/larghezza/altezza
        di ogni componente connessa trovata dal flood-fill, per ogni fotogramma campionato.
        Nessuna ricostruzione, nessun MediaPipe: solo classificazione colore + flood-fill.
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
