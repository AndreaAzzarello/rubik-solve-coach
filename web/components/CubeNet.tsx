import { COLOR_HEX, COLOR_LABELS, CUBE_FACES } from '../lib/cube';
import { FACE_LABELS, NET_POSITION } from '../lib/facelets-ui';
import type { PartialFacelets } from '../lib/inspection-state';

const FACES = CUBE_FACES;

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

export function CubeNet({
  facelets,
  theme = 'light',
}: {
  facelets: PartialFacelets;
  theme?: CubeNetTheme;
}) {
  const classes = THEME_CLASSES[theme];
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
              {facelets[face].map((color, index) => (
                <span
                  key={`${face}-${index}`}
                  className={`rounded-[4px] border ${classes.cellBorder} ${index === 4 ? 'ring-1 ring-white/70' : ''}`}
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
