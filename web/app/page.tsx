'use client';

import { ChangeEvent, useCallback, useEffect, useRef, useState } from 'react';
import {
  CANONICAL_FACE_COLOR,
  COLOR_HEX,
  COLOR_LABELS,
  CUBE_FACES,
  type CubeColor,
  type Face,
} from '../lib/cube';
import {
  lastInspectionFrameTime,
  decodeVideoMotion,
  inferInspectionEnd,
  inferVideoSegmentation,
  scanInspectionFrames,
  summarizeCubeObservation,
  type CubeObservationSummary,
  type MotionSample,
} from '../lib/video-decoder';
import { createScrambleFromInspection, type InspectionScramble } from '../lib/inspection-solver';
import type { PartialFacelets } from '../lib/inspection-state';

const FACES = CUBE_FACES;
const FACE_NAMES: Record<Face, string> = {
  U: 'Sopra', R: 'Destra', F: 'Fronte', D: 'Sotto', L: 'Sinistra', B: 'Retro',
};
const NET_POSITION: Record<Face, string> = {
  U: 'col-start-2 row-start-1',
  L: 'col-start-1 row-start-2',
  F: 'col-start-2 row-start-2',
  R: 'col-start-3 row-start-2',
  B: 'col-start-4 row-start-2',
  D: 'col-start-2 row-start-3',
};

type ScanStatus = 'idle' | 'running' | 'result' | 'failed';
type SolverStatus = 'idle' | 'solving' | 'ready' | 'failed';

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds)) return '0:00';
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${Math.round(seconds % 60).toString().padStart(2, '0')}`;
}

function formatPreciseTime(seconds: number) {
  if (!Number.isFinite(seconds)) return '0:00.0';
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds % 60).toFixed(1).padStart(4, '0')}`;
}

function formatFileSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes > 100 * 1024 * 1024 ? 0 : 1)} MB`;
}

function createBlankFacelets(): PartialFacelets {
  return Object.fromEntries(FACES.map((face) => {
    const colors = Array<CubeColor | null>(9).fill(null);
    colors[4] = CANONICAL_FACE_COLOR[face];
    return [face, colors];
  })) as PartialFacelets;
}

function copyFacelets(facelets: PartialFacelets): PartialFacelets {
  return Object.fromEntries(FACES.map((face) => [face, [...facelets[face]]])) as PartialFacelets;
}

function CubeNetEditor({
  facelets,
}: {
  facelets: PartialFacelets;
}) {
  return (
    <div className="overflow-x-auto pb-2">
      <div className="grid min-w-[430px] grid-cols-4 grid-rows-3 gap-2">
        {FACES.map((face) => (
            <article key={face} className={`${NET_POSITION[face]} min-w-0 rounded-xl border border-slate-200 bg-white p-2 shadow-sm`}>
              <div className="mb-1.5 flex items-center justify-between gap-1">
                <p className="text-[9px] font-black uppercase tracking-[0.1em] text-slate-500">{face} · {FACE_NAMES[face]}</p>
                <span className="text-[8px] font-bold text-slate-400">{facelets[face].filter(Boolean).length}/9</span>
              </div>
              <div className="grid aspect-square grid-cols-3 gap-1 rounded-lg bg-slate-950 p-1.5">
                {facelets[face].map((color, index) => (
                  <span
                    key={`${face}-${index}`}
                    className={`rounded-[4px] border border-black/15 ${index === 4 ? 'ring-1 ring-white/70' : ''}`}
                    style={color
                      ? { backgroundColor: COLOR_HEX[color] }
                      : { background: 'repeating-linear-gradient(135deg,#334155 0,#334155 5px,#1e293b 5px,#1e293b 10px)' }}
                    title={`${face} casella ${index + 1}: ${color ? COLOR_LABELS[color] : 'non determinata'}`}
                  />
                ))}
              </div>
            </article>
        ))}
      </div>
    </div>
  );
}

export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const analysisGeneration = useRef(0);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState('');
  const [videoMeta, setVideoMeta] = useState({ duration: 0, width: 0, height: 0 });
  const [scanStatus, setScanStatus] = useState<ScanStatus>('idle');
  const [analysisPhase, setAnalysisPhase] = useState<'idle' | 'motion' | 'boundary' | 'frames' | 'fusing'>('idle');
  const [solverStatus, setSolverStatus] = useState<SolverStatus>('idle');
  const [progress, setProgress] = useState(0);
  const [runCount, setRunCount] = useState(0);
  const [samples, setSamples] = useState<MotionSample[]>([]);
  const [summary, setSummary] = useState<CubeObservationSummary | null>(null);
  const [cubeDraft, setCubeDraft] = useState<PartialFacelets>(() => createBlankFacelets());
  const [scramble, setScramble] = useState<InspectionScramble | null>(null);
  const [activeInterval, setActiveInterval] = useState<{ start: number; end: number } | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => () => {
    if (videoUrl) URL.revokeObjectURL(videoUrl);
  }, [videoUrl]);

  function chooseVideo(file: File | null) {
    if (!file) return;
    const isVideo = file.type.startsWith('video/') || /\.(mov|mp4|m4v|webm)$/i.test(file.name);
    if (!isVideo) {
      setError('Scegli un file video MOV, MP4, M4V o WebM.');
      return;
    }
    analysisGeneration.current += 1;
    setVideoFile(file);
    setVideoUrl(URL.createObjectURL(file));
    setVideoMeta({ duration: 0, width: 0, height: 0 });
    setScanStatus('idle');
    setAnalysisPhase('idle');
    setSolverStatus('idle');
    setProgress(0);
    setRunCount(0);
    setSamples([]);
    setSummary(null);
    setCubeDraft(createBlankFacelets());
    setScramble(null);
    setActiveInterval(null);
    setCopied(false);
    setError('');
  }

  function onVideoInput(event: ChangeEvent<HTMLInputElement>) {
    chooseVideo(event.target.files?.[0] ?? null);
  }

  const calculateScrambleFromFacelets = useCallback(async (facelets: Record<Face, CubeColor[]> | null, generation: number) => {
    if (!facelets) {
      setSolverStatus('idle');
      setScramble(null);
      return;
    }
    setSolverStatus('solving');
    try {
      const result = await createScrambleFromInspection(facelets);
      if (generation !== analysisGeneration.current) return;
      if (!result.verified) throw new Error('Lo scramble non riproduce tutte le caselle osservate.');
      setScramble(result);
      setSolverStatus('ready');
    } catch (caught) {
      if (generation !== analysisGeneration.current) return;
      setScramble(null);
      setSolverStatus('failed');
      setError(caught instanceof Error ? caught.message : 'Impossibile verificare lo scramble.');
    }
  }, []);

  async function analyzeInspection() {
    const video = videoRef.current;
    if (!video || !videoFile || !video.duration) {
      setError('Attendi che il video sia pronto prima di avviare la scansione.');
      return;
    }

    const generation = ++analysisGeneration.current;
    const reanalysis = scanStatus === 'result' && samples.length > 0;
    const maximumFusionPasses = 1;
    let combinedSamples = reanalysis ? [...samples] : [];
    let completedRuns = reanalysis ? runCount : 0;
    let latestSummary: CubeObservationSummary | null = null;

    setScanStatus('running');
    setSolverStatus('idle');
    setScramble(null);
    setCopied(false);
    setError('');
    setProgress(0);
    setAnalysisPhase('motion');
    video.pause();

    try {
      const decoded = await decodeVideoMotion(video, {
        startTime: 0,
        endTime: video.duration,
        analysisPass: completedRuns,
        onProgress: (value) => setProgress(value * 0.34),
      });
      if (generation !== analysisGeneration.current) return;

      const segmentation = inferVideoSegmentation(decoded.events, 0, video.duration);
      const solveWindow = segmentation.windows.find((window) => window.id === segmentation.defaultWindowId);
      const inspectionStage = solveWindow?.stages.find((stage) => stage.kind === 'inspection');
      const automaticStart = inspectionStage?.start ?? 0;
      const intervalStart = Math.max(0, Math.min(automaticStart, video.duration - 0.5));
      const segmentationHint = inspectionStage?.end ?? solveWindow?.start ?? null;
      const baseSearchEnd = Math.min(
        video.duration,
        Math.max(8, Math.min(25, video.duration * 0.72)),
      );
      const hintedSearchEnd = segmentationHint && segmentationHint >= intervalStart + 2
        ? Math.min(video.duration, segmentationHint + 3)
        : intervalStart;
      const searchEnd = Math.max(baseSearchEnd, hintedSearchEnd);

      setAnalysisPhase('boundary');
      const boundarySamples = await scanInspectionFrames(video, intervalStart, searchEnd, {
        analysisPass: completedRuns,
        onProgress: (value) => setProgress(0.34 + value * 0.34),
      });
      if (generation !== analysisGeneration.current) return;
      const boundary = inferInspectionEnd(
        boundarySamples,
        decoded.events,
        intervalStart,
        searchEnd,
        segmentationHint,
      );
      const firstCubeChange = Math.max(intervalStart + 0.5, boundary.time);
      const intervalEnd = Math.max(
        intervalStart + 0.5,
        Math.min(lastInspectionFrameTime(intervalStart, firstCubeChange, 60), video.duration),
      );
      setActiveInterval({ start: intervalStart, end: intervalEnd });
      const automaticInspectionSamples = boundarySamples.filter((sample) => sample.time <= intervalEnd);
      combinedSamples = reanalysis
        ? [...combinedSamples, ...automaticInspectionSamples]
        : automaticInspectionSamples;
      completedRuns += 1;
      latestSummary = summarizeCubeObservation(combinedSamples, intervalStart, intervalEnd);
      setAnalysisPhase('frames');

      for (let pass = 0; pass < maximumFusionPasses && latestSummary.reconstruction.status !== 'complete'; pass += 1) {
        const scanned = await scanInspectionFrames(video, intervalStart, intervalEnd, {
          analysisPass: completedRuns,
          onProgress: (value) => setProgress(0.68 + ((pass + value) / maximumFusionPasses) * 0.28),
        });
        if (generation !== analysisGeneration.current) return;
        combinedSamples = [...combinedSamples, ...scanned];
        completedRuns += 1;
        latestSummary = summarizeCubeObservation(combinedSamples, intervalStart, intervalEnd);
        if (latestSummary.reconstruction.status === 'complete') break;
      }

      if (latestSummary && !latestSummary.reconstruction.observedFaces.length) {
        latestSummary = summarizeCubeObservation(
          [...combinedSamples, ...decoded.samples],
          intervalStart,
          intervalEnd,
        );
      }

      if (!latestSummary) throw new Error('Nessun fotogramma utilizzabile trovato nell’ispezione.');
      setAnalysisPhase('fusing');
      setProgress(0.98);
      const finalSummary = { ...latestSummary, keyframes: [] };
      setSummary(finalSummary);
      setCubeDraft(copyFacelets(finalSummary.reconstruction.facelets));
      setSamples(combinedSamples);
      setRunCount(completedRuns);
      setProgress(1);
      setScanStatus('result');
      setAnalysisPhase('idle');
      await calculateScrambleFromFacelets(finalSummary.reconstruction.completeFacelets, generation);
    } catch (caught) {
      if (generation !== analysisGeneration.current) return;
      setScanStatus('failed');
      setAnalysisPhase('idle');
      setSolverStatus('idle');
      setError(caught instanceof Error ? caught.message : 'Impossibile analizzare il video.');
    }
  }

  async function copyScramble() {
    if (!scramble?.verified) return;
    try {
      await navigator.clipboard.writeText(scramble.scramble);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  const reconstruction = summary?.reconstruction ?? null;
  const draftKnownFacelets = Math.max(0, FACES.reduce((total, face) => total + cubeDraft[face].filter(Boolean).length, 0) - 6);
  const resultAvailable = Boolean(reconstruction);
  const resultComplete = reconstruction?.status === 'complete';
  const resultMessage = reconstruction?.message ?? '';
  const resultConfidence = summary?.confidence ?? null;
  const statusLabel = resultComplete
    ? 'Stato completo'
    : reconstruction?.status === 'invalid'
      ? 'Lettura incoerente'
      : resultAvailable
        ? 'Stato parziale'
        : 'In attesa';
  const analysisPhaseLabel = analysisPhase === 'motion'
    ? 'Analizzo il movimento del cubo e delle mani'
    : analysisPhase === 'boundary'
      ? 'Distinguo le rotazioni x/y/z dalla prima vera mossa'
      : analysisPhase === 'frames'
      ? 'Acquisisco automaticamente le viste più utili'
      : analysisPhase === 'fusing'
        ? 'Unisco i colori nello schema 3×3'
        : 'Analisi automatica';

  return (
    <main className="min-h-screen px-4 py-5 text-slate-950 sm:px-8 lg:px-12">
      <div className="mx-auto max-w-[1280px]">
        <header className="flex items-center justify-between border-b border-slate-200/80 pb-5">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 grid-cols-2 gap-1 rounded-xl bg-slate-950 p-2 shadow-lg shadow-slate-950/10">
              <span className="rounded-sm bg-yellow-400" /><span className="rounded-sm bg-red-500" />
              <span className="rounded-sm bg-green-500" /><span className="rounded-sm bg-blue-500" />
            </div>
            <div>
              <p className="text-sm font-black tracking-[-0.02em]">CubeSolve Coach</p>
              <p className="text-xs text-slate-500">Ricostruzione dello scramble 3×3</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <a href="/scanner/" className="rounded-full bg-blue-600 px-3 py-2 text-[10px] font-black uppercase tracking-wide text-white shadow-lg shadow-blue-600/20 transition hover:bg-blue-700">Analizza video</a>
            <span className="hidden rounded-full border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-bold text-blue-700 sm:inline">Passo 1</span>
          </div>
        </header>

        <div className="grid gap-8 py-10 lg:grid-cols-[minmax(0,0.88fr)_minmax(520px,1.12fr)] lg:items-start lg:gap-12 lg:py-14">
          <section>
            <p className="mb-4 text-xs font-black uppercase tracking-[0.2em] text-blue-600">Un solo obiettivo</p>
            <h1 className="max-w-2xl text-4xl font-black leading-[0.98] tracking-[-0.055em] sm:text-6xl">Ricostruiamo prima la mischiata.</h1>
            <p className="mt-5 max-w-xl text-base leading-7 text-slate-600 sm:text-lg">Durante l’ispezione ruota soltanto il cubo e mostra tutte le facce. L’app usa quei fotogrammi per ricostruire i pezzi e creare lo scramble con bianco sopra e verde davanti.</p>

            <div className="mt-7 rounded-[28px] border border-slate-200 bg-white p-5 shadow-[0_24px_70px_-34px_rgba(15,23,42,0.35)] sm:p-7">
              <div className="flex items-center justify-between gap-4">
                <div><p className="text-[11px] font-black uppercase tracking-[0.16em] text-blue-600">Video dell’ispezione</p><h2 className="mt-1 text-sm font-extrabold">Mostra lo stato prima di iniziare la solve</h2></div>
                <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-[10px] font-black uppercase tracking-wide text-emerald-700">Locale</span>
              </div>

              {videoUrl ? (
                <>
                  <div className="mt-4 overflow-hidden rounded-2xl border border-slate-200 bg-slate-950">
                    <video
                      ref={videoRef}
                      key={videoUrl}
                      src={videoUrl}
                      controls
                      playsInline
                      preload="metadata"
                      className="aspect-video w-full bg-black object-contain"
                      onLoadedMetadata={(event) => {
                        const video = event.currentTarget;
                        setVideoMeta({ duration: video.duration, width: video.videoWidth, height: video.videoHeight });
                      }}
                    >Il browser non riesce a riprodurre questo formato video.</video>
                    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-xs text-slate-300">
                      <div className="min-w-0"><p className="truncate font-bold text-white">{videoFile?.name}</p><p className="mt-0.5 text-slate-500">{videoFile ? formatFileSize(videoFile.size) : ''}{videoMeta.width ? ` · ${videoMeta.width}×${videoMeta.height} · ${formatDuration(videoMeta.duration)}` : ''}</p></div>
                      <label htmlFor="video-upload" className="cursor-pointer rounded-lg border border-white/15 px-3 py-2 font-bold transition hover:bg-white/10">Sostituisci</label>
                    </div>
                  </div>
                  <button type="button" onClick={() => { void analyzeInspection(); }} disabled={scanStatus === 'running'} className="mt-4 w-full rounded-2xl bg-blue-600 px-5 py-4 text-sm font-black text-white shadow-lg shadow-blue-600/20 transition hover:bg-blue-700 focus:outline-none focus:ring-4 focus:ring-blue-500/20 disabled:cursor-wait disabled:opacity-60">
                    {scanStatus === 'running' ? `Scansione dei colori · ${Math.round(progress * 100)}%` : scanStatus === 'result' ? `Rianalizza e confronta · lettura ${runCount + 1}` : 'Analizza lo stato iniziale'}
                  </button>
                </>
              ) : (
                <label htmlFor="video-upload" className="mt-4 flex min-h-40 cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-blue-200 bg-blue-50/60 px-5 py-7 text-center transition hover:border-blue-400 hover:bg-blue-50" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); chooseVideo(event.dataTransfer.files?.[0] ?? null); }}>
                  <span className="grid h-11 w-11 place-items-center rounded-xl bg-blue-600 text-xl text-white shadow-lg shadow-blue-600/20">↑</span>
                  <span className="mt-3 text-sm font-black">Carica o trascina il video</span><span className="mt-1 text-xs text-slate-500">MOV, MP4, M4V o WebM · il file resta sul dispositivo</span>
                </label>
              )}
              <input id="video-upload" type="file" accept="video/*,.mov,.m4v" onChange={onVideoInput} className="sr-only" />

              {scanStatus === 'running' ? (
                <div className="mt-3 rounded-2xl border border-blue-200 bg-blue-50 p-4">
                  <div className="flex items-center justify-between gap-3 text-xs font-black text-blue-950"><span>{analysisPhaseLabel}</span><span>{Math.round(progress * 100)}%</span></div>
                  <div className="mt-3 h-2 overflow-hidden rounded-full bg-blue-100"><div className="h-full rounded-full bg-blue-600 transition-[width]" style={{ width: `${progress * 100}%` }} /></div>
                  <p className="mt-2 text-[11px] leading-4 text-blue-800">I fotogrammi vengono elaborati senza essere mostrati né conservati. Alla fine resta soltanto lo schema colore ricostruito.</p>
                </div>
              ) : null}
              {error ? <p role="alert" className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">{error}</p> : null}
            </div>

            <div className="mt-5 rounded-2xl border border-slate-200 bg-white/80 p-4">
              <p className="text-xs font-black uppercase tracking-[0.14em] text-slate-500">Per una lettura migliore</p>
              <ol className="mt-3 space-y-2 text-sm leading-6 text-slate-600"><li><strong className="text-slate-900">1.</strong> Parti dal cubo già mischiato.</li><li><strong className="text-slate-900">2.</strong> Ruotalo lentamente senza girare singole facce.</li><li><strong className="text-slate-900">3.</strong> Lascia ogni lato visibile e fermo per circa mezzo secondo.</li></ol>
            </div>
          </section>

          <section className="overflow-hidden rounded-[32px] border border-slate-800 bg-slate-950 text-white shadow-[0_35px_90px_-38px_rgba(15,23,42,0.8)] lg:sticky lg:top-6">
            <div className="border-b border-white/10 bg-[radial-gradient(circle_at_70%_0%,#29458d_0%,#10172d_38%,#080c18_76%)] p-6 sm:p-8">
              <div className="flex items-start justify-between gap-4"><div><p className="text-xs font-black uppercase tracking-[0.18em] text-blue-300">Stato iniziale</p><h2 className="mt-2 text-2xl font-black tracking-tight">{statusLabel}</h2></div>{resultConfidence !== null ? <span className="rounded-full border border-white/10 bg-white/10 px-3 py-1.5 text-xs font-black">{resultConfidence}%</span> : null}</div>
              {!resultAvailable ? (
                <div className="grid min-h-48 place-items-center text-center"><div className="max-w-sm"><div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-blue-300/20 bg-blue-400/10 text-2xl text-blue-300">◫</div><p className="mt-5 text-sm leading-6 text-slate-400">Qui compariranno soltanto i colori ricostruiti e lo scramble. Il riconoscimento delle mosse e delle fasi è sospeso.</p></div></div>
              ) : (
                <><p className="mt-3 text-sm leading-6 text-slate-400">{resultMessage}</p>{activeInterval ? <p className="mt-2 font-mono text-[11px] text-slate-500">Fotogrammi analizzati: {formatPreciseTime(activeInterval.start)}–{formatPreciseTime(activeInterval.end)} · arresto prima della prima mossa · immagini eliminate</p> : null}<div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4"><div className="rounded-xl bg-white/5 p-3"><p className="text-[9px] font-black uppercase tracking-wide text-slate-500">Facce</p><p className="mt-1 text-xl font-black">{reconstruction?.observedFaces.length ?? 0}/6</p></div><div className="rounded-xl bg-white/5 p-3"><p className="text-[9px] font-black uppercase tracking-wide text-slate-500">Caselle</p><p className="mt-1 text-xl font-black">{draftKnownFacelets}/48</p></div><div className="rounded-xl bg-white/5 p-3"><p className="text-[9px] font-black uppercase tracking-wide text-slate-500">Angoli</p><p className="mt-1 text-xl font-black">{reconstruction ? `${reconstruction.resolvedCorners}/8` : scramble?.verified ? '8/8' : '—'}</p></div><div className="rounded-xl bg-white/5 p-3"><p className="text-[9px] font-black uppercase tracking-wide text-slate-500">Spigoli</p><p className="mt-1 text-xl font-black">{reconstruction ? `${reconstruction.resolvedEdges}/12` : scramble?.verified ? '12/12' : '—'}</p></div></div></>
              )}
            </div>
            <div className="bg-slate-100 p-4 text-slate-950 sm:p-6">
              <div className="rounded-2xl border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div><p className="text-[10px] font-black uppercase tracking-[0.14em] text-blue-600">Schema del cubo aperto</p><h3 className="mt-1 text-sm font-black">Bianco sopra · verde davanti</h3><p className="mt-1 max-w-md text-[10px] leading-4 text-slate-500">Risultato della fusione automatica dei fotogrammi precedenti alla prima vera mossa del cubo.</p></div>
                  <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-black text-slate-600">{draftKnownFacelets}/48 caselle</span>
                </div>
                <div className="mt-4"><CubeNetEditor facelets={cubeDraft} /></div>
              </div>
            </div>
            <div className="border-t border-white/10 p-6 sm:p-8">
              {solverStatus === 'solving' ? (
                <div className="rounded-2xl border border-blue-300/20 bg-blue-400/10 p-5"><p className="text-xs font-black uppercase tracking-[0.14em] text-blue-300">Stato completo</p><p className="mt-2 text-sm leading-6 text-slate-300">Confronto più soluzioni valide e scelgo lo scramble più corto trovato…</p></div>
              ) : scramble?.verified ? (
                <div className="rounded-2xl border border-emerald-300/20 bg-emerald-300/5 p-5">
                  <div className="flex items-center justify-between gap-3"><div><p className="text-[10px] font-black uppercase tracking-[0.16em] text-emerald-300">Scramble più corto trovato</p><p className="mt-1 text-xs font-bold text-slate-400">Bianco sopra · verde davanti</p></div><button type="button" onClick={() => { void copyScramble(); }} className="rounded-lg border border-white/15 px-3 py-2 text-[10px] font-black uppercase tracking-wide text-slate-300 hover:bg-white/10 hover:text-white">{copied ? 'Copiato ✓' : 'Copia'}</button></div>
                  <p className="mt-5 break-words font-mono text-xl font-black leading-8 text-yellow-300">{scramble.scramble || 'Cubo già risolto'}</p>
                  <div className="mt-4 flex flex-wrap gap-2 text-[10px] font-bold text-slate-400"><span className="rounded-full bg-white/5 px-2.5 py-1.5">{scramble.moveCount} mosse HTM</span><span className="rounded-full bg-white/5 px-2.5 py-1.5">{scramble.candidatesTested} soluzioni verificate</span><span className="rounded-full bg-emerald-400/10 px-2.5 py-1.5 text-emerald-300">54/54 caselle confrontate</span></div>
                  <p className="mt-4 text-[11px] leading-5 text-slate-500">Lo scramble è stato rieseguito virtualmente e riproduce esattamente lo stato letto. È il più breve trovato dalla ricerca multipla; la minimalità matematica assoluta richiederebbe una ricerca ottimale molto più pesante.</p>
                </div>
              ) : resultAvailable ? (
                <div className={`rounded-2xl border p-5 ${reconstruction?.status === 'invalid' ? 'border-red-300/20 bg-red-300/5' : 'border-amber-300/20 bg-amber-300/5'}`}><p className={`text-xs font-black uppercase tracking-[0.14em] ${reconstruction?.status === 'invalid' ? 'text-red-300' : 'text-amber-300'}`}>Nessuno scramble ancora</p><p className="mt-2 text-sm leading-6 text-slate-300">Non mostro una sequenza stimata: prima deve esistere un unico stato fisicamente valido. Cerca di mostrare le facce “Manca” e completare quelle “Parziale”, poi usa “Rianalizza e confronta”.</p></div>
              ) : <p className="text-center text-sm leading-6 text-slate-500">Lo scramble apparirà qui soltanto dopo una ricostruzione completa.</p>}
            </div>
          </section>
        </div>
        <div className="mb-12 rounded-2xl border border-slate-200 bg-white/70 px-5 py-4 text-center text-xs leading-5 text-slate-500">In pausa per ora: fotocamera guidata, riconoscimento R/L/U/D/F/B, Cross, F2L, OLL, PLL e replay. Li riattiveremo soltanto dopo aver validato bene lo scramble.</div>
      </div>
    </main>
  );
}
