# Esperimenti sulla pipeline di ricostruzione (ottobre 2026)

Bench di riferimento: 13 video (`bench/cases.json`) — 3 "test" mai visti dal
modello (IMG_6258/6260/6281, le sole decisive per cambi di MODELLO), 2
"integration" (IMG_6107/6108), 8 "seen" usati in training. Baseline di
produzione = 359/702 (gruppo test 130/162: 6258=54, 6260=39, 6281=37).

Ogni riga: cosa è stato provato → risultato sui 13 video → perché è stato
scartato. Nessuno di questi è in produzione.

1. **finetune-crops.onnx da solo** (checkpoint fine-tuned, sostituiva il
   modello di produzione) → PCK migliore ma bench 6281 crolla a 16/54 →
   scartato: criterio "nessun video giù di più di 5" violato.
2. **Ibrido pass1=attuale/pass2=finetune-crops** (due modelli diversi per i
   due passaggi) → guadagni netti su 2/3 video test, ma 6281 crolla ancora
   di più, a 10/54 → scartato, stesso criterio.
3. **Fuse-prima** (antepone candidate fuse a sourceFrames≥2 ai raw, senza
   altro cambiamento) → 6281 -20; instabilità bidirezionale enorme sui
   "seen" (6300 +41, altri -20/-21) → scartato: il riordino da solo non crea
   vera fusione multi-fotogramma, sposta solo quale singola lettura vince.
4. **Finestra temporale estesa (fino a tutta l'ispezione) + fuse-prima
   insieme** → 6281 -25, ancora peggio del solo fuse-prima → scartato.
5. **Rimozione della riduzione a singola-migliore-per-faccia** (V1,
   `selectSingleBestModelObservationPerFace` bypassata) → totale pipeline
   sale a 400/702, ma 3 video crollano >20 caselle (6281 -21, 6297 -19,
   6338 -20) → scartato dal criterio di sicurezza, nonostante il guadagno
   aggregato.
6. **Fix del dedup in `fuseFaceObservationCandidates`** (tiene il candidato
   con più sourceFrames per pattern, non il primo trovato) combinato con V1
   → risolve solo parzialmente il caso diagnosticato (6338/faccia B vince
   localmente ma il beam-search fra facce lo compensa comunque con altre
   facce ancora sbagliate) → il totale non si muove abbastanza, non
   adottato con V1. Il fix isolato, testato DA SOLO in produzione normale
   (senza V1), **non è un no-op come previsto**: 6258 -19, 6281 +10 e altri
   spostamenti — significa che in produzione normale arriva più di una
   osservazione alla fusione in alcuni casi (es. l'osservazione sintetica
   "balanced"). Rimosso anche questo.
7. **Redesign a due fasi** (clustering tollerante alla rotazione + voto
   cella-per-cella pesato per evidenza, sostituendo la riduzione a
   singola-migliore; orientamento assoluto lasciato al risolutore dei
   vincoli fisici, 4 rotazioni, centri vicini solo come spareggio) →
   peggiora tutto: 352/702 (sotto sia baseline 359 sia V1 400), 6281 crolla
   a -30, e 6338 — il caso bersaglio dell'intero redesign — peggiora
   ulteriormente a 10/54 invece di migliorare → scartato.

## Diagnosi trasversale (non un esperimento, un fatto osservato)

- Due cause distinte dietro le regressioni di V1: **errore cromatico
  sistematico rosso/arancione** (6281, 6297 — la maggioranza delle
  osservazioni vota compattamente il colore sbagliato con la STESSA
  confidenza della minoranza corretta, quindi nessun criterio di "consenso
  netto" lo risolve) e **frammentazione per rotazione** (6338 — la stessa
  lettura arriva in orientamenti diversi con celle occluse in posizioni
  diverse, spezzando un consenso altrimenti unanime).

## Conclusione

La ricostruzione è sensibile in modo **caotico**, non incrementale: ogni
variante tentata sposta singoli video di **±20-40 caselle su 54**, senza un
pattern prevedibile dalla teoria che la motivava. Un cambiamento pensato per
risolvere un caso specifico (es. 6338) può lasciarlo invariato o peggiorarlo,
mentre ne sposta altri in modi non previsti. Non fidarsi di un miglioramento
aggregato sul totale pipeline senza controllare ogni singolo video del
gruppo "test": un totale più alto può nascondere un singolo video crollato
di decine di caselle. Prima di riprovare una direzione simile a una già
elencata sopra, verificare che non sia già stata scartata qui.
