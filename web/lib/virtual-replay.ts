import {
  CUBE_FACES,
  CubeState,
  invertMoves,
  parseAlgorithm,
  type CubeColor,
  type Face,
} from './cube.ts';
import type { SolveTranscript, TranscriptStage } from './solve-transcription.ts';

export type VirtualReplayMove = {
  token: string;
  stage: TranscriptStage;
  label: string;
  confidence: number;
  time: number;
};

export type VirtualReplay = {
  moves: VirtualReplayMove[];
  frames: Array<Record<Face, CubeColor[]>>;
  derivedInitialState: boolean;
  finalSolved: boolean;
  signature: string;
};

function completeFacelets(facelets: Record<Face, CubeColor[]> | null): facelets is Record<Face, CubeColor[]> {
  return Boolean(facelets && CUBE_FACES.every((face) => facelets[face]?.length === 9));
}

/**
 * Crea tutti gli stati necessari al replay. Lo scramble trascritto non viene
 * ripetuto: il primo fotogramma è già lo stato mischiato osservato nel video.
 * Inspection e solve vengono invece applicate nell'ordine esatto rilevato.
 */
export function buildVirtualReplay(
  transcript: SolveTranscript,
  initialFacelets: Record<Face, CubeColor[]> | null,
): VirtualReplay | null {
  const moves = transcript.segments
    .filter((segment) => segment.stage !== 'scramble')
    .flatMap((segment) => segment.moves.map((move) => ({
      token: move.token,
      stage: segment.stage,
      label: segment.label,
      confidence: move.confidence,
      time: move.time,
    })));
  if (!moves.length) return null;

  const parsed = parseAlgorithm(moves.map((move) => move.token).join(' '));
  const derivedInitialState = !completeFacelets(initialFacelets);
  const cube = derivedInitialState
    ? CubeState.solved().applyMoves(invertMoves(parsed))
    : CubeState.fromFacelets(initialFacelets);
  const frames = [cube.faceletRecord()];

  parsed.forEach((move) => {
    cube.applyMove(move);
    frames.push(cube.faceletRecord());
  });

  const initialSignature = CUBE_FACES
    .flatMap((face) => frames[0][face])
    .join('');
  return {
    moves,
    frames,
    derivedInitialState,
    finalSolved: cube.isSolved(),
    signature: `${initialSignature}|${moves.map((move) => move.token).join(' ')}`,
  };
}
