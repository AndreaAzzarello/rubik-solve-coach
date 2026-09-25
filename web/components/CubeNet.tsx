'use client';

import { useState } from 'react';
import { COLOR_HEX, COLOR_LABELS, CUBE_COLORS, CUBE_FACES, type CubeColor, type Face } from '../lib/cube';
import { FACE_LABELS, NET_POSITION } from '../lib/facelets-ui';
import { HIGH_CONFIDENCE_THRESHOLD, type PartialFacelets } from '../lib/inspection-state';

const FACES = CUBE_FACES;
const CENTER_INDEX = 4;

type CubeNetTheme = 'light' | 'dark';

const THEME_CLASSES: Record<CubeNetTheme, {
  wrapper: string;
  card: string;
  label: string;
  count: string;
  cellBorder: string;
}> = {
  light: {
    wrapper: 'overflow-x-auto pb-2',
    card: 'min-w-0 rounded-xl border border-slate-200 bg-white p-2 shadow-sm',
    label: 'text-[9px] font-black uppercase tracking-[0.1em] text-slate-500',
    count: 'text-[8px] font-bold text-slate-400',
    cellBorder: 'border-black/15',
  },
  dark: {
    wrapper: 'overflow-x-auto pb-1',
    card: 'rounded-xl border border-white/10 bg-slate-900/85 p-2',
    label: 'text-[9px] font-black uppercase tracking-[0.1em] text-slate-400',
    count: 'text-[8px] font-bold text-slate-500',
    cellBorder: 'border-black/30',
  },
};

// Quattro stati per una casella VALORIZZATA (un colore null è un caso a
// parte, gestito sotto: nessuna confidenza da mostrare perché non c'è ancora
// un colore). Solo il bordo/overlay cambia, mai il riempimento: il colore
// della casella resta l'unico segnale primario. "edited" vince sempre sugli
// altri: appena l'utente corregge una casella, la confidenza originale
// dell'algoritmo (giusta o sbagliata che fosse) non è più il dato rilevante.
type CellConfidenceLevel = 'high' | 'low' | 'none' | 'edited';

function confidenceLevel(value: number | undefined, edited: boolean): CellConfidenceLevel {
  if (edited) return 'edited';
  if (!value) return 'none'; // 0/undefined: dedotta dai vincoli, nessuna lettura diretta
  return value >= HIGH_CONFIDENCE_THRESHOLD ? 'high' : 'low';
}

const CONFIDENCE_LABEL: Record<CellConfidenceLevel, string> = {
  high: 'alta confidenza',
  low: 'bassa confidenza',
  none: 'dedotta dai vincoli, nessuna lettura diretta',
  edited: 'corretta manualmente',
};

export function CubeNet({
  facelets,
  cellConfidence,
  editedCells,
  onEdit,
  theme = 'light',
}: {
  facelets: PartialFacelets;
  /** Confidenza 0-100 per casella (vedi InspectionReconstruction.cellConfidence). Opzionale: se assente, le celle restano come oggi (solo bordo di tema). */
  cellConfidence?: Record<Face, number[]>;
  /** Celle già corrette a mano: hanno sempre priorità sulla confidenza dell'algoritmo. */
  editedCells?: Record<Face, boolean[]>;
  /** Se presente, le caselle (tranne i centri) diventano toccabili per cambiare colore. Se assente, CubeNet resta di sola lettura come prima. */
  onEdit?: (face: Face, index: number, color: CubeColor) => void;
  theme?: CubeNetTheme;
}) {
  const classes = THEME_CLASSES[theme];
  const [activeCell, setActiveCell] = useState<{ face: Face; index: number } | null>(null);
  const interactive = Boolean(onEdit);

  return (
    <div className={classes.wrapper}>
      <div className="grid min-w-[430px] grid-cols-4 grid-rows-3 gap-2">
        {FACES.map((face) => (
          <article key={face} className={`${NET_POSITION[face]} ${classes.card}`}>
            <div className="mb-1.5 flex items-center justify-between gap-1">
              <p className={classes.label}>{face} · {FACE_LABELS[face]}</p>
              <span className={classes.count}>{facelets[face].filter(Boolean).length}/9</span>
            </div>
            <div className="grid aspect-square grid-cols-3 gap-1 rounded-lg bg-slate-950 p-1.5">
              {facelets[face].map((color, index) => {
                const edited = editedCells?.[face]?.[index] ?? false;
                const level = color ? confidenceLevel(cellConfidence?.[face]?.[index], edited) : null;
                const borderStyle = level === 'low'
                  ? 'border-2 border-dashed border-amber-400'
                  : level === 'none'
                    ? 'border-2 border-dotted border-slate-400/70'
                    : level === 'edited'
                      ? 'border-2 border-solid border-blue-500'
                      : `border ${classes.cellBorder}`;
                const isCenter = index === CENTER_INDEX;
                const isActive = activeCell?.face === face && activeCell.index === index;
                const cellTitle = `${face} casella ${index + 1}: ${color ? COLOR_LABELS[color] : 'non determinata'}${level ? ` · ${CONFIDENCE_LABEL[level]}` : ''}`;
                const cellClassName = `relative overflow-hidden rounded-[4px] ${borderStyle} ${isCenter ? 'ring-1 ring-white/70' : ''} ${
                  interactive && !isCenter ? 'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1' : ''
                } ${isActive ? 'ring-2 ring-blue-400' : ''}`;
                const cellStyle = color
                  ? { backgroundColor: COLOR_HEX[color] }
                  : { background: 'repeating-linear-gradient(135deg,#334155 0,#334155 5px,#1e293b 5px,#1e293b 10px)' };
                const overlay = level === 'none'
                  ? (
                    <span
                      aria-hidden
                      className="absolute inset-0"
                      style={{ background: 'repeating-linear-gradient(135deg,rgba(15,23,42,0.32) 0,rgba(15,23,42,0.32) 3px,transparent 3px,transparent 6px)' }}
                    />
                  )
                  : level === 'low'
                    ? (
                      <span
                        aria-hidden
                        className="absolute bottom-0 right-0 flex h-[55%] w-[55%] items-center justify-center rounded-tl-[4px] bg-slate-950/55 text-[8px] font-black leading-none text-amber-300"
                      >
                        ?
                      </span>
                    )
                    : level === 'edited'
                      ? (
                        <span
                          aria-hidden
                          className="absolute bottom-0 right-0 flex h-[55%] w-[55%] items-center justify-center rounded-tl-[4px] bg-blue-600/80 text-[8px] font-black leading-none text-white"
                        >
                          ✓
                        </span>
                      )
                      : null;

                if (interactive && !isCenter) {
                  return (
                    <button
                      key={`${face}-${index}`}
                      type="button"
                      className={cellClassName}
                      style={cellStyle}
                      title={cellTitle}
                      aria-label={cellTitle}
                      aria-pressed={isActive}
                      onClick={() => setActiveCell(isActive ? null : { face, index })}
                    >
                      {overlay}
                    </button>
                  );
                }
                return (
                  <span key={`${face}-${index}`} className={cellClassName} style={cellStyle} title={cellTitle}>
                    {overlay}
                  </span>
                );
              })}
            </div>
            {interactive && activeCell?.face === face && (
              <div className="mt-1.5 flex items-center justify-between gap-1 rounded-lg border border-slate-200/80 bg-slate-50 p-1.5">
                <div className="flex flex-wrap gap-1">
                  {CUBE_COLORS.map((swatch) => {
                    const isCurrent = facelets[face][activeCell.index] === swatch;
                    return (
                      <button
                        key={swatch}
                        type="button"
                        className={`h-5 w-5 rounded-[4px] border-2 ${isCurrent ? 'border-slate-900' : 'border-black/15'}`}
                        style={{ backgroundColor: COLOR_HEX[swatch] }}
                        title={COLOR_LABELS[swatch]}
                        aria-label={`Imposta ${COLOR_LABELS[swatch]} per ${face} casella ${activeCell.index + 1}`}
                        onClick={() => {
                          onEdit?.(face, activeCell.index, swatch);
                          setActiveCell(null);
                        }}
                      />
                    );
                  })}
                </div>
                <button
                  type="button"
                  className="shrink-0 px-1 text-[10px] font-black text-slate-400 hover:text-slate-700"
                  aria-label="Chiudi selezione colore"
                  onClick={() => setActiveCell(null)}
                >
                  ✕
                </button>
              </div>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}
