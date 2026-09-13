'use client';

import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CANONICAL_FACE_COLOR, COLOR_HEX, CUBE_FACES, type CubeColor, type Face } from '../lib/cube';
import {
  mapGridGeometryToVideoSpace,
  type CubeObservationSummary,
  type MotionSample,
} from '../lib/video-decoder';
import { reconstructInspectionFromVideo } from '../lib/inspection-pipeline';
import { createScrambleFromInspection, type InspectionScramble } from '../lib/inspection-solver';
import { faceletsToSolverString, type InspectionReconstruction, type PartialFacelets } from '../lib/inspection-state';
import { createBlankFacelets, copyFacelets, FACE_LABELS } from '../lib/facelets-ui';
import { formatDuration, formatPreciseTime, formatFileSize } from '../lib/format';
import { CubeNet } from '../components/CubeNet';

const FACES = CUBE_FACES;

type ScanStatus = 'idle' | 'running' | 'result' | 'failed';
type SolverStatus = 'idle' | 'solving' | 'ready' | 'failed';

export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const snapshotCanvasRef = useRef<HTMLCanvasElement>(null);
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
  const [frameSnapshots, setFrameSnapshots] = useState<Partial<Record<Face, string>>>({});
  const [snapshotLoading, setSnapshotLoading] = useState<Face | null>(null);
  const [solverCopied, setSolverCopied] = useState(false);

  useEffect(() => () => {
    if (videoUrl) URL.revokeObjectURL(videoUrl);
  }, [videoUrl]);

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      void navigator.serviceWorker.register('/sw.js', { scope: '/' });
    }
  }, []);

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
    setFrameSnapshots({});
    setSolverCopied(false);
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

    setScanStatus('running');
    setSolverStatus('idle');
    setScramble(null);
    setCopied(false);
    setError('');
    setProgress(0);
    setAnalysisPhase('motion');
    video.pause();

    try {
      const result = await reconstructInspectionFromVideo(video, {
        priorSamples: reanalysis ? samples : [],
        priorRunCount: reanalysis ? runCount : 0,
        maxFusionPasses: 1,
        onProgress: setProgress,
        onPhase: setAnalysisPhase,
        shouldCancel: () => generation !== analysisGeneration.current,
      });
      if (!result) return;

      setActiveInterval(result.interval);
      const finalSummary = { ...result.summary, keyframes: [] };
      setSummary(finalSummary);
      setCubeDraft(copyFacelets(finalSummary.reconstruction.facelets));
      setSamples(result.samples);
      setRunCount(result.runCount);
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

  async function copySolverString(value: string) {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setSolverCopied(true);
      setTimeout(() => setSolverCopied(false), 1800);
    } catch {
      setSolverCopied(false);
    }
  }

  async function captureFrameReference(face: Face, reference: NonNullable<InspectionReconstruction['faceReference'][Face]>) {
    const video = videoRef.current;
    const canvas = snapshotCanvasRef.current;
    if (!video || !canvas || !video.duration) return;
    setSnapshotLoading(face);
    const originalTime = video.currentTime;
    const wasPaused = video.paused;
    if (!wasPaused) video.pause();
    try {
      await new Promise<void>((resolve) => {
        const handleSeeked = () => { video.removeEventListener('seeked', handleSeeked); resolve(); };
        video.addEventListener('seeked', handleSeeked);
        video.currentTime = Math.min(video.duration - 0.01, Math.max(0, reference.time));
      });
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext('2d');
      if (!context) return;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const geometry = mapGridGeometryToVideoSpace(reference, video);
      if (geometry && reference.silhouette?.length) {
        const mapped = reference.silhouette.map((vertex) => mapGridGeometryToVideoSpace({
          frameId: reference.frameId,
          imageX: vertex.x,
          imageY: vertex.y,
          rightX: 1, rightY: 0, downX: 0, downY: 1,
        }, video));
        if (mapped.every(Boolean)) {
          context.beginPath();
          mapped.forEach((point, index) => {
            if (!point) return;
            if (index === 0) context.moveTo(point.x, point.y);
            else context.lineTo(point.x, point.y);
          });
          context.closePath();
          context.strokeStyle = 'rgba(0,0,0,0.8)';
          context.lineWidth = Math.max(6, canvas.width * 0.013);
          context.stroke();
          context.strokeStyle = '#fb923c';
          context.lineWidth = Math.max(3, canvas.width * 0.006);
          context.stroke();
        }
      }
      if (geometry) {
        const cellCorners = (row: number, column: number) => {
          const cellCenterX = geometry.x + geometry.rightX * column + geometry.downX * row;
          const cellCenterY = geometry.y + geometry.rightY * column + geometry.downY * row;
          return [-0.5, 0.5].flatMap((dy) => [-0.5, 0.5].map((dx): [number, number] => [
            cellCenterX + geometry.rightX * dx + geometry.downX * dy,
            cellCenterY + geometry.rightY * dx + geometry.downY * dy,
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
        context.lineWidth = Math.max(6, canvas.width * 0.014);
        drawGridPath();
        context.stroke();
        context.strokeStyle = '#22d3ee';
        context.lineWidth = Math.max(3, canvas.width * 0.007);
        drawGridPath();
        context.stroke();
        const centerCorners = cellCorners(0, 0);
        context.beginPath();
        context.moveTo(centerCorners[0][0], centerCorners[0][1]);
        [centerCorners[1], centerCorners[3], centerCorners[2]].forEach(([x, y]) => context.lineTo(x, y));
        context.closePath();
        context.fillStyle = 'rgba(250,204,21,0.38)';
        context.fill();
        context.strokeStyle = '#facc15';
        context.lineWidth = Math.max(3, canvas.width * 0.007);
        context.stroke();
      } else {
        context.fillStyle = 'rgba(0,0,0,0.55)';
        context.fillRect(0, canvas.height * 0.44, canvas.width, canvas.height * 0.12);
        context.fillStyle = '#f8fafc';
        context.font = `${Math.round(canvas.width * 0.032)}px sans-serif`;
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText('Geometria della griglia non disponibile', canvas.width / 2, canvas.height * 0.5);
      }
      setFrameSnapshots((previous) => ({ ...previous, [face]: canvas.toDataURL('image/jpeg', 0.85) }));
    } finally {
      await new Promise<void>((resolve) => {
        const handleSeeked = () => { video.removeEventListener('seeked', handleSeeked); resolve(); };
        video.addEventListener('seeked', handleSeeked);
        video.currentTime = originalTime;
      });
      if (!wasPaused) await video.play().catch(() => undefined);
      setSnapshotLoading(null);
    }
  }

  const reconstruction = summary?.reconstruction ?? null;
  const solverString = useMemo(
    () => reconstruction?.completeFacelets ? faceletsToSolverString(reconstruction.completeFacelets) : '',
    [reconstruction],
  );
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
                <div className="mt-4"><CubeNet facelets={cubeDraft} theme="light" /></div>
              </div>

              {reconstruction && Object.keys(reconstruction.faceReference).length > 0 ? (
                <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-4">
                  <p className="text-[10px] font-black uppercase tracking-[0.14em] text-blue-600">Fotogrammi scelti</p>
                  <h3 className="mt-1 text-sm font-black">Da dove viene ogni faccia</h3>
                  <p className="mt-1 max-w-md text-[10px] leading-4 text-slate-500">Per ogni faccia, l’istante del video la cui lettura è stata usata nella ricostruzione.</p>
                  <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {FACES.filter((face) => reconstruction.faceReference[face]).map((face) => {
                      const reference = reconstruction.faceReference[face]!;
                      const snapshot = frameSnapshots[face];
                      return (
                        <div key={face} className="rounded-xl border border-slate-200 bg-slate-50 p-2">
                          <div className="flex items-center gap-1.5">
                            <span className="h-3 w-3 rounded-[3px] border border-black/10" style={{ backgroundColor: COLOR_HEX[CANONICAL_FACE_COLOR[face]] }} />
                            <span className="text-[10px] font-black text-slate-700">{FACE_LABELS[face]}</span>
                          </div>
                          <p className="mt-1 text-[9px] text-slate-500">{formatPreciseTime(reference.time)} · {reference.sourceFrames > 1 ? `fuso da ${reference.sourceFrames} fotogrammi` : '1 fotogramma'}</p>
                          {reference.gridSource ? (
                            <p className={`text-[9px] font-black ${reference.gridSource === 'silhouette' ? 'text-orange-600' : 'text-slate-400'}`}>
                              {reference.gridSource === 'silhouette' ? 'da silhouette del cubo' : 'da coppie di sticker'}
                            </p>
                          ) : null}
                          {snapshot ? (
                            <img src={snapshot} alt={`Fotogramma faccia ${FACE_LABELS[face]}`} className="mt-1.5 aspect-video w-full rounded-lg object-cover" />
                          ) : (
                            <button
                              type="button"
                              onClick={() => { void captureFrameReference(face, reference); }}
                              disabled={snapshotLoading === face}
                              className="mt-1.5 w-full rounded-lg border border-slate-200 bg-white py-1.5 text-[9px] font-black text-slate-600 disabled:opacity-50"
                            >
                              {snapshotLoading === face ? 'Carico…' : 'Vedi fotogramma'}
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <canvas ref={snapshotCanvasRef} className="hidden" />
                </div>
              ) : null}
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

              {solverString ? (
                <div className="mt-4 rounded-2xl border border-white/10 bg-white/5 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[10px] font-black uppercase tracking-[0.14em] text-slate-400">Stringa Singmaster · URFDLB</span>
                    <button type="button" onClick={() => { void copySolverString(solverString); }} className="rounded-lg border border-white/15 px-2.5 py-1.5 text-[9px] font-black uppercase tracking-wide text-slate-300 hover:bg-white/10 hover:text-white">{solverCopied ? 'Copiato ✓' : 'Copia'}</button>
                  </div>
                  <textarea value={solverString} readOnly spellCheck={false} className="mt-2 min-h-20 w-full resize-none rounded-xl border border-white/10 bg-slate-950/75 p-2.5 font-mono text-[11px] font-bold leading-5 text-yellow-200 outline-none" />
                </div>
              ) : null}
            </div>
          </section>
        </div>
        <div className="mb-12 rounded-2xl border border-slate-200 bg-white/70 px-5 py-4 text-center text-xs leading-5 text-slate-500">In pausa per ora: fotocamera guidata, riconoscimento R/L/U/D/F/B, Cross, F2L, OLL, PLL e replay. Li riattiveremo soltanto dopo aver validato bene lo scramble.</div>
      </div>
    </main>
  );
}
