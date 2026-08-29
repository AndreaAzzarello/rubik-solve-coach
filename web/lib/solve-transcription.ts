import {
  CubeState,
  cfopProgress,
  invertMoves,
  parseAlgorithm,
  type CubeColor,
  type Face,
} from './cube.ts';
import type { MotionEvent, SolveWindow } from './video-decoder.ts';

export type TranscribedMove = {
  token: string;
  time: number;
  confidence: number;
  runSupport: number;
  kind: 'face-turn' | 'global-motion';
  alternatives: string[];
};

export type TranscriptStage =
  | 'scramble' | 'inspection' | 'cross' | 'xxcross'
  | 'f2l-1' | 'f2l-2' | 'f2l-3' | 'f2l-4' | 'oll' | 'pll';

export type TranscriptSegment = {
  stage: TranscriptStage;
  label: string;
  moves: TranscribedMove[];
  confidence: number;
  inferredBoundary: boolean;
};

export type SolveTranscript = {
  segments: TranscriptSegment[];
  consensusMoves: TranscribedMove[];
  moveCount: number;
  confidence: number;
  uncertainMoves: number;
  runCount: number;
  usedStateProgress: boolean;
};

type Observation = {
  run: number;
  time: number;
  token: string;
  confidence: number;
  kind: 'face-turn' | 'global-motion';
  alternatives: string[];
};

const STAGE_LABEL: Record<TranscriptStage, string> = {
  scramble: 'Scramble', inspection: 'Inspection', cross: 'Cross', xxcross: 'XXCross',
  'f2l-1': '1st F2L', 'f2l-2': '2nd F2L', 'f2l-3': '3rd F2L', 'f2l-4': '4th F2L',
  oll: 'OLL', pll: 'PLL',
};

function validToken(token: string) {
  try {
    return parseAlgorithm(token).length === 1;
  } catch {
    return false;
  }
}

function expandRuns(runs: MotionEvent[][]): Observation[] {
  return runs.flatMap((events, run) => events.flatMap((event) => {
    const tokens = (event.candidateMoves.length ? event.candidateMoves : event.candidateMove.split(/\s+/))
      .filter(validToken);
    return tokens.map((token, index) => ({
      run,
      time: event.start + (event.end - event.start) * ((index + 0.5) / Math.max(1, tokens.length)),
      token,
      confidence: Math.round((event.candidateConfidence * 0.62 + event.confidence * 0.38)
        * (event.evidence === 'combined' ? 1.08 : event.evidence === 'hands' ? 0.93 : 1)),
      kind: event.motionKind,
      alternatives: event.candidateAlternatives.filter(validToken),
    }));
  }));
}

/**
 * Sovrappone più analisi dello stesso video usando il tempo come ancoraggio.
 * Ogni passaggio può votare una sola volta nello stesso cluster, così una
 * raffica letta due volte non pesa più di due letture indipendenti.
 */
export function mergeMotionEventRuns(runs: MotionEvent[][]): TranscribedMove[] {
  const observations = expandRuns(runs).sort((left, right) => left.time - right.time);
  const clusters: Observation[][] = [];
  observations.forEach((observation) => {
    let best: Observation[] | null = null;
    let bestDistance = 0.24;
    clusters.forEach((cluster) => {
      if (cluster.some((candidate) => candidate.run === observation.run)) return;
      const center = cluster.reduce((total, candidate) => total + candidate.time, 0) / cluster.length;
      const distance = Math.abs(center - observation.time);
      if (distance <= bestDistance) {
        best = cluster;
        bestDistance = distance;
      }
    });
    if (best) best.push(observation);
    else clusters.push([observation]);
  });

  return clusters.map((cluster) => {
    const votes = new Map<string, number>();
    cluster.forEach((observation) => {
      votes.set(observation.token, (votes.get(observation.token) ?? 0) + observation.confidence);
      observation.alternatives.forEach((alternative) => {
        votes.set(alternative, (votes.get(alternative) ?? 0) + observation.confidence * 0.16);
      });
    });
    const ranked = [...votes.entries()].sort((left, right) => right[1] - left[1]);
    const token = ranked[0]?.[0] ?? cluster[0].token;
    const primaryVotes = cluster.filter((observation) => observation.token === token);
    const totalWeight = ranked.reduce((total, [, weight]) => total + weight, 0);
    const agreement = (ranked[0]?.[1] ?? 0) / Math.max(1, totalWeight);
    const runSupport = new Set(cluster.map((observation) => observation.run)).size;
    const baseConfidence = primaryVotes.length
      ? primaryVotes.reduce((total, observation) => total + observation.confidence, 0) / primaryVotes.length
      : cluster.reduce((total, observation) => total + observation.confidence, 0) / cluster.length;
    const kinds = cluster.filter((observation) => observation.token === token).map((observation) => observation.kind);
    return {
      token,
      time: cluster.reduce((total, observation) => total + observation.time, 0) / cluster.length,
      confidence: Math.round(Math.min(96, Math.max(24, baseConfidence * 0.72 + agreement * 24 + Math.min(8, runSupport * 2)))),
      runSupport,
      kind: kinds.filter((kind) => kind === 'global-motion').length > kinds.length / 2
        ? 'global-motion' as const
        : 'face-turn' as const,
      alternatives: ranked.slice(1, 4).map(([alternative]) => alternative),
    };
  }).sort((left, right) => left.time - right.time);
}

function meanConfidence(moves: TranscribedMove[], penalty = 0) {
  if (!moves.length) return 0;
  return Math.max(18, Math.round(
    moves.reduce((total, move) => total + move.confidence, 0) / moves.length - penalty,
  ));
}

function stageForProgress(progress: ReturnType<typeof cfopProgress>): TranscriptStage {
  if (!progress.crossSolved) return 'cross';
  if (!progress.f2lSolved) {
    return (`f2l-${Math.min(4, progress.f2lPairsSolved + 1)}`) as TranscriptStage;
  }
  if (!progress.ollSolved) return 'oll';
  return 'pll';
}

function fallbackStage(index: number, total: number): TranscriptStage {
  const ratio = index / Math.max(1, total);
  if (ratio < 0.13) return 'cross';
  if (ratio < 0.26) return 'f2l-1';
  if (ratio < 0.39) return 'f2l-2';
  if (ratio < 0.52) return 'f2l-3';
  if (ratio < 0.66) return 'f2l-4';
  if (ratio < 0.82) return 'oll';
  return 'pll';
}

function groupSolveMoves(
  moves: TranscribedMove[],
  initialFacelets: Record<Face, CubeColor[]> | null,
  crossColor: CubeColor,
) {
  if (!moves.length) return { segments: [] as TranscriptSegment[], usedStateProgress: false };
  const parsed = moves.map((move) => parseAlgorithm(move.token)[0]);
  const cube = initialFacelets
    ? CubeState.fromFacelets(initialFacelets)
    : CubeState.solved().applyMoves(invertMoves(parsed));
  const labels: TranscriptStage[] = [];
  const progressAfter = [] as Array<ReturnType<typeof cfopProgress>>;
  moves.forEach((move, index) => {
    labels.push(stageForProgress(cfopProgress(cube, crossColor)));
    cube.applyMove(parsed[index]);
    progressAfter.push(cfopProgress(cube, crossColor));
  });

  const crossCompletion = progressAfter.findIndex((progress) => progress.crossSolved);
  const physicallyUseful = crossCompletion >= 0
    || progressAfter.some((progress) => progress.f2lPairsSolved > 0 || progress.f2lSolved || progress.ollSolved);
  if (!physicallyUseful) labels.forEach((_, index) => { labels[index] = fallbackStage(index, labels.length); });

  if (crossCompletion >= 0 && progressAfter[crossCompletion].f2lPairsSolved >= 2
    && crossCompletion <= Math.max(4, Math.floor(moves.length * 0.46))) {
    for (let index = 0; index <= crossCompletion; index += 1) labels[index] = 'xxcross';
  }

  const segments: TranscriptSegment[] = [];
  moves.forEach((move, index) => {
    const stage = labels[index];
    const current = segments.at(-1);
    if (current?.stage === stage) current.moves.push(move);
    else segments.push({ stage, label: STAGE_LABEL[stage], moves: [move], confidence: 0, inferredBoundary: !physicallyUseful });
  });
  segments.forEach((segment) => {
    segment.confidence = meanConfidence(segment.moves, segment.inferredBoundary ? 16 : 0);
  });
  return { segments, usedStateProgress: physicallyUseful };
}

export function buildSolveTranscript(
  runs: MotionEvent[][],
  solveWindow: SolveWindow | null,
  initialFacelets: Record<Face, CubeColor[]> | null,
  crossColor: CubeColor,
): SolveTranscript {
  const consensusMoves = mergeMotionEventRuns(runs);
  const stage = (kind: 'scramble' | 'inspection' | 'solve') => solveWindow?.stages.find((candidate) => candidate.kind === kind);
  const solveStage = stage('solve');
  const solveStart = solveStage?.start ?? solveWindow?.start ?? consensusMoves[0]?.time ?? 0;
  const solveEnd = solveStage?.end ?? solveWindow?.end ?? consensusMoves.at(-1)?.time ?? solveStart;
  const inRange = (move: TranscribedMove, start: number, end: number) => move.time >= start - 0.18 && move.time <= end + 0.18;
  const scrambleStage = stage('scramble');
  const inspectionStage = stage('inspection');
  const scrambleMoves = scrambleStage
    ? consensusMoves.filter((move) => inRange(move, scrambleStage.start, scrambleStage.end) && move.kind === 'face-turn')
    : [];
  const inspectionMoves = inspectionStage
    ? consensusMoves.filter((move) => inRange(move, inspectionStage.start, inspectionStage.end) && move.kind === 'global-motion')
    : consensusMoves.filter((move) => move.time < solveStart && move.kind === 'global-motion');
  const solveMoves = consensusMoves.filter((move) => inRange(move, solveStart, solveEnd));
  const grouped = groupSolveMoves(solveMoves, initialFacelets, crossColor);
  const prefix: TranscriptSegment[] = [
    { stage: 'scramble', label: STAGE_LABEL.scramble, moves: scrambleMoves, confidence: meanConfidence(scrambleMoves), inferredBoundary: false },
    { stage: 'inspection', label: STAGE_LABEL.inspection, moves: inspectionMoves, confidence: meanConfidence(inspectionMoves), inferredBoundary: false },
  ];
  const allMoves = [...scrambleMoves, ...inspectionMoves, ...solveMoves];
  return {
    segments: [...prefix, ...grouped.segments],
    consensusMoves,
    moveCount: solveMoves.length,
    confidence: meanConfidence(allMoves),
    uncertainMoves: allMoves.filter((move) => move.confidence < 55).length,
    runCount: runs.length,
    usedStateProgress: grouped.usedStateProgress,
  };
}

export function formatTranscript(transcript: SolveTranscript, verifiedScramble = '') {
  return transcript.segments.map((segment) => {
    const moves = segment.stage === 'scramble' && verifiedScramble
      ? verifiedScramble
      : segment.moves.map((move) => move.token).join(' ');
    return `${moves || '—'} //${segment.label}`;
  }).join('\n');
}
