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

