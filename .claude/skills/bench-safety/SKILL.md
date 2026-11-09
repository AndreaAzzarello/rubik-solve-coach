---
name: bench-safety
description: Regole obbligatorie prima, durante e dopo qualunque esecuzione che avvia dev server + Chromium: bench/run-bench.ts, window-sensitivity.ts, beam-*, debug-grids, sticker-areas, missing-cells-diagnosis, profile-phases, correction-*. Usala prima di lanciare un bench o uno script di diagnostica, non per leggere risultati già salvati.
---

# bench-safety

## Autorizzazione
- Lancia un bench solo se l'utente lo chiede esplicitamente nel messaggio corrente. Una conferma vale per UN run.
- Vale anche per il bench completo (13 video): serve una richiesta esplicita nel messaggio corrente, non basta averlo detto prima.
- Mai bench in loop, pianificati, in hook o in subagenti.
- Un solo bench alla volta, anche tra worktree.

## Dati
- I video del bench sono personali: mai in test, screenshot o fixture, mai nel repo.
- I video del gruppo test (6258, 6260, 6281) e lo split "test" non si usano mai per il training.

## Prima di lanciare (PowerShell, sola lettura)
1. Altri bench attivi? Se la query restituisce qualcosa, FERMATI e riportalo:
   `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -match 'run-bench|window-sensitivity|vinext dev|chrome-for-testing|bench[\\/][\w-]+\.ts' } | Select-Object ProcessId,Name,CommandLine`
2. Porte: `Get-NetTCPConnection -State Listen -LocalPort 3000,3100 -ErrorAction SilentlyContinue`. Se la 3000 è occupata: `BENCH_SERVER_CMD="pnpm exec vinext dev -p 3100"`. Se anche la 3100 è occupata, fermati.
3. `node_modules` del worktree: `pnpm exec` può reinstallare le dipendenze se `package.json` non corrisponde. Se serve `pnpm install`, chiedilo all'utente prima.
4. `BENCH_VIDEO_DIR` come in CLAUDE.md (sezione Worktree/Bench). Non scrivere percorsi personali in file del repo.
5. Riproducibilità: annota `git branch --show-current`, `git rev-parse HEAD` e `git status --short`. L'albero deve essere pulito, oppure dichiara le modifiche presenti. Riporta questi tre dati nel report. Un esperimento gira solo nel proprio branch/worktree.

## Esecuzione
- Dalla radice: `pnpm --dir web bench [CASO]` oppure `node --experimental-strip-types web/bench/<script>.ts`.
- Timeout esplicito: la baseline dura ~2 min, ma le varianti possono richiedere molto di più (#19: ~71 min). Per run lunghi usa `run_in_background` con timeout adeguato e leggi l'output INTERO a fine run.
- Vietati `| tail`, `| head`, `| grep`, `2>&1 | ...`, riassunti che nascondano errori: l'output completo è la prova. Riporta il codice di uscita originale.

## Dopo (anche su errore o timeout)
- Riesegui la query del punto 1 e le porte: nessun `vinext`, `node` del bench o Chromium residuo.
- Termina solo processi che hai avviato tu, per PID: `taskkill /PID <pid> /T /F`. Non toccare il dev server dell'utente.

## Risultati
- `web/bench/results/` è gitignored: mai committarlo; nessun video, fotogramma o percorso personale in report o note.
- Riporta numeri esatti: totale /702, gruppo test, per video, più branch, commit e stato dell'albero. Confronta con la baseline in `web/docs/pipeline-experiments.md`.
- Confrontabilità: la baseline (462/702) vale su Windows. I risultati di macchine diverse non sono confrontabili tra loro (esperimento #20: la finestra di ispezione è fragile e Mac e Windows divergono a parità di codice).
- Adozione: totale sopra la baseline E nessun video test peggiora di oltre 5 caselle. Dichiara ciò che non hai misurato.
- Registra l'esperimento con la skill `log-experiment`.
