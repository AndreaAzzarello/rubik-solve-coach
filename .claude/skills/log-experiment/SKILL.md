---
name: log-experiment
description: Registra un esperimento sulla pipeline (bench, window-sensitivity, diagnosi, variante adottata, scartata o interrotta) nel registro unico web/docs/pipeline-experiments.md. Usala dopo aver ottenuto un risultato o preso una decisione, anche di abbandono. Scrive SOLO in quel file.
---

# log-experiment

## Perimetro
- Scrive solo in `web/docs/pipeline-experiments.md`. Nessun altro file, nessuna nota nel vault, nessun secondo registro.
- Le voci esistenti non si modificano. Un errore in una voce vecchia si corregge con una nota nella voce nuova, o con l'ok esplicito dell'utente.
- Niente commit senza che l'utente abbia visto il diff e dato l'ok.

## Anche scartati e interrotti
- Registra anche gli esperimenti scartati o interrotti: servono a non ripeterli.
- Per un esperimento interrotto scrivi il motivo dell'interruzione (criterio violato, crollo su un video, tempo, errore di setup, decisione dell'utente) e fin dove è arrivato.
- Le misure parziali vanno dichiarate come parziali. Ciò che non è stato misurato: "non misurato".

## Prima di scrivere
1. Trova l'ultimo numero: `Grep` di `^\d+\. \*\*` nel registro. La nuova voce è ultimo+1.
2. Cerca per parole chiave se l'esperimento esiste già o se la direzione è già stata scartata. In quel caso dillo e proponi un'integrazione, non un duplicato.
3. Raccogli i dati dall'output completo del run (vedi `bench-safety`). Non ricostruire numeri a memoria.

## Formato della voce (come #19 e #20)
`N. **Domanda o ipotesi → esito in una frase (adottata / non adottata / solo diagnosi / interrotta).**`
Poi, indentata di 4 spazi e solo per ciò che serve:
- **Motivo**: cosa ha portato all'esperimento.
- **Modifiche**: branch, flag, file toccati. Esperimenti su branch dedicato: dillo.
- **Metodo**: comando, seed, numero di prove, branch, commit hash, stato dell'albero, sistema operativo, data (AAAA-MM-GG).
- **Risultato**: numeri esatti. Totale /702 contro baseline, gruppo test, delta per video, tempo del run.
- **Verdetto**: criterio di adozione dichiarato e se è soddisfatto (totale sopra baseline E nessun video test giù di oltre 5 caselle; per #21 anche la stabilità della finestra). Per un'interruzione: il motivo.
- **Lezione**: solo se emerge qualcosa di riutilizzabile.
- **Dati**: percorso del JSON locale in `bench/results/` (gitignored) e branch.

## Dove va
- Inserisci la voce dopo l'ultima voce numerata e prima di `## Diagnosi trasversale`.
- Aggiorna l'intestazione (baseline attuale, "in produzione") SOLO se la variante è adottata. Poi ricorda all'utente di aggiornare la baseline anche in `CLAUDE.md`.
- `## Conclusione` si tocca solo se l'utente lo chiede.

## Regole di contenuto
- Italiano, tono asciutto come le voci esistenti. Nessun dato inventato o arrotondato.
- Nessun video, fotogramma, percorso personale o dato sensibile. Gli ID dei video (es. IMG_6258) vanno bene.
- Se i risultati vengono da un'altra macchina, dichiaralo: non sono confrontabili con la baseline su Windows.
- Alla fine mostra il diff e chiedi l'ok per il commit.
