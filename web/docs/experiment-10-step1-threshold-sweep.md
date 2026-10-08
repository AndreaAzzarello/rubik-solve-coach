# Esperimento #10, passo 1 — sweep soglie (solo misura)

Prodotto da `vision/eval/grid-alignment-signal.ts` (commit `39f19d3`, stesso
seed/campione della diagnosi: seed=20261009, 5 video su 9 candidati —
6258, 6299, 6107, 6298, 6334 — esclusi 6281/6297/6338/6260). Dataset: 52
osservazioni-modello "giuste" (≥8/9 celle corrette) e 52 "sbagliate" (≤5/9),
23 escluse (6-7/9).

| Soglia | Giuste scartate | Sbagliate scartate | Confini colore (verità) delle giuste scartate | Criterio ≥85% sbagliate E ≤5% giuste |
|---|---|---|---|---|
| 2 | 1/52 (1.9%) | 26/52 (50.0%) | 10 confini: 1 caso | no |
| 3 | 1/52 (1.9%) | 40/52 (76.9%) | 10 confini: 1 caso | no |
| **4** | **2/52 (3.8%)** | **47/52 (90.4%)** | 9 confini: 1 caso; 10 confini: 1 caso | **SÌ** |
| 6 | 8/52 (15.4%) | 50/52 (96.2%) | 7:2, 9:3, 10:2, 11:1 | no |
| 8 | 11/52 (21.2%) | 50/52 (96.2%) | 7:2, 9:3, 10:5, 11:1 | no |

**Soglia principale: 4** (unica che soddisfa il criterio). Soglie vicine per
il bench di validazione (passo 3): 3 (più bassa) e 6 (più alta).

Le giuste scartate a soglia 4 NON sono a tinta quasi unita: hanno 9-10
confini di colore su 12 possibili (facce molto variopinte) — il filtro non
le perde per somiglianza cromatica interna delle celle.
