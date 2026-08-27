export type CubeColor = 'white' | 'red' | 'green' | 'yellow' | 'orange' | 'blue';
export type Face = 'U' | 'R' | 'F' | 'D' | 'L' | 'B';
export type Phase = 'cross' | 'f2l' | 'oll' | 'pll' | 'complete';
type Vector = readonly [number, number, number];

export type Move = {
  base: string;
  turns: -1 | 1 | 2;
  token: string;
};

type Sticker = {
  position: Vector;
  normal: Vector;
  color: CubeColor;
};

type MoveSpec = {
  axis: 0 | 1 | 2;
  layers: ReadonlySet<number>;
  positiveAxisTurn: -1 | 1;
};

export type CfopStatus = {
  crossColor: CubeColor;
  crossFaceNormal: Vector;
  crossSolved: boolean;
  f2lSolved: boolean;
  ollSolved: boolean;
  cubeSolved: boolean;
};

export type AnalysisStep = {
  index: number;
  move: Move;
  phaseBefore: Phase;
  phaseAfter: Phase;
  statusAfter: CfopStatus;
};

export type AnalysisResult = {
  moves: Move[];
  scramble: string;
  states: CubeState[];
  steps: AnalysisStep[];
  finalSolved: boolean;
};

export const COLOR_HEX: Record<CubeColor, string> = {
  white: '#f8fafc',
  red: '#ef4444',
  green: '#22c55e',
  yellow: '#facc15',
  orange: '#fb923c',
  blue: '#3b82f6',
};

export const COLOR_LABELS: Record<CubeColor, string> = {
  white: 'Bianco',
  red: 'Rosso',
  green: 'Verde',
  yellow: 'Giallo',
  orange: 'Arancione',
  blue: 'Blu',
};

const FACE_NORMALS: Record<Face, Vector> = {
  U: [0, 1, 0],
  R: [1, 0, 0],
  F: [0, 0, 1],
  D: [0, -1, 0],
  L: [-1, 0, 0],
  B: [0, 0, -1],
};

const DEFAULT_COLORS: Record<Face, CubeColor> = {
  U: 'white',
  R: 'red',
  F: 'green',
  D: 'yellow',
  L: 'orange',
  B: 'blue',
};

const MOVE_SPECS: Record<string, MoveSpec> = {
  U: { axis: 1, layers: new Set([1]), positiveAxisTurn: -1 },
  D: { axis: 1, layers: new Set([-1]), positiveAxisTurn: 1 },
  R: { axis: 0, layers: new Set([1]), positiveAxisTurn: -1 },
  L: { axis: 0, layers: new Set([-1]), positiveAxisTurn: 1 },
  F: { axis: 2, layers: new Set([1]), positiveAxisTurn: -1 },
  B: { axis: 2, layers: new Set([-1]), positiveAxisTurn: 1 },
  M: { axis: 0, layers: new Set([0]), positiveAxisTurn: 1 },
  E: { axis: 1, layers: new Set([0]), positiveAxisTurn: 1 },
  S: { axis: 2, layers: new Set([0]), positiveAxisTurn: -1 },
  x: { axis: 0, layers: new Set([-1, 0, 1]), positiveAxisTurn: -1 },
  y: { axis: 1, layers: new Set([-1, 0, 1]), positiveAxisTurn: -1 },
  z: { axis: 2, layers: new Set([-1, 0, 1]), positiveAxisTurn: -1 },
  Uw: { axis: 1, layers: new Set([0, 1]), positiveAxisTurn: -1 },
  Dw: { axis: 1, layers: new Set([-1, 0]), positiveAxisTurn: 1 },
  Rw: { axis: 0, layers: new Set([0, 1]), positiveAxisTurn: -1 },
  Lw: { axis: 0, layers: new Set([-1, 0]), positiveAxisTurn: 1 },
  Fw: { axis: 2, layers: new Set([0, 1]), positiveAxisTurn: -1 },
  Bw: { axis: 2, layers: new Set([-1, 0]), positiveAxisTurn: 1 },
};

const LOWERCASE_WIDE: Record<string, string> = {
  u: 'Uw', r: 'Rw', f: 'Fw', d: 'Dw', l: 'Lw', b: 'Bw',
};

const CROSS_TO_DOWN_ROTATION: Record<CubeColor, string> = {
  white: 'z2',
  yellow: '',
  red: 'z',
  orange: "z'",
  green: "x'",
  blue: 'x',
};

const vectorKey = (vector: Vector) => vector.join(',');
const sameVector = (left: Vector, right: Vector) => left.every((value, index) => value === right[index]);

function rotatePositiveQuarter([x, y, z]: Vector, axis: 0 | 1 | 2): Vector {
  if (axis === 0) return [x, -z, y];
  if (axis === 1) return [z, y, -x];
  return [-y, x, z];
}

function rotateVector(vector: Vector, axis: 0 | 1 | 2, quarterTurns: number): Vector {
  let result = vector;
  const turns = ((quarterTurns % 4) + 4) % 4;
  for (let index = 0; index < turns; index += 1) result = rotatePositiveQuarter(result, axis);
  return result;
}

function faceletPosition(face: Face, row: number, column: number): Vector {
  if (face === 'U') return [column - 1, 1, row - 1];
  if (face === 'D') return [column - 1, -1, 1 - row];
  if (face === 'F') return [column - 1, 1 - row, 1];
  if (face === 'B') return [1 - column, 1 - row, -1];
  if (face === 'R') return [1, 1 - row, 1 - column];
  return [-1, 1 - row, column - 1];
}

function normalizeMove(base: string, turns: -1 | 1 | 2): Move {
  const suffix = turns === -1 ? "'" : turns === 2 ? '2' : '';
  return { base, turns, token: `${base}${suffix}` };
}

export function parseAlgorithm(algorithm: string): Move[] {
  const text = algorithm.trim().replaceAll('’', "'");
  if (!text) return [];
  return text.split(/\s+/).map((token) => {
    const match = token.match(/^([URFDLB]w|[URFDLBMESxyzurfdlb])(2'?|'2|')?$/);
    if (!match) throw new Error(`Mossa non riconosciuta: ${token}`);
    const base = LOWERCASE_WIDE[match[1]] ?? match[1];
    const suffix = match[2] ?? '';
    const turns: -1 | 1 | 2 = suffix.includes('2') ? 2 : suffix === "'" ? -1 : 1;
    return normalizeMove(base, turns);
  });
}

export function invertMoves(moves: Move[]): Move[] {
  return [...moves].reverse().map((move) => normalizeMove(move.base, move.turns === 2 ? 2 : move.turns === 1 ? -1 : 1));
}

export function movesToString(moves: Move[]): string {
  return moves.map((move) => move.token).join(' ');
}

export class CubeState {
  private stickers: Sticker[];

  private constructor(stickers: Sticker[]) {
    this.stickers = stickers;
  }

  static solved(): CubeState {
    const stickers: Sticker[] = [];
    (Object.keys(FACE_NORMALS) as Face[]).forEach((face) => {
      const normal = FACE_NORMALS[face];
      for (let row = 0; row < 3; row += 1) {
        for (let column = 0; column < 3; column += 1) {
          stickers.push({ position: faceletPosition(face, row, column), normal, color: DEFAULT_COLORS[face] });
        }
      }
    });
    return new CubeState(stickers);
  }

  static fromFacelets(facelets: Record<Face, CubeColor[]>): CubeState {
    const stickers: Sticker[] = [];
    (Object.keys(FACE_NORMALS) as Face[]).forEach((face) => {
      if (facelets[face]?.length !== 9) throw new Error(`Faccia ${face} incompleta`);
      const normal = FACE_NORMALS[face];
      facelets[face].forEach((color, index) => {
        stickers.push({
          position: faceletPosition(face, Math.floor(index / 3), index % 3),
          normal,
          color,
        });
      });
    });
    return new CubeState(stickers);
  }

  clone(): CubeState {
    return new CubeState(this.stickers.map((sticker) => ({ ...sticker, position: [...sticker.position] as Vector, normal: [...sticker.normal] as Vector })));
  }

  applyMove(move: Move): CubeState {
    const spec = MOVE_SPECS[move.base];
    if (!spec) throw new Error(`Mossa non supportata: ${move.token}`);
    const turns = spec.positiveAxisTurn * move.turns;
    this.stickers = this.stickers.map((sticker) => {
      if (!spec.layers.has(sticker.position[spec.axis])) return sticker;
      return {
        ...sticker,
        position: rotateVector(sticker.position, spec.axis, turns),
        normal: rotateVector(sticker.normal, spec.axis, turns),
      };
    });
    return this;
  }

  applyMoves(moves: Move[]): CubeState {
    moves.forEach((move) => this.applyMove(move));
    return this;
  }

  facelets(face: Face): CubeColor[] {
    const normal = FACE_NORMALS[face];
    const result: CubeColor[] = [];
    for (let row = 0; row < 3; row += 1) {
      for (let column = 0; column < 3; column += 1) {
        const position = faceletPosition(face, row, column);
        const sticker = this.stickers.find((candidate) => sameVector(candidate.position, position) && sameVector(candidate.normal, normal));
        if (!sticker) throw new Error('Stato del cubo incompleto');
        result.push(sticker.color);
      }
    }
    return result;
  }

  faceletRecord(): Record<Face, CubeColor[]> {
    return Object.fromEntries(
      (Object.keys(FACE_NORMALS) as Face[]).map((face) => [face, this.facelets(face)]),
    ) as Record<Face, CubeColor[]>;
  }

  faceletString(): string {
    const colorFace = Object.fromEntries(
      Object.entries(DEFAULT_COLORS).map(([face, color]) => [color, face]),
    ) as Record<CubeColor, Face>;
    return (Object.keys(FACE_NORMALS) as Face[])
      .flatMap((face) => this.facelets(face).map((color) => colorFace[color]))
      .join('');
  }

  centerColors(): Map<string, { normal: Vector; color: CubeColor }> {
    const centers = new Map<string, { normal: Vector; color: CubeColor }>();
    this.stickers.forEach((sticker) => {
      if (sameVector(sticker.position, sticker.normal)) centers.set(vectorKey(sticker.normal), { normal: sticker.normal, color: sticker.color });
    });
    return centers;
  }

  cubiePositions(): Vector[] {
    const unique = new Map<string, Vector>();
    this.stickers.forEach((sticker) => unique.set(vectorKey(sticker.position), sticker.position));
    return [...unique.values()];
  }

  stickersAt(position: Vector): Sticker[] {
    return this.stickers.filter((sticker) => sameVector(sticker.position, position));
  }

  visibleStickers(): readonly Sticker[] {
    return this.stickers;
  }

  isSolved(): boolean {
    const centers = this.centerColors();
    return this.stickers.every((sticker) => centers.get(vectorKey(sticker.normal))?.color === sticker.color);
  }
}

function axisAndSign(normal: Vector): { axis: 0 | 1 | 2; sign: number } {
  const axis = normal.findIndex((value) => value !== 0) as 0 | 1 | 2;
  return { axis, sign: normal[axis] };
}

function positionSolved(cube: CubeState, position: Vector, centers: Map<string, { normal: Vector; color: CubeColor }>): boolean {
  return cube.stickersAt(position).every((sticker) => centers.get(vectorKey(sticker.normal))?.color === sticker.color);
}

export function cfopStatus(cube: CubeState, crossColor: CubeColor): CfopStatus {
  const centers = cube.centerColors();
  const crossCenter = [...centers.values()].find((center) => center.color === crossColor);
  if (!crossCenter) throw new Error('Il colore della Cross non corrisponde a un centro');
  const crossNormal = crossCenter.normal;
  const { axis, sign } = axisAndSign(crossNormal);

  const crossEdges = cube.cubiePositions().filter((position) => position[axis] === sign && position.filter((coordinate) => coordinate !== 0).length === 2);
  const crossSolved = crossEdges.length === 4 && crossEdges.every((position) => positionSolved(cube, position, centers));
  const f2lPositions = cube.cubiePositions().filter((position) => position[axis] !== -sign);
  const f2lSolved = f2lPositions.every((position) => positionSolved(cube, position, centers));
  const lastNormal = crossNormal.map((coordinate) => -coordinate) as unknown as Vector;
  const lastColor = centers.get(vectorKey(lastNormal))?.color;
  const ollSolved = cube.visibleStickers()
    .filter((sticker) => sameVector(sticker.normal, lastNormal) && sticker.position[axis] === -sign)
    .every((sticker) => sticker.color === lastColor);

  return { crossColor, crossFaceNormal: crossNormal, crossSolved, f2lSolved, ollSolved, cubeSolved: cube.isSolved() };
}

export function classifyPhase(cube: CubeState, crossColor: CubeColor): Phase {
  const status = cfopStatus(cube, crossColor);
  if (status.cubeSolved) return 'complete';
  if (status.f2lSolved && status.ollSolved) return 'pll';
  if (status.f2lSolved) return 'oll';
  if (status.crossSolved) return 'f2l';
  return 'cross';
}

export function analyzeSolution(algorithm: string, crossColor: CubeColor): AnalysisResult {
  const moves = parseAlgorithm(algorithm);
  if (!moves.length) throw new Error('Inserisci almeno una mossa');

  const solved = CubeState.solved();
  const orientation = parseAlgorithm(CROSS_TO_DOWN_ROTATION[crossColor]);
  solved.applyMoves(orientation);
  const inverse = invertMoves(moves);
  const initial = solved.clone().applyMoves(inverse);
  const cube = initial.clone();
  const states = [initial.clone()];
  const steps: AnalysisStep[] = [];

  moves.forEach((move, moveIndex) => {
    const phaseBefore = classifyPhase(cube, crossColor);
    cube.applyMove(move);
    const statusAfter = cfopStatus(cube, crossColor);
    steps.push({
      index: moveIndex + 1,
      move,
      phaseBefore,
      phaseAfter: classifyPhase(cube, crossColor),
      statusAfter,
    });
    states.push(cube.clone());
  });

  return {
    moves,
    scramble: movesToString(inverse),
    states,
    steps,
    finalSolved: cube.isSolved(),
  };
}
