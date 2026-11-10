# Informativa sulla privacy — CubeSolve Coach

> **BOZZA, non pubblicare.** I segnaposto `[[DA COMPLETARE]]` richiedono i dati
> del titolare: non vanno inventati. L'affermazione «nessuna risorsa esterna a
> runtime» è vera solo dopo il commit che serve MediaPipe da `public/`
> (punto 6, 3a); oggi l'app scarica ancora MediaPipe da jsDelivr e Google.
> L'accessibilità del testo pubblicato si cura con il redesign.

## In breve
Il video che scegli viene analizzato **solo nel tuo browser**. Non viene caricato
su alcun server, non viene condiviso e non viene salvato. L'app non usa cookie
né strumenti di analisi o pubblicità.

## Titolare del trattamento
[[DA COMPLETARE: nome o ragione sociale del titolare]]
Contatto: [[DA COMPLETARE: indirizzo email o PEC di contatto]]

## Che cosa succede al tuo video
- Il file resta sul tuo dispositivo: viene letto in memoria dal browser (come
  `blob:` locale) e analizzato lì, fotogramma per fotogramma.
- Non c'è un backend: nessun upload, nessuna richiesta di rete con il contenuto
  del video o dei fotogrammi.
- Chiudendo o ricaricando la pagina, il video e i risultati dell'analisi
  vengono dimenticati.

## Cookie, analytics, archiviazione locale
- **Cookie:** nessuno. **Analytics, pubblicità, tracciamento:** nessuno.
- **`localStorage`, `sessionStorage`, IndexedDB:** non usati.
- **Cache del browser (Cache Storage, tramite service worker):** l'app salva
  la propria pagina e i propri file (modelli e librerie) per funzionare anche
  offline e caricarsi più in fretta. Sono file dell'app, non contengono dati
  personali e puoi cancellarli dalle impostazioni del browser.
  [[DA COMPLETARE dopo 3a: elencare i file in cache e quando vengono salvati]]

## Risorse esterne
Dopo l'aggiornamento di MediaPipe (3a), a runtime l'app non richiede file a
domini di terzi: tutto viene servito dallo stesso sito. Nessun font, script,
mappa o contenuto incorporato da terzi.

## Hosting e dati tecnici di connessione
Come per ogni sito web, il fornitore di hosting riceve i dati tecnici
necessari a inviarti le pagine (per esempio indirizzo IP e user agent) e può
registrarli nei propri log.
- Fornitore di hosting: [[DA COMPLETARE: fornitore e sede, da confermare con
  il deploy reale]]
- Base giuridica: [[DA COMPLETARE: da definire con il titolare]]
- Tempo di conservazione dei log: [[DA COMPLETARE: dal fornitore]]

## I tuoi diritti
Hai diritto di accesso, rettifica, cancellazione, limitazione, portabilità e
opposizione (artt. 15-22 GDPR) e di proporre reclamo al Garante per la
protezione dei dati personali. Per esercitarli: [[DA COMPLETARE: contatto]].

## Aggiornamenti
Ultima revisione: [[DA COMPLETARE: data]]
