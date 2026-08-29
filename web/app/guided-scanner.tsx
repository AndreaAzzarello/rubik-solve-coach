'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { COLOR_HEX, COLOR_LABELS, type CubeColor, type Face } from '../lib/cube';
import {
  classifyCalibratedColor,
  classifyGuidedCaptures,
  medianRgb,
  rgbDifference,
  type GuidedFaceCapture,
  type RgbSample,
} from '../lib/color-calibration';
import { createHandMotionTracker } from '../lib/hand-motion';
import { faceletsToSolverString, type PartialFacelets } from '../lib/inspection-state';

const SCAN_ORDER: Array<{ face: Face; color: CubeColor; title: string; orientation: string }> = [
  { face: 'U', color: 'white', title: 'Faccia bianca', orientation: 'Centro bianco verso la camera · verde sul bordo in basso' },
  { face: 'R', color: 'red', title: 'Faccia rossa', orientation: 'Centro rosso verso la camera · bianco sul bordo in alto' },
  { face: 'F', color: 'green', title: 'Faccia verde', orientation: 'Centro verde verso la camera · bianco sul bordo in alto' },
  { face: 'D', color: 'yellow', title: 'Faccia gialla', orientation: 'Centro giallo verso la camera · verde sul bordo in alto' },
  { face: 'L', color: 'orange', title: 'Faccia arancione', orientation: 'Centro arancione verso la camera · bianco sul bordo in alto' },
  { face: 'B', color: 'blue', title: 'Faccia blu', orientation: 'Centro blu verso la camera · bianco sul bordo in alto' },
];

type FrameReading = {
  cells: RgbSample[];
  sharpness: number;
  capturedAt: number;
};

type GuidedUpdate = {
  facelets: PartialFacelets;
  capturedFaces: number;
  complete: boolean;
  solverString: string | null;
  message: string;
};

type GuidedScannerProps = {
  onUpdate: (update: GuidedUpdate) => void;
  onError: (message: string) => void;
};

function drawVideoCover(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  width: number,
  height: number,
) {
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  const sourceRatio = sourceWidth / Math.max(1, sourceHeight);
  const targetRatio = width / height;
  if (sourceRatio > targetRatio) {
    const cropWidth = sourceHeight * targetRatio;
    const left = (sourceWidth - cropWidth) / 2;
    context.drawImage(video, left, 0, cropWidth, sourceHeight, 0, 0, width, height);
  } else {
    const cropHeight = sourceWidth / targetRatio;
    const top = (sourceHeight - cropHeight) / 2;
    context.drawImage(video, 0, top, sourceWidth, cropHeight, 0, 0, width, height);
  }
}

function channelMedian(values: number[]) {
  values.sort((left, right) => left - right);
  return values[Math.floor(values.length / 2)] ?? 0;
}

function readGrid(video: HTMLVideoElement, canvas: HTMLCanvasElement): FrameReading | null {
  if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return null;
  const width = 360;
  const height = 480;
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  drawVideoCover(context, video, width, height);
  const image = context.getImageData(0, 0, width, height);
  const gridSize = width * 0.7;
  const left = (width - gridSize) / 2;
  const top = (height - gridSize) / 2;
  const cellSize = gridSize / 3;
  const cells: RgbSample[] = [];
  let edgeTotal = 0;
  let edgePixels = 0;

  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      const centerX = left + (column + 0.5) * cellSize;
      const centerY = top + (row + 0.5) * cellSize;
      const radius = cellSize * 0.19;
      const minimumX = Math.max(1, Math.floor(centerX - radius));
      const maximumX = Math.min(width - 2, Math.ceil(centerX + radius));
      const minimumY = Math.max(1, Math.floor(centerY - radius));
      const maximumY = Math.min(height - 2, Math.ceil(centerY + radius));
      const reds: number[] = [];
      const greens: number[] = [];
      const blues: number[] = [];
      for (let y = minimumY; y <= maximumY; y += 2) {
        for (let x = minimumX; x <= maximumX; x += 2) {
          const index = (y * width + x) * 4;
          const red = image.data[index];
          const green = image.data[index + 1];
          const blue = image.data[index + 2];
          const maximum = Math.max(red, green, blue);
          if (maximum < 22) continue;
          reds.push(red);
          greens.push(green);
          blues.push(blue);
          const right = index + 8;
          const bottom = index + width * 8;
          const luma = red * 0.299 + green * 0.587 + blue * 0.114;
          const rightLuma = image.data[right] * 0.299 + image.data[right + 1] * 0.587 + image.data[right + 2] * 0.114;
          const bottomLuma = image.data[bottom] * 0.299 + image.data[bottom + 1] * 0.587 + image.data[bottom + 2] * 0.114;
          edgeTotal += Math.abs(luma - rightLuma) + Math.abs(luma - bottomLuma);
          edgePixels += 2;
        }
      }
      if (reds.length < 12) return null;
      cells.push({ red: channelMedian(reds), green: channelMedian(greens), blue: channelMedian(blues) });
    }
  }
  return { cells, sharpness: edgeTotal / Math.max(1, edgePixels), capturedAt: performance.now() };
}

function aggregateReadings(readings: FrameReading[]): RgbSample[] {
  return Array.from({ length: 9 }, (_, index) => medianRgb(readings.map((reading) => reading.cells[index])));
}

function emptyFacelets(): PartialFacelets {
  const facelets: PartialFacelets = {
    U: Array<CubeColor | null>(9).fill(null),
    R: Array<CubeColor | null>(9).fill(null),
    F: Array<CubeColor | null>(9).fill(null),
    D: Array<CubeColor | null>(9).fill(null),
    L: Array<CubeColor | null>(9).fill(null),
    B: Array<CubeColor | null>(9).fill(null),
  };
  SCAN_ORDER.forEach(({ face, color }) => { facelets[face][4] = color; });
  return facelets;
}

export default function GuidedScanner({ onUpdate, onError }: GuidedScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const analysisCanvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const handTrackerRef = useRef<Awaited<ReturnType<typeof createHandMotionTracker>> | null>(null);
  const recentReadingsRef = useRef<FrameReading[]>([]);
  const capturesRef = useRef<GuidedFaceCapture[]>([]);
  const captureLockRef = useRef(false);
  const lastGestureSampleRef = useRef(0);
  const gestureArmedRef = useRef(0);
  const [cameraStatus, setCameraStatus] = useState<'idle' | 'starting' | 'running' | 'failed'>('idle');
  const [activeIndex, setActiveIndex] = useState(0);
  const [captures, setCaptures] = useState<GuidedFaceCapture[]>([]);
  const [latestReading, setLatestReading] = useState<FrameReading | null>(null);
  const [stableProgress, setStableProgress] = useState(0);
  const [gestureRequested, setGestureRequested] = useState(false);
  const [autoCapture, setAutoCapture] = useState(true);
  const [lastCaptureReason, setLastCaptureReason] = useState('');

  const activeStep = SCAN_ORDER[activeIndex] ?? null;
  const calibrationResult = useMemo(() => classifyGuidedCaptures(captures), [captures]);
  const centerReading = latestReading?.cells[4] ?? null;
  const centerClassification = centerReading
    ? classifyCalibratedColor(centerReading, calibrationResult.calibration)
    : null;
  const centerMatches = Boolean(activeStep && centerClassification?.color === activeStep.color);
  const quality = Math.min(1, (latestReading?.sharpness ?? 0) / 18);
  const ready = Boolean(activeStep && latestReading && centerMatches && stableProgress >= 0.95 && quality >= 0.28);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    handTrackerRef.current?.close();
    handTrackerRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraStatus('idle');
  }, []);

  useEffect(() => () => stopCamera(), [stopCamera]);

  const publishCaptures = useCallback((nextCaptures: GuidedFaceCapture[]) => {
    const result = classifyGuidedCaptures(nextCaptures);
    const facelets = result.facelets as PartialFacelets;
    const complete = SCAN_ORDER.every(({ face }) => facelets[face].every(Boolean));
    const solverString = complete
      ? faceletsToSolverString(facelets as Record<Face, CubeColor[]>)
      : null;
    onUpdate({
      facelets,
      capturedFaces: nextCaptures.length,
      complete,
      solverString,
      message: complete
        ? 'Sei facce acquisite e riclassificate usando tutti i centri. Verifico ora lo stato fisico del cubo.'
        : `${nextCaptures.length}/6 facce acquisite. Ogni nuovo centro aggiorna la calibrazione delle facce precedenti.`,
    });
  }, [onUpdate]);

  const startCamera = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      onError('Questo browser non consente l’accesso alla fotocamera. Usa il caricamento video.');
      setCameraStatus('failed');
      return;
    }
    setCameraStatus('starting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30, max: 60 },
        },
      });
      streamRef.current = stream;
      if (!videoRef.current) throw new Error('Anteprima fotocamera non disponibile.');
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      setCameraStatus('running');
      void createHandMotionTracker().then((tracker) => {
        if (!streamRef.current) tracker.close();
        else handTrackerRef.current = tracker;
      }).catch(() => undefined);
    } catch (caught) {
      setCameraStatus('failed');
      onError(caught instanceof Error ? caught.message : 'Non riesco ad avviare la fotocamera posteriore.');
    }
  }, [onError]);

  const captureCurrentFace = useCallback((reason: 'automatico' | 'gesto' | 'manuale') => {
    const step = SCAN_ORDER[activeIndex];
    if (!step || captureLockRef.current) return;
    const readings = recentReadingsRef.current.slice(-7);
    if (readings.length < 3) {
      onError('Tieni la faccia ferma ancora un istante prima di catturarla.');
      return;
    }
    captureLockRef.current = true;
    const capture: GuidedFaceCapture = {
      face: step.face,
      centerColor: step.color,
      cells: aggregateReadings(readings),
      quality: Math.max(0.35, Math.min(1, readings.reduce((total, reading) => total + reading.sharpness, 0) / readings.length / 18)),
      capturedAt: Date.now(),
    };
    const nextCaptures = [...capturesRef.current.filter((item) => item.face !== step.face), capture];
    capturesRef.current = nextCaptures;
    setCaptures(nextCaptures);
    publishCaptures(nextCaptures);
    setLastCaptureReason(reason);
    recentReadingsRef.current = [];
    setLatestReading(null);
    setStableProgress(0);
    setGestureRequested(false);
    const nextIndex = activeIndex + 1;
    setActiveIndex(nextIndex);
    window.setTimeout(() => { captureLockRef.current = false; }, 900);
    if (nextIndex >= SCAN_ORDER.length) stopCamera();
  }, [activeIndex, onError, publishCaptures, stopCamera]);

  useEffect(() => {
    if (cameraStatus !== 'running') return;
    const interval = window.setInterval(() => {
      const video = videoRef.current;
      const canvas = analysisCanvasRef.current;
      if (!video || !canvas) return;
      const reading = readGrid(video, canvas);
      if (!reading) return;
      const recent = [...recentReadingsRef.current, reading].slice(-9);
      recentReadingsRef.current = recent;
      setLatestReading(reading);
      if (recent.length < 3) {
        setStableProgress(recent.length / 7);
      } else {
        const differences = recent.slice(1).map((current, index) => (
          current.cells.reduce((total, cell, cellIndex) => total + rgbDifference(cell, recent[index].cells[cellIndex]), 0) / 9
        ));
        const stableFrames = differences.filter((difference) => difference <= 11.5).length;
        setStableProgress(Math.min(1, stableFrames / 6));
      }

      const now = performance.now();
      if (handTrackerRef.current && now - lastGestureSampleRef.current >= 260) {
        lastGestureSampleRef.current = now;
        try {
          const hand = handTrackerRef.current.sample(video, now);
          if (hand.wristMotion >= 1.25 || hand.handMotion >= 1.65) gestureArmedRef.current = now;
          if (gestureArmedRef.current && now - gestureArmedRef.current >= 650 && hand.handMotion <= 0.18) {
            gestureArmedRef.current = 0;
            setGestureRequested(true);
          }
        } catch {
          // La scansione dei colori continua anche se il modello mani non è disponibile.
        }
      }
    }, 145);
    return () => window.clearInterval(interval);
  }, [cameraStatus]);

  useEffect(() => {
    if (!ready || !activeStep) return;
    if (gestureRequested) {
      const timeout = window.setTimeout(() => captureCurrentFace('gesto'), 180);
      return () => window.clearTimeout(timeout);
    }
    if (autoCapture) {
      const timeout = window.setTimeout(() => captureCurrentFace('automatico'), 720);
      return () => window.clearTimeout(timeout);
    }
  }, [activeStep, autoCapture, captureCurrentFace, gestureRequested, ready]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || cameraStatus !== 'running' || !activeStep) return;
      event.preventDefault();
      captureCurrentFace('manuale');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeStep, cameraStatus, captureCurrentFace]);

  function resetScanner() {
    stopCamera();
    capturesRef.current = [];
    recentReadingsRef.current = [];
    setCaptures([]);
    setActiveIndex(0);
    setLatestReading(null);
    setStableProgress(0);
    setGestureRequested(false);
    setLastCaptureReason('');
    onUpdate({ facelets: emptyFacelets(), capturedFaces: 0, complete: false, solverString: null, message: 'Scansione guidata azzerata.' });
  }

  return (
    <div className="mt-4">
      <div className="flex flex-wrap gap-1.5" aria-label="Avanzamento delle facce">
        {SCAN_ORDER.map((step, index) => {
          const completed = captures.some((capture) => capture.face === step.face);
          const active = index === activeIndex;
          return (
            <span key={step.face} className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-[10px] font-black ${completed ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : active ? 'border-blue-300 bg-blue-50 text-blue-700' : 'border-slate-200 bg-slate-50 text-slate-400'}`}>
              <span className="h-2.5 w-2.5 rounded-[3px] border border-black/10" style={{ backgroundColor: COLOR_HEX[step.color] }} />
              {step.face}{completed ? ' ✓' : ''}
            </span>
          );
        })}
      </div>

      {activeStep ? (
        <div className="mt-4 rounded-2xl border border-blue-200 bg-blue-50 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.14em] text-blue-600">Faccia {activeIndex + 1} di 6</p>
              <h3 className="mt-1 text-base font-black text-blue-950">{activeStep.title}</h3>
              <p className="mt-1 text-xs leading-5 text-blue-800">{activeStep.orientation}</p>
            </div>
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border-2 border-slate-950 text-xs font-black" style={{ backgroundColor: COLOR_HEX[activeStep.color], color: activeStep.color === 'white' || activeStep.color === 'yellow' ? '#0f172a' : 'white' }}>{activeStep.face}</span>
          </div>
        </div>
      ) : (
        <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-bold text-emerald-800">Scansione completata: sei centri calibrati e 54 caselle riclassificate.</div>
      )}

      <div className="relative mt-4 aspect-[3/4] max-h-[560px] w-full overflow-hidden rounded-3xl bg-slate-950 shadow-inner">
        <video ref={videoRef} playsInline muted className="h-full w-full object-cover" aria-label="Anteprima della fotocamera posteriore" />
        <canvas ref={analysisCanvasRef} className="hidden" />
        {cameraStatus === 'running' && activeStep ? (
          <>
            <div className={`pointer-events-none absolute left-1/2 top-1/2 aspect-square w-[70%] -translate-x-1/2 -translate-y-1/2 rounded-2xl border-2 transition ${ready ? 'border-emerald-400 shadow-[0_0_0_999px_rgba(2,6,23,0.28),0_0_30px_rgba(52,211,153,0.5)]' : 'border-white/80 shadow-[0_0_0_999px_rgba(2,6,23,0.42)]'}`}>
              <div className="grid h-full grid-cols-3 grid-rows-3">
                {Array.from({ length: 9 }, (_, index) => <span key={index} className={`border-white/30 ${index === 4 ? 'border-2 border-blue-300/90' : 'border'}`} />)}
              </div>
            </div>
            <div className="absolute inset-x-3 bottom-3 rounded-2xl border border-white/10 bg-slate-950/85 p-3 text-white backdrop-blur">
              <div className="flex items-center justify-between gap-3 text-[10px] font-black uppercase tracking-wide"><span>{centerClassification ? `Centro: ${COLOR_LABELS[centerClassification.color]}` : 'Cerco il centro'}</span><span>{Math.round(stableProgress * 100)}% stabile</span></div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/15"><div className={`h-full rounded-full transition-[width] ${ready ? 'bg-emerald-400' : 'bg-blue-400'}`} style={{ width: `${stableProgress * 100}%` }} /></div>
            </div>
          </>
        ) : null}
        {cameraStatus !== 'running' ? (
          <div className="absolute inset-0 grid place-items-center px-7 text-center text-white">
            <div><div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-white/10 text-2xl">◎</div><p className="mt-4 text-sm font-black">Fotocamera posteriore</p><p className="mt-1 text-xs leading-5 text-slate-400">I fotogrammi restano sul dispositivo e non vengono salvati.</p></div>
          </div>
        ) : null}
      </div>

      {cameraStatus !== 'running' && activeStep ? (
        <button type="button" onClick={() => { void startCamera(); }} disabled={cameraStatus === 'starting'} className="mt-4 w-full rounded-2xl bg-blue-600 px-5 py-4 text-sm font-black text-white shadow-lg shadow-blue-600/20 disabled:cursor-wait disabled:opacity-60">
          {cameraStatus === 'starting' ? 'Apro la fotocamera…' : captures.length ? 'Continua la scansione' : 'Avvia fotocamera guidata'}
        </button>
      ) : null}
      {cameraStatus === 'running' && activeStep ? (
        <>
          <button type="button" onClick={() => captureCurrentFace('manuale')} disabled={!latestReading || !centerMatches} className="mt-4 w-full rounded-2xl bg-blue-600 px-5 py-4 text-sm font-black text-white shadow-lg shadow-blue-600/20 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:shadow-none">
            {ready ? `Cattura ${activeStep.title.toLowerCase()}` : centerMatches ? 'Tieni il cubo fermo' : `Mostra il centro ${COLOR_LABELS[activeStep.color]}`}
          </button>
          <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs leading-5 text-slate-600">
            <input type="checkbox" checked={autoCapture} onChange={(event) => setAutoCapture(event.target.checked)} className="mt-1" />
            <span><strong className="text-slate-900">Cattura automatica</strong><br />Scatta quando centro, nitidezza e stabilità sono corretti. Funzionano anche barra spaziatrice e gesto rapido seguito da un secondo di immobilità.</span>
          </label>
        </>
      ) : null}

      <div className="mt-3 flex items-center justify-between gap-3 text-[10px] font-bold text-slate-500">
        <span>{captures.length}/6 profili centro calibrati{lastCaptureReason ? ` · ultimo scatto ${lastCaptureReason}` : ''}</span>
        {captures.length ? <button type="button" onClick={resetScanner} className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-slate-600 hover:bg-slate-50">Ricomincia</button> : null}
      </div>
    </div>
  );
}
