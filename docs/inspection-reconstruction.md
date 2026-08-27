# Ricostruzione dello stato durante l'ispezione

## Separazione delle due parti del video

Il decoder assegna scopi diversi ai due intervalli:

1. prima della pausa di partenza, ogni rotazione del cubo serve esclusivamente
   a mostrare facce e pezzi dello stato mischiato;
2. dalla posizione scelta per iniziare, i cambiamenti del cubo e i movimenti di
   mani e dita vengono convertiti nella notazione della solve.

Le rotazioni `x`, `y` e `z` dell'ispezione non vengono quindi aggiunte alla
sequenza `R/L/U/D/F/B`.

## Convenzione e lettura visuale

Lo stato ricostruito viene normalizzato nella convenzione standard:

| Faccia | Colore del centro |
| --- | --- |
| U | bianco |
| R | rosso |
| F | verde |
| D | giallo |
| L | arancione |
| B | blu |

Per ogni fotogramma stabile il browser classifica i pixel dei sei colori,
raggruppa le regioni contigue simili a sticker e cerca una griglia prospettica
3x3. Il colore centrale identifica la faccia. Le viste ripetute della stessa
faccia vengono allineate nelle quattro rotazioni possibili e fuse soltanto se
le caselle comuni concordano senza ambiguita.

## Deduzione dei pezzi nascosti

Il ricostruttore usa i vincoli del 3x3 intero, non un riempimento colore per
colore:

- esistono esattamente otto angoli e dodici spigoli, ciascuno usato una volta;
- la somma degli orientamenti degli angoli e divisibile per tre;
- il numero complessivo di spigoli girati e pari;
- la parita della permutazione degli angoli coincide con quella degli spigoli;
- ogni colore compare esattamente nove volte, incluso il centro fisso.

Per questo vedere uno o due colori di un angolo puo essere sufficiente solo se
tutti gli altri pezzi osservati rendono unica la sua identita e il suo
orientamento. Se restano piu configurazioni legali, l'interfaccia conserva le
caselle viste e mostra `Parziale`: non inventa quelle nascoste.

## Scramble verificato

Quando rimane una sola configurazione legale, il suo facelet string `URFDLB`
viene passato al risolutore Cube.js. L'inverso della soluzione ottenuta e lo
scramble da applicare a un cubo risolto con bianco sopra e verde davanti. Prima
di mostrarlo come verificato, l'app lo riesegue con il proprio motore e confronta
tutte le 54 caselle con lo stato ricostruito.

La ricerca v10 confronta 19 soluzioni: quella diretta e altre 18 ottenute
anteponendo ciascun possibile turno di faccia. Dopo aver compattato eventuali
turni consecutivi della stessa faccia, conserva il candidato verificato con il
minor numero di mosse HTM.

Questo scramble ricrea esattamente lo stato, ma non e una dichiarazione di
minimalita assoluta. Il Two-Phase Algorithm privilegia la velocita e non visita
tutti i percorsi necessari a dimostrare sempre l'ottimo globale; una ricerca
ottimale completa e un problema distinto e molto piu pesante.

## Riferimenti usati

- [Cubing Standards - Fundamental Cube Terms](https://standards.cubing.net/draft/1/fundamental-cube-terms/): convenzione colori e orientamento standard.
- [Herbert Kociemba - Cubie Level](https://www.kociemba.org/math/cubielevel.htm): rappresentazione, orientamenti e vincoli di raggiungibilita.
- [Cube.js](https://github.com/rcombs/Cube.js/): conversione dallo stato `URFDLB` a una soluzione riproducibile.
- [OpenCV Rubik's Cube scanner tutorial](https://www.youtube.com/watch?v=WJRhB39BxWQ): riferimento pratico per segmentazione dei colori e rilevamento delle facce; il sito usa una propria implementazione locale nel browser.
