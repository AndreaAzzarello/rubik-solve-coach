'use client';

import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from 'react';
import {
  AnalysisResult,
  COLOR_HEX,
  COLOR_LABELS,
  CubeColor,
  CubeState,
  Phase,
  analyzeSolution,
  cfopStatus,
  classifyPhase,
} from '../lib/cube';

const crossColors = Object.keys(COLOR_HEX) as CubeColor[];

const PHASE_LABELS: Record<Phase, string> = {
  cross: 'Cross',
  f2l: 'F2L',
  oll: 'OLL',
  pll: 'PLL',
  complete: 'Completa',
};

const PHASE_STYLES: Record<Phase, string> = {
  cross: 'bg-amber-400 text-amber-950',
  f2l: 'bg-blue-400 text-blue-950',
  oll: 'bg-violet-400 text-violet-950',
  pll: 'bg-emerald-400 text-emerald-950',
  complete: 'bg-white text-slate-950',
};

const SOLVE_PHASES = ['cross', 'f2l', 'oll', 'pll'] as const;

const PHASE_DESCRIPTIONS: Record<(typeof SOLVE_PHASES)[number], string> = {
  cross: 'Costruzione e allineamento della croce.',
  f2l: 'Inserimento delle quattro coppie nei primi due strati.',
  oll: 'Orientamento dell’ultimo strato.',
  pll: 'Permutazione finale dei pezzi.',
};

const PHASE_CARD_STYLES: Record<(typeof SOLVE_PHASES)[number], string> = {
  cross: 'border-amber-200 bg-amber-50/70 text-amber-950',
  f2l: 'border-blue-200 bg-blue-50/70 text-blue-950',
  oll: 'border-violet-200 bg-violet-50/70 text-violet-950',
  pll: 'border-emerald-200 bg-emerald-50/70 text-emerald-950',
};

function formatFileSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes > 100 * 1024 * 1024 ? 0 : 1)} MB`;
}

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds)) return 'Durata non disponibile';
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}

function emptyAnalysis(): AnalysisResult {
  return {
    moves: [],
    scramble: '',
    states: [CubeState.solved()],
    steps: [],
    finalSolved: false,
  };
}

function inferCross(algorithm: string) {
  const candidates = crossColors.map((color) => {
    const candidateAnalysis = analyzeSolution(algorithm, color);
    const statuses = candidateAnalysis.states.map((state) => cfopStatus(state, color));
    const totalMoves = Math.max(1, candidateAnalysis.moves.length);
    const firstCross = statuses.findIndex((status) => status.crossSolved);
    const firstF2l = statuses.findIndex((status) => status.f2lSolved);
    const firstOll = statuses.findIndex((status) => status.f2lSolved && status.ollSolved);
    const ranks = candidateAnalysis.states.map((state) => {
      const phase = classifyPhase(state, color);
      return phase === 'cross' ? 0 : phase === 'f2l' ? 1 : phase === 'oll' ? 2 : phase === 'pll' ? 3 : 4;
    });
    const regressions = ranks.slice(1).reduce((total, rank, index) => total + Math.max(0, ranks[index] - rank), 0);

    let score = 0;
    if (firstCross >= 0) score += 34 - (firstCross / totalMoves) * 18;
    if (firstF2l >= firstCross && firstF2l >= 0) score += 24 - (firstF2l / totalMoves) * 8;
    if (firstOll >= firstF2l && firstOll >= 0) score += 18;
    if (firstCross >= 0 && firstCross <= Math.ceil(totalMoves * 0.4)) score += 12;
    score -= regressions * 14;

    return { color, analysis: candidateAnalysis, score };
  }).sort((left, right) => right.score - left.score);

  const best = candidates[0];
  const gap = Math.max(0, best.score - (candidates[1]?.score ?? best.score));
  const confidence = Math.round(Math.min(96, Math.max(50, 54 + gap * 3)));
  return { ...best, confidence };
}

function CubeFace({ colors }: { colors: CubeColor[] }) {
  return (
    <div className="cube-face" aria-hidden="true">
      {colors.map((color, index) => (
        <span
          key={`${color}-${index}`}
          style={{ backgroundColor: COLOR_HEX[color] }}
        />
      ))}
    </div>
  );
}

function CubeVisual({ state, crossColor }: { state: CubeState; crossColor: CubeColor }) {
  const frontColor = state.facelets('F')[4];

  return (
    <div
      className="cube-stage"
      role="img"
      aria-label={`Cubo 3D con Cross ${COLOR_LABELS[crossColor]} sotto e centro ${COLOR_LABELS[frontColor]} davanti`}
    >
      <div className="cube-float">
        <div className="cube-model">
          <div className="cube-side cube-side-top"><CubeFace colors={state.facelets('U')} /></div>
          <div className="cube-side cube-side-front"><CubeFace colors={state.facelets('F')} /></div>
          <div className="cube-side cube-side-right"><CubeFace colors={state.facelets('R')} /></div>
        </div>
      </div>
      <div className="cube-caption" aria-hidden="true">
        <span>↓ {COLOR_LABELS[crossColor]}</span>
        <span>Fronte · {COLOR_LABELS[frontColor]}</span>
      </div>
    </div>
  );
}

function completionLabel(done: boolean, available: boolean) {
  if (done) return 'Completata';
  return available ? 'In lavorazione' : 'Non raggiunta';
}

export default function Home() {
  const [solution, setSolution] = useState('');
  const [crossColor, setCrossColor] = useState<CubeColor>('yellow');
  const [crossConfidence, setCrossConfidence] = useState(0);
  const [analysis, setAnalysis] = useState<AnalysisResult>(emptyAnalysis);
  const [hasAnalysis, setHasAnalysis] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState('');
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState('');
  const [videoError, setVideoError] = useState('');
  const [videoMeta, setVideoMeta] = useState({ duration: 0, width: 0, height: 0 });
  const [copied, setCopied] = useState(false);

  const currentState = analysis.states[stepIndex] ?? analysis.states[0];
  const currentPhase = classifyPhase(currentState, crossColor);
  const currentStatus = cfopStatus(currentState, crossColor);

  const rotations = useMemo(
    () => analysis.moves.filter((move) => ['x', 'y', 'z'].includes(move.base)).length,
    [analysis],
  );
  const wideAndSlice = useMemo(
    () => analysis.moves.filter((move) => move.base.endsWith('w') || ['M', 'E', 'S'].includes(move.base)).length,
    [analysis],
  );

  const phaseGroups = useMemo(() => {
    const groups: Record<(typeof SOLVE_PHASES)[number], string[]> = {
      cross: [],
      f2l: [],
      oll: [],
      pll: [],
    };

    analysis.steps.forEach((step) => {
      const phase = step.phaseBefore === 'complete' ? 'pll' : step.phaseBefore;
      groups[phase].push(step.move.token);
    });
    return groups;
  }, [analysis]);

  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
  }, [videoUrl]);

  useEffect(() => {
    if (!playing) return;
    if (stepIndex >= analysis.moves.length) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setStepIndex((current) => Math.min(current + 1, analysis.moves.length));
    }, 720);
    return () => window.clearTimeout(timer);
  }, [analysis.moves.length, playing, stepIndex]);

  function runAnalysis() {
    try {
      const inferred = inferCross(solution);
      setCrossColor(inferred.color);
      setCrossConfidence(inferred.confidence);
      setAnalysis(inferred.analysis);
      setHasAnalysis(true);
      setStepIndex(0);
      setPlaying(false);
      setError('');
      setCopied(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Impossibile analizzare la sequenza');
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!solution.trim()) {
      setHasAnalysis(false);
      setError(videoFile
        ? 'Il video è stato caricato, ma il decoder automatico delle mosse non è ancora collegato. Nessuna sequenza di esempio verrà usata: inserisci una trascrizione verificata oppure ricarica il filmato nella chat per sviluppare il riconoscimento.'
        : 'Carica un video oppure inserisci una sequenza di mosse da analizzare.');
      return;
    }
    runAnalysis();
  }

  function chooseVideo(file: File | null) {
    if (!file) return;
    const isVideo = file.type.startsWith('video/') || /\.(mov|mp4|m4v|webm)$/i.test(file.name);
    if (!isVideo) {
      setVideoError('Scegli un file video MOV, MP4, M4V o WebM.');
      return;
    }

    setVideoFile(file);
    setVideoUrl(URL.createObjectURL(file));
    setVideoMeta({ duration: 0, width: 0, height: 0 });
    setVideoError('');
    setSolution('');
    setAnalysis(emptyAnalysis());
    setHasAnalysis(false);
    setStepIndex(0);
    setPlaying(false);
    setError('');
  }

  function onVideoInput(event: ChangeEvent<HTMLInputElement>) {
    chooseVideo(event.target.files?.[0] ?? null);
  }

  async function copyScramble() {
    try {
      await navigator.clipboard.writeText(analysis.scramble);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  const positionLabel = stepIndex === 0
    ? 'Stato iniziale'
    : `Mossa ${stepIndex} di ${analysis.moves.length}`;

  const observation = rotations > 0
    ? `${rotations} rotazion${rotations === 1 ? 'e' : 'i'} completa${rotations === 1 ? '' : 'e'} rilevata${rotations === 1 ? '' : 'e'}: in futuro confronteremo alternative con meno regrip.`
    : wideAndSlice > 0
      ? `La solve contiene ${wideAndSlice} wide o slice move, tutte conservate nel replay fedele.`
      : 'Nessuna rotazione completa rilevata nella sequenza: una buona base per confrontare l’efficienza.';

  return (
    <main className="min-h-screen px-4 py-5 text-slate-950 sm:px-8 lg:px-12">
      <div className="mx-auto max-w-[1420px]">
        <header className="flex items-center justify-between border-b border-slate-200/80 pb-5">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 grid-cols-2 gap-1 rounded-xl bg-slate-950 p-2 shadow-lg shadow-slate-950/10">
              <span className="rounded-sm bg-yellow-400" />
              <span className="rounded-sm bg-red-500" />
              <span className="rounded-sm bg-green-500" />
              <span className="rounded-sm bg-blue-500" />
            </div>
            <div>
              <p className="text-sm font-black tracking-[-0.02em]">CubeSolve Coach</p>
              <p className="text-xs text-slate-500">Laboratorio di analisi 3×3</p>
            </div>
          </div>
          <span className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-bold text-emerald-700">
            MVP web · live
          </span>
        </header>

        <div className="grid gap-8 py-10 lg:grid-cols-[minmax(0,0.84fr)_minmax(560px,1.16fr)] lg:items-start lg:gap-12 lg:py-14">
          <section>
            <p className="mb-4 text-xs font-black uppercase tracking-[0.2em] text-blue-600">
              Dal video alla strategia
            </p>
            <h1 className="max-w-2xl text-4xl font-black leading-[0.98] tracking-[-0.055em] sm:text-6xl">
              Guarda la tua solve con occhi nuovi.
            </h1>
            <p className="mt-5 max-w-xl text-base leading-7 text-slate-600 sm:text-lg">
              Carica il filmato, verifica le mosse e ripercorri la risoluzione uno stato alla volta.
            </p>

            <form
              onSubmit={submit}
              className="mt-9 rounded-[28px] border border-slate-200 bg-white p-5 shadow-[0_24px_70px_-34px_rgba(15,23,42,0.35)] sm:p-7"
            >
              <div className="mb-7">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-[11px] font-black uppercase tracking-[0.16em] text-blue-600">1 · Video</p>
                    <h2 className="mt-1 text-sm font-extrabold">Registrazione della solve</h2>
                  </div>
                  <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-[10px] font-black uppercase tracking-wide text-emerald-700">
                    Sul dispositivo
                  </span>
                </div>

                {videoUrl ? (
                  <div className="mt-3 overflow-hidden rounded-2xl border border-slate-200 bg-slate-950">
                    <video
                      key={videoUrl}
                      src={videoUrl}
                      controls
                      playsInline
                      preload="metadata"
                      className="aspect-video w-full bg-black object-contain"
                      onLoadedMetadata={(event) => {
                        const video = event.currentTarget;
                        setVideoMeta({
                          duration: video.duration,
                          width: video.videoWidth,
                          height: video.videoHeight,
                        });
                      }}
                    >
                      Il browser non riesce a riprodurre questo formato video.
                    </video>
                    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-xs text-slate-300">
                      <div className="min-w-0">
                        <p className="truncate font-bold text-white">{videoFile?.name}</p>
                        <p className="mt-0.5 text-slate-500">
                          {videoFile ? formatFileSize(videoFile.size) : ''}
                          {videoMeta.width > 0 ? ` · ${videoMeta.width}×${videoMeta.height} · ${formatDuration(videoMeta.duration)}` : ''}
                        </p>
                      </div>
                      <label htmlFor="video-upload" className="cursor-pointer rounded-lg border border-white/15 px-3 py-2 font-bold transition hover:bg-white/10">
                        Sostituisci
                      </label>
                    </div>
                  </div>
                ) : (
                  <label
                    htmlFor="video-upload"
                    className="mt-3 flex min-h-32 cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-blue-200 bg-blue-50/60 px-5 py-6 text-center transition hover:border-blue-400 hover:bg-blue-50"
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      chooseVideo(event.dataTransfer.files?.[0] ?? null);
                    }}
                  >
                    <span className="grid h-10 w-10 place-items-center rounded-xl bg-blue-600 text-xl text-white shadow-lg shadow-blue-600/20">↑</span>
                    <span className="mt-3 text-sm font-black text-slate-950">Carica o trascina il video</span>
                    <span className="mt-1 text-xs text-slate-500">MOV, MP4, M4V o WebM · il file non viene salvato online</span>
                  </label>
                )}
                <input id="video-upload" type="file" accept="video/*,.mov,.m4v" onChange={onVideoInput} className="sr-only" />
                {videoError ? <p className="mt-2 text-xs font-bold text-red-600">{videoError}</p> : null}
                <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-950">
                  <strong>Cross automatica:</strong> non devi più scegliere un colore. Viene dedotto dalla progressione della solve e accompagnato da un livello di affidabilità.
                </div>
              </div>

              <div className="mb-3 border-t border-slate-100 pt-6">
                <p className="text-[11px] font-black uppercase tracking-[0.16em] text-blue-600">2 · Verifica</p>
              </div>
              <div className="flex items-center justify-between gap-4">
                <label htmlFor="moves" className="text-sm font-extrabold">
                  Sequenza rilevata o trascritta
                </label>
                <span className="font-mono text-xs text-slate-400">
                  {analysis.moves.length} mosse analizzate
                </span>
              </div>
              <textarea
                id="moves"
                className="mt-3 min-h-28 w-full resize-y rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 font-mono text-lg font-semibold tracking-wide outline-none transition focus:border-blue-500 focus:bg-white focus:ring-4 focus:ring-blue-500/10"
                value={solution}
                onChange={(event) => setSolution(event.target.value)}
                spellCheck={false}
                aria-describedby={error ? 'move-error' : 'move-help'}
              />
              {error ? (
                <p id="move-error" role="alert" className="mt-2 rounded-xl bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">
                  {error}
                </p>
              ) : (
                <p id="move-help" className="mt-2 text-xs leading-5 text-slate-400">
                  Supporta mosse standard, prime, doppie, wide, M/E/S e rotazioni x/y/z.
                </p>
              )}

              <div className="mt-6 flex items-center justify-between gap-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                <div>
                  <p className="text-xs font-black text-slate-950">Cross rilevata automaticamente</p>
                  <p className="mt-1 text-[11px] leading-4 text-slate-500">
                    {hasAnalysis
                      ? `Centro ${COLOR_LABELS[crossColor]} · affidabilità ${crossConfidence}%`
                      : 'Comparirà dopo una sequenza riconosciuta o confermata.'}
                  </p>
                </div>
                <span
                  className="h-9 w-9 shrink-0 rounded-xl border border-slate-300 shadow-sm"
                  style={{ backgroundColor: hasAnalysis ? COLOR_HEX[crossColor] : '#e2e8f0' }}
                  aria-hidden="true"
                />
              </div>

              <button
                type="submit"
                className="mt-7 w-full rounded-2xl bg-blue-600 px-5 py-4 text-sm font-black text-white shadow-lg shadow-blue-600/20 transition hover:bg-blue-700 focus:outline-none focus:ring-4 focus:ring-blue-500/20"
              >
                {videoFile && !solution.trim() ? 'Avvia analisi video' : 'Analizza la soluzione'}
              </button>
            </form>

            <div className="mt-5 rounded-2xl border border-blue-100 bg-blue-50/75 p-4">
              <p className="text-xs font-black uppercase tracking-[0.14em] text-blue-700">Prima osservazione</p>
              <p className="mt-2 text-sm leading-6 text-blue-950">{observation}</p>
            </div>
          </section>

          <section className="overflow-hidden rounded-[32px] border border-slate-800 bg-slate-950 text-white shadow-[0_35px_90px_-38px_rgba(15,23,42,0.8)]">
            {hasAnalysis ? (
              <>
            <div className="grid min-h-[390px] gap-2 border-b border-white/10 bg-[radial-gradient(circle_at_55%_18%,#29458d_0%,#10172d_42%,#080c18_76%)] p-6 sm:grid-cols-[1fr_250px] sm:p-8">
              <div className="flex flex-col">
                <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-300">Replay virtuale</p>
                <h2 className="mt-2 text-2xl font-black tracking-tight">{positionLabel}</h2>
                <p className="mt-2 text-sm text-slate-400">
                  Stato: <span className="font-bold text-white">{PHASE_LABELS[currentPhase]}</span>
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  Cross dedotta: <span className="font-bold text-slate-300">{COLOR_LABELS[crossColor]}</span> · affidabilità {crossConfidence}%
                </p>

                <div className="mt-6 flex max-w-[340px] flex-wrap gap-2 font-mono text-sm text-slate-500">
                  {analysis.moves.map((move, index) => (
                    <button
                      key={`${move.token}-${index}`}
                      type="button"
                      onClick={() => {
                        setPlaying(false);
                        setStepIndex(index + 1);
                      }}
                      className={`rounded-lg px-2.5 py-1.5 font-black transition ${
                        index + 1 === stepIndex
                          ? 'bg-white text-slate-950'
                          : index + 1 < stepIndex
                            ? 'bg-white/10 text-slate-200 hover:bg-white/15'
                            : 'hover:bg-white/5 hover:text-slate-300'
                      }`}
                    >
                      {move.token}
                    </button>
                  ))}
                </div>

                <div className="mt-auto pt-6">
                  <input
                    type="range"
                    min={0}
                    max={analysis.moves.length}
                    value={stepIndex}
                    onChange={(event) => {
                      setPlaying(false);
                      setStepIndex(Number(event.target.value));
                    }}
                    className="h-1.5 w-full cursor-pointer accent-blue-400"
                    aria-label="Posizione del replay"
                  />
                  <div className="mt-4 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => { setPlaying(false); setStepIndex(0); }}
                      className="replay-button"
                      aria-label="Torna all’inizio"
                    >
                      ↺
                    </button>
                    <button
                      type="button"
                      onClick={() => { setPlaying(false); setStepIndex((value) => Math.max(0, value - 1)); }}
                      className="replay-button"
                      aria-label="Mossa precedente"
                    >
                      ◀
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (stepIndex >= analysis.moves.length) setStepIndex(0);
                        setPlaying((value) => !value);
                      }}
                      className="replay-button replay-button-primary"
                      aria-label={playing ? 'Pausa' : 'Riproduci'}
                    >
                      {playing ? 'Ⅱ' : '▶'}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setPlaying(false); setStepIndex((value) => Math.min(analysis.moves.length, value + 1)); }}
                      className="replay-button"
                      aria-label="Mossa successiva"
                    >
                      ▶
                    </button>
                  </div>
                </div>
              </div>

              <CubeVisual state={currentState} crossColor={crossColor} />
            </div>

            <div className="grid gap-6 p-6 sm:grid-cols-[0.9fr_1.2fr] sm:p-8">
              <div className="space-y-3">
                <div className="rounded-2xl bg-white/5 p-4">
                  <div className="flex items-end justify-between gap-3">
                    <div>
                      <p className="text-xs font-bold text-slate-400">Mosse</p>
                      <p className="mt-1 text-3xl font-black">{analysis.moves.length}</p>
                    </div>
                    <span className="text-xs font-bold text-slate-500">Passo {stepIndex}</span>
                  </div>
                </div>
                <div className="rounded-2xl bg-white/5 p-4">
                  <p className="text-xs font-bold text-slate-400">Scramble ricostruito</p>
                  <p className="mt-2 break-words font-mono text-sm font-bold leading-6 text-yellow-300">
                    {analysis.scramble}
                  </p>
                  <p className="mt-2 text-[11px] leading-4 text-slate-500">Inverso esatto della sequenza inserita.</p>
                </div>
              </div>

              <div>
                <div className="mb-4 flex items-center justify-between gap-3">
                  <h3 className="text-sm font-black">Stato CFOP attuale</h3>
                  <span className={`rounded-full px-2.5 py-1 text-[11px] font-black ${PHASE_STYLES[currentPhase]}`}>
                    {PHASE_LABELS[currentPhase]}
                  </span>
                </div>
                <div className="space-y-3">
                  {[
                    ['Cross', completionLabel(currentStatus.crossSolved, true), currentStatus.crossSolved, 'bg-amber-400'],
                    ['F2L', completionLabel(currentStatus.f2lSolved, currentStatus.crossSolved), currentStatus.f2lSolved, 'bg-blue-400'],
                    ['OLL', completionLabel(currentStatus.ollSolved, currentStatus.f2lSolved), currentStatus.ollSolved, 'bg-violet-400'],
                    ['PLL', currentStatus.cubeSolved ? 'Completata' : currentStatus.f2lSolved && currentStatus.ollSolved ? 'In lavorazione' : 'Non raggiunta', currentStatus.cubeSolved, 'bg-emerald-400'],
                  ].map(([phase, value, done, color]) => (
                    <div key={String(phase)} className="flex items-center gap-3">
                      <span className={`h-2.5 w-2.5 rounded-full ${color} ${done ? '' : 'opacity-30'}`} />
                      <span className="w-12 text-xs font-black">{String(phase)}</span>
                      <span className="h-px flex-1 bg-white/10" />
                      <span className={`text-xs ${done ? 'text-slate-200' : 'text-slate-500'}`}>{String(value)}</span>
                    </div>
                  ))}
                </div>

                <div className="mt-6 border-t border-white/10 pt-5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-500">Verifica finale</span>
                    <span className={analysis.finalSolved ? 'font-bold text-emerald-300' : 'font-bold text-red-300'}>
                      {analysis.finalSolved ? 'Cubo risolto ✓' : 'Sequenza incompleta'}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <div className="border-t border-white/10 bg-black/10 px-6 py-5 sm:px-8">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-xs font-black uppercase tracking-[0.14em] text-slate-400">Timeline delle mosse</h3>
                <span className="text-[11px] text-slate-600">Tocca una mossa per ispezionarla</span>
              </div>
              <div className="flex gap-2 overflow-x-auto pb-2">
                {analysis.steps.map((step) => (
                  <button
                    key={step.index}
                    type="button"
                    onClick={() => { setPlaying(false); setStepIndex(step.index); }}
                    className={`min-w-[82px] rounded-xl border px-3 py-3 text-left transition ${
                      step.index === stepIndex
                        ? 'border-blue-300 bg-blue-400/15'
                        : 'border-white/10 bg-white/[0.03] hover:bg-white/[0.07]'
                    }`}
                  >
                    <span className="block font-mono text-sm font-black">{step.move.token}</span>
                    <span className="mt-1 block text-[10px] font-bold uppercase tracking-wide text-slate-500">
                      {PHASE_LABELS[step.phaseAfter]}
                    </span>
                  </button>
                ))}
              </div>
            </div>
              </>
            ) : (
              <div className="grid min-h-[620px] place-items-center bg-[radial-gradient(circle_at_50%_20%,#29458d_0%,#10172d_40%,#080c18_76%)] p-8 text-center">
                <div className="max-w-md">
                  <div className="mx-auto grid h-16 w-16 place-items-center rounded-2xl border border-blue-300/20 bg-blue-400/10 text-3xl text-blue-300">▶</div>
                  <p className="mt-6 text-xs font-black uppercase tracking-[0.18em] text-blue-300">In attesa dell’analisi</p>
                  <h2 className="mt-3 text-3xl font-black tracking-tight">
                    {videoFile ? 'Video pronto.' : 'Carica la tua solve.'}
                  </h2>
                  <p className="mt-3 text-sm leading-6 text-slate-400">
                    {videoFile
                      ? 'Premi “Avvia analisi video”. Qui compariranno soltanto le mosse realmente riconosciute o confermate, senza sequenze dimostrative.'
                      : 'Seleziona un filmato per iniziare. Replay, Cross dedotta, scramble e fasi resteranno vuoti finché non esiste un risultato attendibile.'}
                  </p>
                  {videoFile ? <p className="mt-5 truncate rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-xs font-bold text-slate-300">{videoFile.name}</p> : null}
                </div>
              </div>
            )}
          </section>
        </div>

        {hasAnalysis ? (
          <section className="mb-16 overflow-hidden rounded-[30px] border border-slate-200 bg-white shadow-[0_24px_70px_-40px_rgba(15,23,42,0.35)]">
          <div className="grid gap-5 border-b border-slate-100 bg-slate-50/70 p-6 sm:grid-cols-[1fr_auto] sm:items-center sm:p-8">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.18em] text-blue-600">Risultato verificato</p>
              <h2 className="mt-2 text-2xl font-black tracking-tight sm:text-3xl">Come è stato risolto il cubo</h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">
                Le mosse sono raggruppate automaticamente in base allo stato reale dei pezzi dopo ogni passaggio.
              </p>
            </div>
            <div className="min-w-0 rounded-2xl bg-slate-950 p-4 text-white sm:min-w-[330px]">
              <div className="flex items-center justify-between gap-3">
                <p className="text-[11px] font-black uppercase tracking-[0.14em] text-yellow-300">Scramble da riprovare</p>
                <button
                  type="button"
                  onClick={copyScramble}
                  className="rounded-lg border border-white/15 px-2.5 py-1 text-[10px] font-black uppercase tracking-wide text-slate-300 transition hover:bg-white/10 hover:text-white"
                >
                  {copied ? 'Copiato ✓' : 'Copia'}
                </button>
              </div>
              <p className="mt-3 break-words font-mono text-sm font-black leading-6 text-yellow-300">{analysis.scramble}</p>
              <p className="mt-2 text-[11px] leading-4 text-slate-500">Ricrea esattamente lo stato iniziale dedotto dalla sequenza confermata.</p>
            </div>
          </div>

          <div className="grid gap-4 p-6 sm:grid-cols-2 sm:p-8 xl:grid-cols-4">
            {SOLVE_PHASES.map((phase, index) => {
              const moves = phaseGroups[phase];
              return (
                <article key={phase} className={`rounded-2xl border p-5 ${PHASE_CARD_STYLES[phase]}`}>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[11px] font-black uppercase tracking-[0.15em] opacity-60">Fase {index + 1}</span>
                    <span className="rounded-full bg-white/70 px-2 py-1 text-[10px] font-black">{moves.length} mosse</span>
                  </div>
                  <h3 className="mt-3 text-xl font-black">{PHASE_LABELS[phase]}</h3>
                  <p className="mt-1 min-h-10 text-xs leading-5 opacity-70">{PHASE_DESCRIPTIONS[phase]}</p>
                  <p className="mt-4 min-h-12 break-words font-mono text-sm font-black leading-6">
                    {moves.length ? moves.join(' ') : '—'}
                  </p>
                  {!moves.length ? <p className="mt-1 text-[10px] font-bold uppercase tracking-wide opacity-50">Nessuna mossa assegnata</p> : null}
                </article>
              );
            })}
          </div>
          </section>
        ) : null}
      </div>
    </main>
  );
}
