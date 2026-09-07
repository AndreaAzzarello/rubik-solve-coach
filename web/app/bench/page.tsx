'use client';

// Pagina-harness del banco di prova. Non fa parte del prodotto: espone
// `window.__benchReconstruct(videoUrl)` che esegue la STESSA pipeline della
// pagina principale (`reconstructInspectionFromVideo`) su un video dato e
// restituisce lo schema ricostruito in forma serializzabile.
//
// Il punteggio (confronto con lo scramble noto) NON avviene qui: lo calcola
// `bench/lib/score.ts` in Node, cosi' resta puro e testato a parte.

import { useEffect, useRef, useState } from 'react';
import type { CubeColor, Face } from '../../lib/cube';
import { reconstructInspectionFromVideo } from '../../lib/inspection-pipeline';

type BenchResult = {
  ok: boolean;
  status?: string;
  message?: string;
  confidence?: number;
  observedFaces?: Face[];
  facelets?: Record<Face, Array<CubeColor | null>>;
  completeFacelets?: Record<Face, CubeColor[]> | null;
  interval?: { start: number; end: number };
  runCount?: number;
  durationMs?: number;
  error?: string;
};

declare global {
  interface Window {
    __benchReconstruct?: (videoUrl: string) => Promise<BenchResult>;
    __benchReady?: boolean;
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

export default function BenchHarness() {
  const stageRef = useRef<HTMLDivElement>(null);
  const [log, setLog] = useState<string[]>(['harness pronta']);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const append = (line: string) => setLog((current) => [...current, line]);

    window.__benchReconstruct = async (videoUrl: string): Promise<BenchResult> => {
      setBusy(true);
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

        const result = await reconstructInspectionFromVideo(video, {
          onPhase: (phase) => append(`fase: ${phase}`),
        });
        if (!result) return { ok: false, error: 'pipeline annullata' };

        const reconstruction = result.summary.reconstruction;
        append(`stato: ${reconstruction.status} · facce ${reconstruction.observedFaces.length}/6`);
        return {
          ok: true,
          status: reconstruction.status,
          message: reconstruction.message,
          confidence: result.summary.confidence,
          observedFaces: reconstruction.observedFaces,
          facelets: reconstruction.facelets,
          completeFacelets: reconstruction.completeFacelets,
          interval: result.interval,
          runCount: result.runCount,
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
        setBusy(false);
      }
    };

    window.__benchReady = true;
    append('window.__benchReconstruct registrata');

    return () => {
      delete window.__benchReconstruct;
      window.__benchReady = false;
    };
  }, []);

  return (
    <main style={{ fontFamily: 'ui-monospace, monospace', padding: 24, maxWidth: 900 }}>
      <h1 style={{ fontSize: 16, fontWeight: 800 }}>Bench harness · ricostruzione stato cubo</h1>
      <p style={{ fontSize: 12, color: '#64748b' }}>
        Pagina interna di test. Il driver <code>bench/run-bench.mjs</code> chiama{' '}
        <code>window.__benchReconstruct(url)</code>. Stato: {busy ? 'in esecuzione…' : 'inattiva'}.
      </p>
      <div ref={stageRef} aria-hidden />
      <pre
        data-testid="bench-log"
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
