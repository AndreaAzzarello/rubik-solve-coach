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
caratteristiche hanno guidato il profilo temporale v2:

- ritaglio centrale dedicato al cubo, per ridurre il peso dello sfondo;
- confronto combinato di luminosita e colore, compensando piccoli cambi di
  esposizione;
- campionamento fino a circa 16 fotogrammi al secondo;
- ricerca di picchi separati anche quando le mosse sono ravvicinate;
- segnalazione distinta dei movimenti estesi, possibili wide move, rotazioni o
  regrip.

Le coppie non costituiscono ancora un dataset supervisionato per il nome della
mossa: per misurare l'accuratezza `U/R/F/...` servono le sequenze esatte oppure
timestamp annotati. Fino ad allora il decoder propone gli eventi temporali e
richiede la conferma dell'identita della mossa.
