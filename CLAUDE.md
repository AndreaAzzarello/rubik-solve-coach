# rubik-solve-coach (CubeSolve Coach)

Analizza da un video la risoluzione di un cubo 3x3: ricostruisce lo stato iniziale, trascrive le mosse e le divide nelle fasi CFOP. Tutta la pipeline (decodifica video, rilevamento facce, ricostruzione, risoluzione) gira nel browser. Dettagli in `README.md`.

## Stack
- `web/`: Next.js + TypeScript (script `vinext`), pnpm. Unico codice vivo.
- Rilevamento facce: YOLOv8n-pose in ONNX con `onnxruntime-web` (`web/lib/face-keypoint-model.ts`).
- `web/vision/`: addestramento, dataset, eval del modello. `legacy-python/`: non mantenuto, non in CI.
- Build per Cloudflare Workers (`vinext` + `@cloudflare/vite-plugin`) e hosting OpenAI Sites (`@openai/sites-vite-plugin`, `web/.openai/hosting.json`). URL e passaggi di deploy reali non sono documentati nel repo: da completare, mai dedurli.
- Registro esperimenti: `web/docs/pipeline-experiments.md` (unico). Baseline attuale: 462/702 caselle, gruppo test 155/162.

## Comandi (dalla radice, PowerShell)
- `pnpm --dir web install`, `pnpm --dir web dev`, `pnpm --dir web build`
- `pnpm --dir web lint`, `pnpm --dir web test:inspection`
- `pnpm --dir web bench` (richiede video locali; `bench:setup` scarica Chrome for Testing)
- CI: `.github/workflows/ci.yml` (lint, type check, test, build di `web/`).

## Vincoli
- Non c'è backend.
- La repo è pubblica: tieni locali, fuori dai commit, i video di test, gli output di ispezione e i dati personali.
- Banco di prova deterministico: Chrome for Testing pinnato, WASM/modello locali, nessuna GPU.

## Bench ed esperimenti
- Un solo bench alla volta, anche tra worktree. Mai bench automatici o pianificati: si lanciano solo su richiesta esplicita.
- Output completo: bench, `test:inspection`, lint e tsc sono esclusi da RTK. Niente `tail`, pipe o riassunti che nascondano errori. Usa timeout con cleanup e nessun processo orfano.
- Porta 3100 se la 3000 è occupata. `BENCH_VIDEO_DIR` è obbligatoria: percorso locale della cartella dei video, mai nel repo.
- Una variante si adotta solo se supera il totale della baseline e nessun video test perde più di 5 caselle.
- Ogni esperimento nel registro unico: ipotesi, modifiche, metriche, conclusione. Prima di riprovare una direzione, controlla che non sia già stata scartata lì. Niente memoria parallela.

## Worktree (Orca)
Un compito per worktree, con branch dedicato. `pnpm install` in ogni worktree solo quando serve e approvato. Non modificare branch di altri compiti: ogni compito lavora solo nel proprio branch. Da non toccare ora: `main` durante gli esperimenti, `security/update-dependencies-2026-10` (da valutare a parte) e `feat/correction-repropagation-ui` (lavoro sospeso).

## Graphify
Grafo locale in `graphify-out/` (ignorato da git, solo codice). Consultalo (`graphify query/explain/path`) prima di esplorare i file per modifiche trasversali a `inspection-state.ts`, `video-decoder.ts`, `inspection-pipeline.ts`. Rigeneralo dopo refactoring grossi: `graphify extract . --code-only --force`. Esclusioni in `.graphifyignore`. Non è memoria di progetto.

## Privacy e rilascio
- Mai video personali, fotogrammi o dati sensibili nel repo (vale anche per i fotogrammi estratti e gli overlay).
- Prima di ogni rilascio: privacy, accessibilità, licenze/attribuzioni, risorse esterne (nessun dominio terzo a runtime).
- Dopo modifiche all'interfaccia, verifica con Playwright desktop e mobile prima di considerare finito.

## Finito quando
`pnpm --dir web lint`, `test:inspection` e `build` passano (come nella CI). Dichiara se non hai eseguito `bench`, che richiede video locali.

## Da non fare
- Lascia stare `legacy-python/` e non riportare in produzione il percorso geometrico: `geometric-sticker-detection.ts` è solo baseline.
- Non committare video, frame o modelli pesanti, salvo richiesta.

## Agent skills

### Issue tracker

GitHub Issues di AndreaAzzarello/rubik-solve-coach (CLI `gh`). Nessuna azione su GitHub senza ok esplicito. Vedi `docs/agents/issue-tracker.md`.

### Triage labels

Cinque etichette di default (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix), non ancora create sulla repo. Vedi `docs/agents/triage-labels.md`.

### Domain docs

Single-context. Vedi `docs/agents/domain.md`.
