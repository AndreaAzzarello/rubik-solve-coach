'use client';

import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CANONICAL_FACE_COLOR,
  COLOR_HEX,
  COLOR_LABELS,
  CUBE_FACES,
  type CubeColor,
  type Face,
} from '../../lib/cube';
import {
  decodeVideoMotion,
  inferInspectionEnd,
  inferPllAndCrossColor,
  inferVideoSegmentation,
  lastInspectionFrameTime,
  scanInspectionFrames,
  summarizeCubeObservation,
  type CubeObservationSummary,
  type MotionEvent,
  type MotionSample,
} from '../../lib/video-decoder';
import { createScrambleFromInspection, type InspectionScramble } from '../../lib/inspection-solver';
import { faceletsToSolverString, type PartialFacelets } from '../../lib/inspection-state';
import {
  buildSolveTranscript,
  formatTranscript,
  type SolveTranscript,
} from '../../lib/solve-transcription';
import { buildVirtualReplay, type VirtualReplay } from '../../lib/virtual-replay';

const FACES = CUBE_FACES;
const FACE_LABEL: Record<Face, string> = {
  U: 'Sopra', R: 'Destra', F: 'Fronte', D: 'Sotto', L: 'Sinistra', B: 'Retro',
};
const NET_POSITION: Record<Face, string> = {
  U: 'col-start-2 row-start-1', L: 'col-start-1 row-start-2', F: 'col-start-2 row-start-2',
  R: 'col-start-3 row-start-2', B: 'col-start-4 row-start-2', D: 'col-start-2 row-start-3',
};

type ScanStatus = 'idle' | 'ready' | 'running' | 'result' | 'failed';
type AnalysisPhase = 'idle' | 'motion' | 'boundary' | 'frames' | 'fusing';
type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

function blankFacelets(): PartialFacelets {
  return Object.fromEntries(FACES.map((face) => {
    const colors = Array<CubeColor | null>(9).fill(null);
    colors[4] = CANONICAL_FACE_COLOR[face];
    return [face, colors];
  })) as PartialFacelets;
}

function copyFacelets(facelets: PartialFacelets): PartialFacelets {
  return Object.fromEntries(FACES.map((face) => [face, [...facelets[face]]])) as PartialFacelets;
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds)) return '0:00.0';
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds % 60).toFixed(1).padStart(4, '0')}`;
}

function formatSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes > 100 * 1024 * 1024 ? 0 : 1)} MB`;
}

function CubeNet({ facelets }: { facelets: PartialFacelets }) {
  return (
    <div className="overflow-x-auto pb-1">
      <div className="grid min-w-[430px] grid-cols-4 grid-rows-3 gap-2">
        {FACES.map((face) => (
          <article key={face} className={`${NET_POSITION[face]} rounded-xl border border-white/10 bg-slate-900/85 p-2`}>
            <div className="mb-1.5 flex items-center justify-between gap-1">
              <p className="text-[9px] font-black uppercase tracking-[0.1em] text-slate-400">{face} · {FACE_LABEL[face]}</p>
              <span className="text-[8px] font-bold text-slate-500">{facelets[face].filter(Boolean).length}/9</span>
            </div>
            <div className="grid aspect-square grid-cols-3 gap-1 rounded-lg bg-slate-950 p-1.5">
              {facelets[face].map((color, index) => (
                <span
                  key={`${face}-${index}`}
                  className={`rounded-[4px] border border-black/30 ${index === 4 ? 'ring-1 ring-white/70' : ''}`}
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

const REPLAY_SIDES: Array<{ face: Face; className: string }> = [
  { face: 'F', className: 'cube-side-front' },
  { face: 'R', className: 'cube-side-right' },
  { face: 'U', className: 'cube-side-top' },
  { face: 'B', className: 'cube-side-back' },
  { face: 'L', className: 'cube-side-left' },
  { face: 'D', className: 'cube-side-bottom' },
];

function ReplayCube({ facelets, moveToken }: { facelets: Record<Face, CubeColor[]>; moveToken: string | null }) {
  const activeFace = moveToken && /^[URFDLBurfdlb]/.test(moveToken)
    ? moveToken[0].toUpperCase() as Face
    : null;
  return (
    <div className="cube-stage" aria-label="Cubo virtuale nello stato corrente">
      <div className="cube-static">
        <div className="cube-model">
          {REPLAY_SIDES.map(({ face, className }) => (
            <div key={face} className={`cube-side ${className} ${activeFace === face ? 'cube-side-active' : ''}`} aria-label={`Faccia ${face}`}>
              <div className="cube-face">
                {facelets[face].map((color, index) => (
                  <span key={`${face}-${index}`} style={{ backgroundColor: COLOR_HEX[color] }} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="cube-caption"><span>U · sopra</span><span>F · fronte</span><span>R · destra</span></div>
    </div>
  );
}

function VirtualCubeReplay({ replay }: { replay: VirtualReplay }) {
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const total = replay.moves.length;
  const currentMove = step > 0 ? replay.moves[step - 1] : null;

  useEffect(() => {
    if (!playing || step >= total) return;
    const timer = window.setTimeout(() => {
      const nextStep = Math.min(total, step + 1);
      setStep(nextStep);
      if (nextStep >= total) setPlaying(false);
    }, 820 / speed);
    return () => window.clearTimeout(timer);
  }, [playing, speed, step, total]);

  function seek(nextStep: number) {
    setPlaying(false);
    setStep(Math.max(0, Math.min(total, nextStep)));
  }

  function togglePlayback() {
    if (step >= total) setStep(0);
    setPlaying((value) => !value);
  }

  function cycleSpeed() {
    const speeds = [0.5, 1, 1.5, 2];
    setSpeed(speeds[(speeds.indexOf(speed) + 1) % speeds.length]);
  }

  return (
    <section className="mt-3 overflow-hidden rounded-[20px] border border-violet-400/20 bg-slate-900/85">
      <div className="flex items-start justify-between gap-3 p-3.5 pb-0">
        <div><p className="text-[10px] font-black uppercase tracking-[.14em] text-violet-300">Replay virtuale</p><h3 className="mt-1 text-sm font-black">Rivedi la solve mossa per mossa</h3></div>
        <span className="rounded-full bg-violet-500/10 px-2.5 py-1 text-[10px] font-black text-violet-200">{step}/{total}</span>
      </div>

      <ReplayCube facelets={replay.frames[step]} moveToken={currentMove?.token ?? null} />

      <div className="border-t border-white/10 bg-slate-950/55 p-3.5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[9px] font-black uppercase tracking-[.12em] text-slate-500">{currentMove?.label ?? 'Stato iniziale'}</p>
            <p className="mt-1 truncate font-mono text-xl font-black text-yellow-200">{currentMove?.token ?? 'Pronto'}</p>
          </div>
          <span className={`rounded-full px-2.5 py-1 text-[10px] font-black ${!currentMove || currentMove.confidence >= 65 ? 'bg-emerald-500/10 text-emerald-300' : currentMove.confidence >= 48 ? 'bg-amber-500/10 text-amber-300' : 'bg-rose-500/10 text-rose-300'}`}>
            {currentMove ? `${currentMove.confidence}%` : replay.derivedInitialState ? 'Stato dedotto' : 'Stato osservato'}
          </span>
        </div>

        <input
          type="range"
          min={0}
          max={total}
          value={step}
          onChange={(event) => seek(Number(event.target.value))}
          aria-label="Posizione del replay"
          className="mb-3 w-full accent-violet-500"
        />
        <div className="grid grid-cols-5 gap-2">
          <button type="button" onClick={() => seek(0)} aria-label="Riavvia replay" className="replay-button">↺</button>
          <button type="button" onClick={() => seek(step - 1)} disabled={step === 0} aria-label="Mossa precedente" className="replay-button disabled:opacity-35">◀</button>
          <button type="button" onClick={togglePlayback} aria-label={playing ? 'Pausa replay' : 'Riproduci replay'} className="replay-button replay-button-primary">{playing ? '❚❚' : '▶'}</button>
          <button type="button" onClick={() => seek(step + 1)} disabled={step === total} aria-label="Mossa successiva" className="replay-button disabled:opacity-35">▶</button>
          <button type="button" onClick={cycleSpeed} aria-label="Cambia velocità" className="replay-button text-[11px]">{speed}×</button>
        </div>
        <p className="mt-3 text-[10px] leading-4 text-slate-500">Il cubo applica esattamente le mosse trascritte, incluse le rotazioni d’ispezione. Una bassa percentuale indica una mossa ancora incerta nell’analisi video.</p>
      </div>
    </section>
  );
}

export default function VideoScannerPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const generationRef = useRef(0);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState('');
  const [duration, setDuration] = useState(0);
  const [status, setStatus] = useState<ScanStatus>('idle');
  const [phase, setPhase] = useState<AnalysisPhase>('idle');
  const [progress, setProgress] = useState(0);
  const [samples, setSamples] = useState<MotionSample[]>([]);
  const [motionRuns, setMotionRuns] = useState<MotionEvent[][]>([]);
  const [runCount, setRunCount] = useState(0);
  const [summary, setSummary] = useState<CubeObservationSummary | null>(null);
  const [facelets, setFacelets] = useState<PartialFacelets>(() => blankFacelets());
  const [scramble, setScramble] = useState<InspectionScramble | null>(null);
  const [transcript, setTranscript] = useState<SolveTranscript | null>(null);
  const [solving, setSolving] = useState(false);
  const [inspection, setInspection] = useState<{ start: number; end: number } | null>(null);
  const [message, setMessage] = useState('Carica un video MOV, MP4, M4V o WebM. Nessun file viene inviato online.');
  const [messageTone, setMessageTone] = useState<'info' | 'success' | 'error'>('info');
  const [copied, setCopied] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);

  useEffect(() => () => {
    if (videoUrl) URL.revokeObjectURL(videoUrl);
  }, [videoUrl]);

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      void navigator.serviceWorker.register('/sw.js', { scope: '/' });
    }
    const handler = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const reconstruction = summary?.reconstruction ?? null;
  const completeFacelets = reconstruction?.completeFacelets ?? null;
  const solverString = useMemo(
    () => completeFacelets ? faceletsToSolverString(completeFacelets) : '',
    [completeFacelets],
  );
  const transcriptText = useMemo(
    () => transcript ? formatTranscript(transcript, scramble?.verified ? scramble.scramble : '') : '',
    [transcript, scramble],
  );
  const replay = useMemo(
    () => transcript ? buildVirtualReplay(transcript, completeFacelets) : null,
    [transcript, completeFacelets],
  );
  const observedFaces = new Set(reconstruction?.observedFaces ?? []);
  const knownCells = Math.max(0, FACES.reduce((total, face) => total + facelets[face].filter(Boolean).length, 0) - 6);

  const phaseText = phase === 'motion'
    ? 'Analizzo movimento del cubo e delle mani'
    : phase === 'boundary'
      ? 'Riconosco la fine dell’ispezione'
      : phase === 'frames'
        ? 'Acquisisco e unisco i fotogrammi utili'
        : phase === 'fusing'
          ? 'Ricostruisco lo schema completo'
          : status === 'result'
            ? reconstruction?.status === 'complete' ? 'Stato del cubo ricostruito' : 'Ricostruzione parziale'
            : videoFile ? 'Video pronto per l’analisi' : 'Carica il video della risoluzione';

  function chooseVideo(file: File | null) {
    if (!file) return;
    const valid = file.type.startsWith('video/') || /\.(mov|mp4|m4v|webm)$/i.test(file.name);
    if (!valid) {
      setMessageTone('error');
      setMessage('Il file scelto non è un video MOV, MP4, M4V o WebM.');
      return;
    }
    generationRef.current += 1;
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setVideoFile(file);
    setVideoUrl(URL.createObjectURL(file));
    setDuration(0);
    setStatus('ready');
    setPhase('idle');
    setProgress(0);
    setSamples([]);
    setMotionRuns([]);
    setRunCount(0);
    setSummary(null);
    setFacelets(blankFacelets());
    setScramble(null);
    setTranscript(null);
    setInspection(null);
    setCopied(false);
    setMessageTone('success');
    setMessage('Video caricato. Quando è pronto, premi “Analizza video”.');
  }

  function onFileInput(event: ChangeEvent<HTMLInputElement>) {
    chooseVideo(event.target.files?.[0] ?? null);
  }

  const calculateScramble = useCallback(async (complete: Record<Face, CubeColor[]> | null, generation: number) => {
    if (!complete) {
      setScramble(null);
      return;
    }
    setSolving(true);
    try {
      const result = await createScrambleFromInspection(complete);
      if (generation !== generationRef.current) return;
      if (!result.verified) throw new Error('Lo scramble ottenuto non riproduce lo stato osservato.');
      setScramble(result);
    } catch (error) {
      if (generation !== generationRef.current) return;
      setMessageTone('error');
      setMessage(error instanceof Error ? error.message : 'Impossibile verificare lo scramble.');
    } finally {
      if (generation === generationRef.current) setSolving(false);
    }
  }, []);

  async function analyzeVideo() {
    const video = videoRef.current;
    if (!video || !videoFile || !video.duration) {
      setMessageTone('error');
      setMessage('Attendi che il video sia pronto prima di iniziare.');
      return;
    }
    const generation = ++generationRef.current;
    const reanalysis = status === 'result' && samples.length > 0;
    let combined = reanalysis ? [...samples] : [];
    let nextMotionRuns = reanalysis ? [...motionRuns] : [];
    let completedRuns = reanalysis ? runCount : 0;
    setStatus('running');
    setPhase('motion');
    setProgress(0);
    setScramble(null);
    setCopied(false);
    setMessageTone('info');
    setMessage('L’analisi avviene localmente. I fotogrammi temporanei non vengono salvati.');
    video.pause();

    try {
      const decoded = await decodeVideoMotion(video, {
        startTime: 0,
        endTime: video.duration,
        analysisPass: completedRuns,
        onProgress: (value) => setProgress(value * 0.34),
      });
      if (generation !== generationRef.current) return;
      nextMotionRuns = [...nextMotionRuns, decoded.events];
      const segmentation = inferVideoSegmentation(decoded.events, 0, video.duration);
      const solveWindow = segmentation.windows.find((candidate) => candidate.id === segmentation.defaultWindowId);
      const inspectionStage = solveWindow?.stages.find((stage) => stage.kind === 'inspection');
      const intervalStart = Math.max(0, Math.min(inspectionStage?.start ?? 0, video.duration - 0.5));
      const hint = inspectionStage?.end ?? solveWindow?.start ?? null;
      const baseEnd = Math.min(video.duration, Math.max(8, Math.min(25, video.duration * 0.72)));
      const searchEnd = Math.max(baseEnd, hint && hint >= intervalStart + 2 ? Math.min(video.duration, hint + 3) : intervalStart);

      setPhase('boundary');
      const boundarySamples = await scanInspectionFrames(video, intervalStart, searchEnd, {
        analysisPass: completedRuns,
        onProgress: (value) => setProgress(0.34 + value * 0.34),
      });
      if (generation !== generationRef.current) return;
      const boundary = inferInspectionEnd(boundarySamples, decoded.events, intervalStart, searchEnd, hint);
      const firstChange = Math.max(intervalStart + 0.5, boundary.time);
      const intervalEnd = Math.max(intervalStart + 0.5, Math.min(
        lastInspectionFrameTime(intervalStart, firstChange, 60),
        video.duration,
      ));
      setInspection({ start: intervalStart, end: intervalEnd });
      combined = reanalysis
        ? [...combined, ...boundarySamples.filter((sample) => sample.time <= intervalEnd)]
        : boundarySamples.filter((sample) => sample.time <= intervalEnd);
      completedRuns += 1;
      let latest = summarizeCubeObservation(combined, intervalStart, intervalEnd);

      if (latest.reconstruction.status !== 'complete') {
        setPhase('frames');
        const extra = await scanInspectionFrames(video, intervalStart, intervalEnd, {
          analysisPass: completedRuns,
          onProgress: (value) => setProgress(0.68 + value * 0.28),
        });
        if (generation !== generationRef.current) return;
        combined = [...combined, ...extra];
        completedRuns += 1;
        latest = summarizeCubeObservation(combined, intervalStart, intervalEnd);
      }
      if (!latest.reconstruction.observedFaces.length) {
        latest = summarizeCubeObservation([...combined, ...decoded.samples], intervalStart, intervalEnd);
      }
      setPhase('fusing');
      setProgress(0.99);
      const finalSummary = { ...latest, keyframes: [] };
      const pllSummary = solveWindow
        ? inferPllAndCrossColor(decoded.samples, solveWindow.start, solveWindow.end)
        : null;
      const nextTranscript = buildSolveTranscript(
        nextMotionRuns,
        solveWindow ?? null,
        finalSummary.reconstruction.completeFacelets,
        pllSummary?.crossColor ?? 'white',
      );
      setSummary(finalSummary);
      setFacelets(copyFacelets(finalSummary.reconstruction.facelets));
      setSamples(combined);
      setMotionRuns(nextMotionRuns);
      setTranscript(nextTranscript);
      setRunCount(completedRuns);
      setProgress(1);
      setStatus('result');
      setPhase('idle');
      setMessageTone(finalSummary.reconstruction.status === 'complete' ? 'success' : 'info');
      setMessage(finalSummary.reconstruction.message);
      await calculateScramble(finalSummary.reconstruction.completeFacelets, generation);
    } catch (error) {
      if (generation !== generationRef.current) return;
      setStatus('failed');
      setPhase('idle');
      setMessageTone('error');
      setMessage(error instanceof Error ? error.message : 'Impossibile analizzare il video.');
    }
  }

  function resetAll() {
    generationRef.current += 1;
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setVideoFile(null);
    setVideoUrl('');
    setDuration(0);
    setStatus('idle');
    setPhase('idle');
    setProgress(0);
    setSamples([]);
    setMotionRuns([]);
    setRunCount(0);
    setSummary(null);
    setFacelets(blankFacelets());
    setScramble(null);
    setTranscript(null);
    setInspection(null);
    setMessageTone('info');
    setMessage('Carica un video MOV, MP4, M4V o WebM. Nessun file viene inviato online.');
    if (inputRef.current) inputRef.current.value = '';
  }

  async function copyOutput(value: string, label: string) {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setMessageTone('success');
    setMessage(`${label} copiato negli appunti.`);
    window.setTimeout(() => setCopied(false), 1600);
  }

  async function installApp() {
    if (installPrompt) {
      await installPrompt.prompt();
      await installPrompt.userChoice;
      setInstallPrompt(null);
      return;
    }
    setMessageTone('info');
    setMessage('Su iPhone o iPad: apri Condividi e scegli “Aggiungi alla schermata Home”.');
  }

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_80%_0%,rgba(37,99,235,.26),transparent_35%),linear-gradient(180deg,#07111f_0%,#020617_72%)] px-3 pb-28 pt-[max(14px,env(safe-area-inset-top))] text-slate-50">
      <div className="mx-auto w-full max-w-[520px]">
        <header className="mb-3.5 flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="grid h-[38px] w-[38px] shrink-0 grid-cols-2 gap-[3px] rounded-xl bg-slate-200 p-2">
              <i className="rounded-[3px] bg-yellow-400" /><i className="rounded-[3px] bg-red-500" />
              <i className="rounded-[3px] bg-green-500" /><i className="rounded-[3px] bg-blue-500" />
            </div>
            <div><h1 className="text-[15px] font-black tracking-tight">Cube Video Scanner</h1><p className="text-[11px] text-slate-400">PWA · analisi locale del filmato</p></div>
          </div>
          <button onClick={installApp} type="button" className="shrink-0 rounded-full border border-blue-400/30 bg-blue-500/10 px-2.5 py-1.5 text-[10px] font-black uppercase tracking-wider text-blue-300">Installa</button>
        </header>

        <section className="mb-3 grid grid-cols-[1fr_auto] items-center gap-3 rounded-[20px] border border-white/10 bg-slate-900/85 p-3.5 backdrop-blur-xl">
          <div><p className="text-[10px] font-black uppercase tracking-[.16em] text-blue-400">{status === 'running' ? 'Analisi automatica' : 'Video della risoluzione'}</p><h2 className="mt-1 text-[17px] font-black tracking-tight">{phaseText}</h2><small className="mt-1 block leading-5 text-slate-400">L’app usa soltanto la parte iniziale di osservazione, fino a un fotogramma prima della prima vera mossa.</small></div>
          <div className="grid h-[52px] w-[52px] place-items-center rounded-2xl border border-blue-400/30 bg-blue-500/10 text-sm font-black text-blue-200">{reconstruction ? `${reconstruction.observedFaces.length}/6` : videoFile ? '✓' : '0/6'}</div>
        </section>

        <section className="overflow-hidden rounded-[28px] border border-white/10 bg-black shadow-[0_28px_80px_rgba(0,0,0,.42)]">
          {videoUrl ? (
            <video
              ref={videoRef}
              src={videoUrl}
              controls
              playsInline
              preload="metadata"
              className="block aspect-[3/4] max-h-[63dvh] w-full bg-black object-contain"
              onLoadedMetadata={(event) => {
                setDuration(event.currentTarget.duration);
                setMessageTone('success');
                setMessage('Video pronto: premi “Analizza video”.');
              }}
            />
          ) : (
            <button type="button" onClick={() => inputRef.current?.click()} className="grid aspect-[3/4] max-h-[63dvh] w-full place-items-center bg-[linear-gradient(180deg,rgba(15,23,42,.55),rgba(2,6,23,.96))] px-8 text-center">
              <span><b className="block text-lg">Carica il tuo video</b><small className="mt-2 block leading-5 text-slate-400">Seleziona una registrazione in cui mostri il cubo mischiato durante l’ispezione.</small><em className="mt-5 inline-flex rounded-xl bg-blue-600 px-4 py-3 text-xs font-black not-italic text-white">Scegli video</em></span>
            </button>
          )}
          <div className="border-t border-white/10 bg-slate-950/95 p-3">
            <div className="mb-2 flex justify-between gap-3 text-[10px] font-black uppercase tracking-wide text-slate-300"><span className="truncate">{status === 'running' ? phaseText : videoFile?.name ?? 'Nessun video'}</span><span>{Math.round(progress * 100)}%</span></div>
            <div className="h-1.5 overflow-hidden rounded-full bg-white/10"><i className="block h-full rounded-full bg-gradient-to-r from-blue-500 to-emerald-400 transition-[width]" style={{ width: `${progress * 100}%` }} /></div>
          </div>
        </section>

        <input ref={inputRef} type="file" accept="video/*,.mov,.mp4,.m4v,.webm" className="hidden" onChange={onFileInput} />
        <div className="mt-3 grid grid-cols-[1fr_auto_auto] gap-2">
          <button type="button" onClick={videoFile ? analyzeVideo : () => inputRef.current?.click()} disabled={status === 'running' || (Boolean(videoFile) && !duration)} className="min-h-12 rounded-[15px] bg-blue-600 px-4 text-sm font-black text-white shadow-[0_12px_30px_rgba(37,99,235,.25)] disabled:opacity-45">{status === 'running' ? 'Analisi…' : status === 'result' ? 'Rianalizza' : videoFile ? 'Analizza video' : 'Scegli video'}</button>
          <button type="button" onClick={() => inputRef.current?.click()} disabled={status === 'running'} className="min-h-12 rounded-[15px] border border-white/10 bg-slate-900/80 px-3 text-xs font-black text-slate-300 disabled:opacity-45">Cambia</button>
          <button type="button" onClick={resetAll} disabled={status === 'running'} aria-label="Azzera analisi" className="min-h-12 rounded-[15px] border border-white/10 bg-slate-900/80 px-4 text-lg font-black text-slate-300 disabled:opacity-45">↺</button>
        </div>

        {videoFile && <p className="mt-2 text-center text-[10px] text-slate-500">{formatSize(videoFile.size)} · {formatTime(duration)}{inspection ? ` · ispezione ${formatTime(inspection.start)}–${formatTime(inspection.end)}` : ''}</p>}

        <div className="mt-3 grid grid-cols-6 gap-1.5" aria-label="Facce rilevate">
          {FACES.map((face) => {
            const detected = observedFaces.has(face);
            return <div key={face} className={`grid justify-items-center gap-1 rounded-xl border px-1 py-2 text-[9px] font-black ${detected ? 'border-emerald-400/30 bg-emerald-500/10 text-emerald-100' : 'border-white/10 bg-slate-900/70 text-slate-600'}`}><i className="h-[19px] w-[19px] rounded-[5px] border-2 border-white/15" style={{ backgroundColor: detected ? COLOR_HEX[CANONICAL_FACE_COLOR[face]] : '#1e293b' }} /><span>{face}</span></div>;
          })}
        </div>

        {reconstruction && (
          <section className="mt-3 rounded-[20px] border border-white/10 bg-slate-900/80 p-3.5">
            <div className="mb-3 flex items-start justify-between gap-3"><div><p className="text-[10px] font-black uppercase tracking-[.14em] text-blue-400">Schema del cubo aperto</p><h3 className="mt-1 text-sm font-black">Bianco sopra · verde davanti</h3></div><span className="rounded-full bg-white/5 px-2.5 py-1 text-[10px] font-black text-slate-300">{knownCells}/48 caselle</span></div>
            <CubeNet facelets={facelets} />
          </section>
        )}

        {transcript && transcript.moveCount > 0 && (
          <section className="mt-3 rounded-[20px] border border-blue-400/20 bg-slate-900/85 p-3.5">
            <div className="flex items-start justify-between gap-3">
              <div><p className="text-[10px] font-black uppercase tracking-[.14em] text-blue-400">Trascrizione della solve</p><h3 className="mt-1 text-sm font-black">Movimenti e fasi rilevate</h3></div>
              <span className="rounded-full bg-blue-500/10 px-2.5 py-1 text-[10px] font-black text-blue-200">Accuratezza {transcript.confidence}%</span>
            </div>
            <p className="mt-2 text-[10px] leading-4 text-slate-500">
              {transcript.runCount > 1 ? `${transcript.runCount} analisi sovrapposte` : 'Prima analisi'} · {transcript.moveCount} mosse nella solve · {transcript.uncertainMoves} a bassa confidenza
            </p>
            <div className="mt-3 grid gap-2">
              {transcript.segments.map((segment, index) => {
                const value = segment.stage === 'scramble' && scramble?.verified
                  ? scramble.scramble
                  : segment.moves.map((move) => move.token).join(' ');
                return (
                  <article key={`${segment.stage}-${index}`} className="rounded-xl border border-white/[.08] bg-slate-950/65 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <strong className="text-[10px] font-black uppercase tracking-[.12em] text-slate-300">{segment.label}</strong>
                      <span className={`text-[9px] font-black ${segment.confidence >= 65 ? 'text-emerald-300' : segment.confidence >= 48 ? 'text-amber-300' : 'text-rose-300'}`}>{segment.confidence || '—'}%</span>
                    </div>
                    <p className={`mt-1.5 break-words font-mono text-xs font-bold leading-5 ${value ? 'text-yellow-100' : 'text-slate-600'}`}>{value || 'Nessun movimento rilevato'}</p>
                  </article>
                );
              })}
            </div>
            {!transcript.usedStateProgress && <p className="mt-2 text-[10px] leading-4 text-amber-300/75">I confini CFOP sono stimati perché le mosse riconosciute non producono ancora abbastanza cambi di stato certi. La rianalisi aggiorna gli stessi punti per migliorare il consenso.</p>}
            <button type="button" onClick={() => copyOutput(transcriptText, 'Trascrizione')} className="mt-3 w-full rounded-xl border border-blue-400/20 bg-blue-500/10 py-2.5 text-xs font-black text-blue-100">{copied ? 'Trascrizione copiata ✓' : 'Copia trascrizione completa'}</button>
          </section>
        )}

        {replay && <VirtualCubeReplay key={replay.signature} replay={replay} />}

        {(solverString || scramble?.verified || solving) && (
          <section className="mt-3 rounded-[18px] border border-emerald-400/25 bg-emerald-500/[.08] p-3.5">
            <p className="text-[10px] font-black uppercase tracking-[.12em] text-emerald-300">Risultato verificato</p>
            {solving ? <p className="mt-2 text-xs text-slate-300">Calcolo dello scramble più corto in corso…</p> : (
              <>
                {scramble?.verified && <div className="mt-2"><span className="text-[10px] font-bold text-slate-400">Scramble</span><p className="mt-1 break-words font-mono text-xs font-bold leading-5 text-yellow-200">{scramble.scramble}</p><button type="button" onClick={() => copyOutput(scramble.scramble, 'Scramble')} className="mt-2 w-full rounded-xl border border-white/10 bg-slate-950/70 py-2.5 text-xs font-black text-slate-200">{copied ? 'Copiato ✓' : 'Copia scramble'}</button></div>}
                {solverString && <div className="mt-3"><span className="text-[10px] font-bold text-slate-400">Stringa Singmaster · URFDLB</span><textarea value={solverString} readOnly spellCheck={false} className="mt-1.5 min-h-20 w-full resize-none rounded-xl border border-white/10 bg-slate-950/75 p-2.5 font-mono text-[11px] font-bold leading-5 text-yellow-200 outline-none" /></div>}
              </>
            )}
          </section>
        )}
      </div>

      <aside role="status" aria-live="polite" className={`fixed bottom-[max(12px,env(safe-area-inset-bottom))] left-1/2 z-20 w-[min(calc(100%-28px),492px)] -translate-x-1/2 rounded-[18px] border p-3.5 shadow-2xl backdrop-blur-xl ${messageTone === 'success' ? 'border-emerald-400/35 bg-slate-950/95' : messageTone === 'error' ? 'border-rose-400/35 bg-slate-950/95' : 'border-blue-400/25 bg-slate-950/95'}`}>
        <strong className={`block text-xs ${messageTone === 'success' ? 'text-emerald-300' : messageTone === 'error' ? 'text-rose-300' : 'text-blue-200'}`}>{messageTone === 'success' ? 'Pronto' : messageTone === 'error' ? 'Attenzione' : 'Cube Scanner'}</strong>
        <span className="mt-1 block text-[11px] leading-4 text-slate-400">{message}</span>
      </aside>
    </main>
  );
}
