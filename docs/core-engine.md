# Motore matematico del cubo

## Scopo

Il motore costituisce il riferimento deterministico tra il riconoscimento video
e l'analisi tecnica. Il sistema di visione proporra una o piu mosse candidate;
questo modulo applichera le mosse, eliminera le sequenze incompatibili e
classifichera lo stato risultante.

## Funzioni disponibili

- modello sticker-level con 54 sticker e coordinate 3D intere;
- schema colori configurabile;
- notazione `U R F D L B` con suffissi prime e `2`;
- slice move `M E S`;
- rotazioni complete `x y z`;
- wide move, sia `Rw` sia forma abbreviata `r`;
- inversione di algoritmi;
- scramble ricostruito come inverso esatto della soluzione;
- rilevamento di Cross, F2L, OLL, PLL e solve completa;
- scelta della Cross tramite il colore del centro;
- timeline dello stato prima e dopo ogni mossa.

## Esempio Python

```python
from cubesolve_core import (
    CubeState,
    analyze_cfop_sequence,
    reconstructed_scramble,
)

solution = "R U R' U'"
scramble = reconstructed_scramble(solution)
initial_state = CubeState.solved().apply_algorithm(scramble)
timeline = analyze_cfop_sequence(initial_state, solution, "yellow")

assert timeline[-1].status_after.cube_solved
```

## Significato della classificazione

La fase associata a ciascuno stato e istantanea:

- `cross`: la Cross non e completa;
- `f2l`: la Cross e completa, ma i primi due strati non lo sono;
- `oll`: F2L completo, ultimo strato non orientato;
- `pll`: ultimo strato orientato, permutazione non completa;
- `complete`: cubo risolto, indipendentemente dall'orientamento nello spazio.

Se durante la solve l'utente distrugge temporaneamente un pezzo gia risolto, la
timeline puo tornare a una fase precedente. Un livello successivo trasformera
questi stati grezzi in segmenti descrittivi e segnalera la regressione come
possibile inefficienza.

## Cross e orientamento

La Cross viene selezionata tramite il colore, non tramite una faccia fissa. Se
l'utente ruota tutto il cubo con `x`, `y` o `z`, il motore segue il relativo
centro e continua a riconoscere la stessa Cross.

Lo schema predefinito e:

| Faccia | Colore |
| --- | --- |
| U | bianco |
| R | rosso |
| F | verde |
| D | giallo |
| L | arancione |
| B | blu |

Lo schema potra essere sostituito durante la calibrazione video.

## Limiti attuali

- Il validatore di uno stato letto dalla camera controlla pezzi, orientamenti e
  parita, ma puo completare le caselle nascoste soltanto quando esiste una sola
  configurazione compatibile con quanto osservato.
- La timeline classifica gli stati ma non riconosce ancora singoli casi OLL o
  PLL.
- Non vengono ancora assegnati timestamp alle mosse.
- Roux, ZB e metodi ibridi non sono ancora implementati.
- Lo scramble ricostruito riproduce esattamente lo stato letto ma non pretende
  di essere il minimo assoluto in HTM o QTM.

## Collegamento futuro con il video

Per ogni intervallo tra due fotogrammi stabili, il riconoscimento generera un
insieme ristretto di mosse candidate. Il motore conservera soltanto i candidati
che:

1. producono uno stato legalmente raggiungibile;
2. concordano con gli sticker visibili;
3. restano compatibili con gli stati osservati successivamente;
4. terminano nello stato risolto dichiarato dal video.
