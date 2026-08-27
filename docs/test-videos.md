# Video di test locali

I file originali non fanno parte del repository. Sono registrazioni personali,
molto grandi, e rimangono nella macchina di sviluppo. La cartella
`data/private/` e i formati video principali sono esclusi tramite `.gitignore`.

## TV-001 - Solve lenta con presentazione delle facce

| Campo | Valore |
| --- | --- |
| File locale | `lento5solve.mov` |
| Dimensione | 722.724.555 byte |
| Risoluzione | 1080 x 1920, verticale |
| Frequenza | 29,976 fps |
| Durata | 270,752 secondi |
| Contenuto dichiarato | Scramble, presentazione delle facce e solve lenta |
| Funzione nel test | Baseline per calibrazione colori e riconoscimento delle mosse |

Obiettivi:

- individuare automaticamente inizio e fine delle diverse fasi;
- associare i colori alle facce tramite la presentazione esplicita;
- ricostruire le mosse in condizioni relativamente controllate;
- usare i tratti piu lenti per creare le prime annotazioni manuali.

## TV-002 - Solve veloce con presentazione delle facce

| Campo | Valore |
| --- | --- |
| File locale | `veloce.mov` |
| Dimensione | 841.931.392 byte |
| Risoluzione | 1080 x 1920, verticale |
| Frequenza | 29,976 fps |
| Durata | 325,362 secondi |
| Contenuto dichiarato | Scramble, presentazione delle facce e solve veloce |
| Funzione nel test | Stress test del riconoscimento a velocita normale |

Obiettivi:

- misurare l'effetto del motion blur a 30 fps;
- riconoscere stati stabili molto brevi tra due mosse;
- verificare la continuita del tracking durante rotazioni e regrip;
- confrontare il risultato con la baseline lenta.

## TV-003 - Solve senza presentazione esplicita delle facce

| Campo | Valore |
| --- | --- |
| File locale | `veloceSenzafarvedereleFacce.mov` |
| Dimensione | 521.979.138 byte |
| Risoluzione | 1080 x 1920, verticale |
| Frequenza | 59,975 fps |
| Durata | 177,907 secondi |
| Contenuto dichiarato | Scramble e solve senza scansione dedicata delle sei facce |
| Funzione nel test | Inferenza della mappatura dei colori dalla sequenza completa |

Obiettivi:

- usare lo stato risolto iniziale e finale come ancoraggio;
- dedurre i colori non mostrati esplicitamente tramite tracking e vincoli del
  cubo;
- separare cio che e osservato direttamente da cio che viene inferito;
- assegnare un livello di affidabilita alla mappatura finale;
- verificare il vantaggio dei 60 fps sulle mosse rapide.

## Osservazioni iniziali

- Il cubo occupa una porzione ampia dell'inquadratura ed e adatto al tracking.
- I colori sono saturi e visivamente ben distinguibili.
- Le mani causano occlusioni parziali da gestire nel decoder temporale.
- Nei video a 30 fps e visibile motion blur durante alcune rotazioni.
- Il terzo video non rende impossibile la ricostruzione dei colori: la sequenza
  parte e termina con il cubo risolto e durante scramble e solve compaiono
  ulteriori osservazioni delle facce. Le associazioni non osservate direttamente
  dovranno comunque essere etichettate come inferite.

## Dati mancanti per una validazione quantitativa

Per misurare con precisione il riconoscimento serviranno in seguito annotazioni
di riferimento con:

- timestamp di inizio e fine della solve;
- sequenza esatta delle mosse, se disponibile;
- colore della Cross;
- eventuali rotazioni complete del cubo;
- punti in cui una mossa e volutamente lenta o ambigua.

## FT-001 - Coppie di calibrazione fingertrick

Il 26 agosto 2026 sono state aggiunte cinque coppie di registrazioni guidate.
Ogni coppia mostra lo stesso gruppo di movimenti prima lentamente e poi
velocemente. I file restano locali; questa tabella conserva solo metadati
tecnici e l'abbinamento necessario per ripetere i test.

| Gruppo | Video lento | Durata / fps | Video veloce | Durata / fps |
| --- | --- | --- | --- | --- |
| Movimenti base | `IMG_6010.MOV` | 108,470 s / 29,999 | `IMG_6021.MOV` | 28,412 s / 59,975 |
| Wide move | `IMG_6011.MOV` | 103,217 s / 29,976 | `IMG_6022.MOV` | 31,430 s / 59,975 |
| Slice move | `IMG_6013.MOV` | 59,135 s / 29,999 | `IMG_6023.MOV` | 30,747 s / 59,974 |
| Rotazioni complete | `IMG_6015.MOV` | 48,987 s / 59,976 | `IMG_6025.MOV` | 23,277 s / 59,974 |
| Trigger e fingertrick | `IMG_6017.MOV` | 92,672 s / 59,975 | `IMG_6032.MOV` | 28,178 s / 59,975 |

Tutti i filmati sono verticali a 1080 x 1920. L'inquadratura e stabile, il
cubo occupa la zona centrale e ogni clip ritorna allo stato risolto. Queste
caratteristiche hanno guidato il profilo temporale v4:

- ritaglio centrale dedicato al cubo, per ridurre il peso dello sfondo;
- confronto combinato di luminosita e colore, compensando piccoli cambi di
  esposizione;
- campionamento fino a circa 16 fotogrammi al secondo;
- ricerca di picchi separati anche quando le mosse sono ravvicinate;
- segnalazione distinta dei movimenti estesi, possibili wide move, rotazioni o
  regrip.
- soglia massima legata alla distribuzione dell'attivita, per non perdere le
  mosse quando gran parte di un video lungo contiene movimento;
- segmentazione automatica di scramble probabile, ispezione e solve tramite le
  pause tra i blocchi di attivita.
- tracciamento MediaPipe di due mani e 21 landmark per mano;
- separazione tra traslazione del palmo e movimento residuo delle dita;
- fusione adattiva con gli sticker e finestra anticipata fino a tre campioni,
  per collegare la preparazione del fingertrick alla rotazione visibile subito
  dopo;
- etichetta `cubo`, `mani/dita` o `cubo + dita` su ogni evento, in modo che il
  fallback sia verificabile dall'utente.

Le coppie non costituiscono ancora un dataset supervisionato per il nome della
mossa senza allineamento temporale. Le sequenze guidate registrate sono pero
note e vengono conservate qui come riferimento supervisionato:

```text
IMG_6010 / IMG_6021 · base
U U' U' U U2 U2
R R' R' R R2 R2
F F' F' F F2 F2
D D' D' D D2 D2
L L' L' L L2 L2
B B' B' B B2 B2

IMG_6011 / IMG_6022 · wide
Uw Uw' Uw' Uw Uw2 Uw2
Rw Rw' Rw' Rw Rw2 Rw2
Fw Fw' Fw' Fw Fw2 Fw2
Dw Dw' Dw' Dw Dw2 Dw2
Lw Lw' Lw' Lw Lw2 Lw2
Bw Bw' Bw' Bw Bw2 Bw2

IMG_6013 / IMG_6023 · slice
M M' M' M M2 M2
E E' E' E E2 E2
S S' S' S S2 S2

IMG_6015 / IMG_6025 · rotazioni
x x' x' x x2 x2
y y' y' y y2 y2
z z' z' z z2 z2

IMG_6017 / IMG_6032 · trigger
R U R' U' U R U' R'
R' U' R U U' R' U R
L' U' L U U' L' U L
R' F R F' F R' F' R
F R U R' U' F' F U R U' R' F'
```

`tools/train_visual_move_decoder.py` usa queste etichette e valida sempre le
riprese lente contro quelle veloci. Il primo esperimento basato soltanto su
flusso ottico e differenze d'immagine ha ottenuto il 7,89% di accuratezza
esatta e il 16,45% sulla sola faccia: il risultato viene quindi correttamente
scartato e non e distribuito come modello. Dimostra che la classificazione
affidabile richiede allineamento migliore, landmark delle dita, posa del cubo e
vincoli sullo stato degli sticker; una semplice somiglianza tra fotogrammi non
e sufficiente.

## Profilo temporale v7

Il decoder non assume piu che ogni massimo locale rappresenti una sola mossa.
I massimi ravvicinati vengono aggregati in pacchetti temporali con durata
limitata; ogni pacchetto conserva l'elenco ordinato dei picchi, il numero di
mosse stimato, la sequenza candidata e i due canali di evidenza. Le rianalisi
vengono sovrapposte confrontando centro e durata del pacchetto. Questa struttura
permette ai video veloci di mantenere insieme fingertrick composte e offre una
correzione manuale dell'intera sottosequenza.

La lettura v7 aggiunge un controllo cromatico sui fotogrammi stabili conclusivi:
il colore dominante della faccia PLL deve proporre come Cross il colore opposto
(`bianco-giallo`, `arancio-rosso`, `verde-blu`). Il test deve verificare sia un
caso sopra soglia, nel quale l'indizio viene mostrato e applicato, sia un caso
ambiguo, nel quale il sistema mantiene il fallback basato sulla sequenza.
