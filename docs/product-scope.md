# Ambito iniziale del prodotto

## Problema

Una registrazione di una solve mostra il risultato finale, ma normalmente non
fornisce una trascrizione verificabile delle mosse, una suddivisione per fasi o
un confronto con alternative piu efficienti.

CubeSolve Coach vuole convertire il video in una timeline tecnica consultabile,
correggibile e riproducibile.

## Flusso principale

1. L'utente registra o importa una solve.
2. L'app rileva il cubo, i colori visibili, il suo orientamento e 21 landmark
   per ciascuna mano visibile.
3. Il motore fonde gli stati del cubo con movimento del palmo e fingertrick,
   usando ogni canale come fallback dell'altro in caso di occlusione.
4. Un decoder vincolato dalle regole del cubo seleziona la sequenza di mosse
   compatibile con il video.
5. L'utente controlla i passaggi incerti tramite video e cubo virtuale.
6. La sequenza viene suddivisa nelle fasi del metodo riconosciuto.
7. L'app genera statistiche e alternative personalizzate.

## Risultati dell'analisi

- notazione completa delle mosse;
- timestamp e durata di ogni fase;
- versione fedele, comprensiva di rotazioni `x`, `y` e `z`;
- versione normalizzata rispetto a un riferimento fisso dei colori;
- conteggio mosse, TPS, pause, rotazioni e regrip rilevabili;
- classificazione Cross, F2L, OLL e PLL;
- livello di affidabilita e possibilita di correzione manuale;
- replay sul cubo virtuale;
- suggerimenti alternativi con relativa motivazione.

## Personalizzazione della Cross

L'utente potra selezionare:

- un singolo colore preferito;
- una coppia di colori per il dual neutral;
- modalita color neutral;
- esecuzione abituale della Cross sopra o sotto;
- confronto facoltativo con tutte e sei le Cross.

La preferenza orienta l'analisi e i consigli, ma non sostituisce il rilevamento
del colore realmente usato nel video.

## Criteri per i suggerimenti

Una soluzione alternativa non verra valutata soltanto in base al numero di
mosse. Il punteggio potra considerare:

- ergonomia e fingertrick;
- rotazioni e regrip;
- visibilita dei pezzi successivi;
- preservazione di coppie o blocchi gia favorevoli;
- algoritmi dichiarati come conosciuti dall'utente;
- preferenza per mano destra o sinistra;
- livello ed esperienza dell'utente.

## Scramble

L'inverso della sequenza completa produce sempre uno scramble valido per
ricreare lo stato iniziale, ma non necessariamente lo scramble originale o il
piu corto possibile.

L'interfaccia distinguera quindi tra:

- **scramble ricostruito**: inverso esatto della solve;
- **scramble piu corto trovato**: risultato di un risolutore, accompagnato dalla
  metrica utilizzata e senza dichiarazioni di ottimalita non dimostrate.

## Fuori dall'MVP

- garanzia di riconoscimento per qualsiasi video pubblico;
- video con tagli, cubo fuori campo o occlusioni prolungate;
- classificazione completa di Roux, ZB, ZZ, Petrus e metodi ibridi;
- supporto per puzzle diversi dal 3x3;
- garanzia dello scramble minimo assoluto.

## Principio di affidabilita

Se il video non contiene informazioni sufficienti, l'app non deve inventare una
mossa. Deve mostrare l'incertezza, presentare le alternative compatibili e
permettere all'utente di correggere la timeline.

Nel decoder v6 questo principio viene applicato anche alla fusione: la
concordanza tra cubo e dita aumenta l'affidabilita; un pacchetto sostenuto da un
solo canale resta visibile ma viene dichiarato come tale. Picchi ravvicinati
restano nello stesso intervallo e generano una sequenza candidata, non una falsa
corrispondenza obbligatoria `un picco = una mossa`. Le lettere automatiche sono
presentate come ipotesi modificabili finche orientamento e stato degli sticker
non forniscono una verifica sufficiente.
