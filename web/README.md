# CubeSolve Coach Web

Prototipo web per ricostruire lo stato iniziale di un cubo 3×3 e ottenere uno scramble verificato nella convenzione bianco sopra, verde davanti.

## Avvio locale

```powershell
pnpm install
pnpm run dev
```

## Verifica della build

```powershell
pnpm run build
```

## Funzioni attuali

- analisi automatica dei fotogrammi dell’ispezione;
- scansione guidata delle sei facce con fotocamera posteriore;
- calibrazione dinamica dei colori basata sui sei centri;
- ricostruzione e validazione fisica dello schema 3×3;
- stringa Singmaster `URFDLB` e scramble verificato;
- layout responsive per computer e smartphone.

## Moduli conservati per le fasi successive

Il progetto contiene già le basi per parsing delle mosse, tracciamento MediaPipe delle mani, riconoscimento `R/L/U/D/F/B`, classificazione Cross/F2L/OLL/PLL e replay virtuale. Questi moduli non vanno rimossi durante le pulizie, anche quando non sono ancora esposti nell’interfaccia.

I video, i fotogrammi e gli altri dati personali non vengono caricati o conservati dal sito.
