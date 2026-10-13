'use client';

import { useState } from 'react';
import { COLOR_HEX, COLOR_LABELS, CUBE_COLORS, CUBE_FACES, type CubeColor, type Face } from '../lib/cube';
import { FACE_LABELS, NET_POSITION } from '../lib/facelets-ui';
import { HIGH_CONFIDENCE_THRESHOLD, type PartialFacelets } from '../lib/inspection-state';

const FACES = CUBE_FACES;
const CENTER_INDEX = 4;

// Iniziale di ogni colore, per non affidarsi soltanto al colore stesso nel
// riconoscere uno swatch (requisito di accessibilità): bianco/rosso/verde/
// giallo/arancione/blu non si confondono nemmeno sotto daltonismo.
const COLOR_INITIAL: Record<CubeColor, string> = {
  white: 'B', red: 'R', green: 'V', yellow: 'G', orange: 'A', blue: 'U',
};

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

// Stati per una casella VALORIZZATA: solo bordo/overlay cambia, mai il
// riempimento (il colore resta l'unico segnale primario del colore letto).
// "confirmed" (confermata dall'utente) vince su tutto il resto: una volta
// confermata non è più rilevante se la lettura originale fosse alta/bassa
// confidenza o dedotta dai vincoli.
type CellConfidenceLevel = 'high' | 'low' | 'none' | 'confirmed';

function confidenceLevel(value: number | undefined, confirmed: boolean): CellConfidenceLevel {
  if (confirmed) return 'confirmed';
  if (!value) return 'none'; // 0/undefined: dedotta dai vincoli (anche dalla ripropagazione), nessuna lettura diretta
  return value >= HIGH_CONFIDENCE_THRESHOLD ? 'high' : 'low';
}

const CONFIDENCE_LABEL: Record<CellConfidenceLevel, string> = {
  high: 'alta confidenza',
  low: 'bassa confidenza',
  none: 'dedotta dai vincoli, nessuna lettura diretta',
  confirmed: 'confermata da te',
};

export function CubeNet({
  facelets,
  cellConfidence,
  confirmedCells,
  conflictCells,
  suggestedCell,
  admissibleColorsFor,
  onConfirm,
  onUnlock,
  theme = 'light',
}: {
  facelets: PartialFacelets;
  /** Confidenza 0-100 per casella (vedi InspectionReconstruction.cellConfidence). Opzionale: se assente, le celle restano come oggi (solo bordo di tema). */
  cellConfidence?: Record<Face, number[]>;
  /** Celle confermate dall'utente: vincoli certi, bollino "✓", non modificabili per errore (serve "Modifica"). */
  confirmedCells?: Record<Face, boolean[]>;
  /** Celle svuotate dalla ripropagazione perché in conflitto con una conferma: "da ricontrollare". */
  conflictCells?: Record<Face, boolean[]>;
  /** Casella che conviene controllare per prima (sblocca più caselle): anello leggero + "Inizia da qui". */
  suggestedCell?: { face: Face; index: number } | null;
  /** Colori ancora ammessi dai vincoli per una casella non confermata (lib/inspection-state.ts: admissibleColors). Se assente, la palette mostra sempre tutti i 6 colori (comportamento di sola lettura legacy). */
  admissibleColorsFor?: (face: Face, index: number) => CubeColor[];
  /** Se presente, le caselle (tranne i centri) diventano toccabili per confermare un colore. Se assente, CubeNet resta di sola lettura come prima. */
  onConfirm?: (face: Face, index: number, color: CubeColor) => void;
  /** Sblocca una casella già confermata (bottone "Modifica"), per poterla correggere. */
  onUnlock?: (face: Face, index: number) => void;
  theme?: CubeNetTheme;
}) {
  const classes = THEME_CLASSES[theme];
  const [activeCell, setActiveCell] = useState<{ face: Face; index: number } | null>(null);
  const [lockedPanelCell, setLockedPanelCell] = useState<{ face: Face; index: number } | null>(null);
  const interactive = Boolean(onConfirm);

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
                const confirmed = confirmedCells?.[face]?.[index] ?? false;
                const conflict = !color && (conflictCells?.[face]?.[index] ?? false);
                const level = color ? confidenceLevel(cellConfidence?.[face]?.[index], confirmed) : null;
                const borderStyle = conflict
                  ? 'border-2 border-dashed border-orange-500'
                  : level === 'low'
                    ? 'border-2 border-dashed border-amber-400'
                    : level === 'none'
                      ? 'border-2 border-dotted border-slate-400/70'
                      : level === 'confirmed'
                        ? 'border-2 border-solid border-blue-500'
                        : `border ${classes.cellBorder}`;
                const isCenter = index === CENTER_INDEX;
                const isActive = activeCell?.face === face && activeCell.index === index;
                const isLockedPanelOpen = lockedPanelCell?.face === face && lockedPanelCell.index === index;
                const isSuggested = suggestedCell?.face === face && suggestedCell.index === index;
                const statusText = conflict
                  ? 'da ricontrollare: in conflitto con una casella confermata'
                  : level
                    ? CONFIDENCE_LABEL[level]
                    : 'non ancora letta';
                const cellTitle = `${face} casella ${index + 1}: ${color ? COLOR_LABELS[color] : 'non determinata'} · ${statusText}${isSuggested ? ' · Inizia da qui' : ''}`;
                const ringStyle = isActive || isLockedPanelOpen
                  ? 'ring-2 ring-blue-400'
                  : isSuggested
                    ? 'ring-2 ring-emerald-400'
                    : '';
                const cellClassName = `relative overflow-hidden rounded-[4px] ${borderStyle} ${isCenter ? 'ring-1 ring-white/70' : ''} ${
                  interactive && !isCenter ? 'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1' : ''
                } ${ringStyle}`;
                const cellStyle = color
                  ? { backgroundColor: COLOR_HEX[color] }
                  : { background: 'repeating-linear-gradient(135deg,#334155 0,#334155 5px,#1e293b 5px,#1e293b 10px)' };
                const overlay = conflict
                  ? (
                    <span
                      aria-hidden
                      className="absolute bottom-0 right-0 flex h-[55%] w-[55%] items-center justify-center rounded-tl-[4px] bg-orange-600/85 text-[8px] font-black leading-none text-white"
                    >
                      !
                    </span>
                  )
                  : level === 'none'
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
                      : level === 'confirmed'
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
                      data-testid={`cell-${face}-${index}`}
                      className={cellClassName}
                      style={cellStyle}
                      title={cellTitle}
                      aria-label={cellTitle}
                      aria-pressed={isActive || isLockedPanelOpen}
                      onClick={() => {
                        if (confirmed) {
                          setActiveCell(null);
                          setLockedPanelCell(isLockedPanelOpen ? null : { face, index });
                          return;
                        }
                        setLockedPanelCell(null);
                        setActiveCell(isActive ? null : { face, index });
                      }}
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
            {interactive && activeCell?.face === face && (() => {
              const allColors = admissibleColorsFor ? admissibleColorsFor(activeCell.face, activeCell.index) : CUBE_COLORS;
              const contradictory = allColors.length === 0;
              const palette = contradictory ? CUBE_COLORS : allColors;
              const suggestedOnly = palette.length === 1;
              return (
                <div className="mt-1.5 rounded-lg border border-slate-200/80 bg-slate-50 p-1.5">
                  {contradictory ? (
                    <p role="alert" className="mb-1.5 px-0.5 text-[10px] font-bold leading-4 text-orange-700">Qualcosa non torna: controlla le caselle segnate.</p>
                  ) : suggestedOnly ? (
                    <p className="mb-1.5 px-0.5 text-[10px] font-bold leading-4 text-blue-700">Colore suggerito, tocca per confermare</p>
                  ) : null}
                  <div className="flex items-center justify-between gap-1">
                    <div className="flex flex-wrap gap-1.5">
                      {palette.map((swatch) => {
                        const isCurrent = facelets[face][activeCell.index] === swatch;
                        return (
                          <button
                            key={swatch}
                            type="button"
                            data-testid={`swatch-${face}-${activeCell.index}-${swatch}`}
                            className={`relative flex h-11 w-11 items-center justify-center rounded-[6px] border-2 ${
                              isCurrent ? 'border-slate-900' : suggestedOnly ? 'border-blue-500' : 'border-black/15'
                            } ${suggestedOnly ? 'ring-2 ring-blue-300 ring-offset-1' : ''}`}
                            style={{ backgroundColor: COLOR_HEX[swatch] }}
                            title={COLOR_LABELS[swatch]}
                            aria-label={`Imposta ${COLOR_LABELS[swatch]} per ${face} casella ${activeCell.index + 1}`}
                            onClick={() => {
                              onConfirm?.(face, activeCell.index, swatch);
                              setActiveCell(null);
                            }}
                          >
                            <span aria-hidden className="grid h-4 w-4 place-items-center rounded-full bg-white/80 text-[9px] font-black leading-none text-slate-900">{COLOR_INITIAL[swatch]}</span>
                          </button>
                        );
                      })}
                    </div>
                    <button
                      type="button"
                      className="h-11 shrink-0 px-2 text-[10px] font-black text-slate-400 hover:text-slate-700"
                      aria-label="Chiudi selezione colore"
                      onClick={() => setActiveCell(null)}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              );
            })()}
            {interactive && lockedPanelCell?.face === face && (
              <div className="mt-1.5 flex items-center justify-between gap-2 rounded-lg border border-blue-200 bg-blue-50 p-1.5">
                <p className="px-0.5 text-[10px] font-bold leading-4 text-blue-800">Cella confermata · {COLOR_LABELS[facelets[face][lockedPanelCell.index] as CubeColor]}</p>
                <button
                  type="button"
                  className="h-9 shrink-0 rounded-md border border-blue-300 bg-white px-2.5 text-[10px] font-black text-blue-700 hover:bg-blue-100"
                  onClick={() => {
                    onUnlock?.(face, lockedPanelCell.index);
                    setActiveCell({ face, index: lockedPanelCell.index });
                    setLockedPanelCell(null);
                  }}
                >
                  Modifica
                </button>
              </div>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}
