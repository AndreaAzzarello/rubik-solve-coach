#!/usr/bin/env node
// PreToolUse (Bash|PowerShell): blocca git add / git commit che metterebbero nel
// repo pubblico video, frame, risultati di bench o percorsi personali. Exit 2 = blocco.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const VIDEO = /\.(mp4|mov|avi|mkv|webm)$/i;
// Qualunque file in queste cartelle (percorsi relativi alla radice, con o senza "web/").
const BLOCKED_DIRS = [
  'vision/annotate/frames/',
  'vision/annotate/labels/',
  'vision/dataset/output/',
  'vision/eval/real-preview/',
  'vision/eval/real-finetune-eval/',
  'bench/debug-grids/',
  'bench/results/',
  'bench/.cache/',
];
// Costruito a pezzi: lo script non deve contenere il percorso che cerca.
const U = 'Us' + 'ers';
const PERSONAL = new RegExp(`[A-Za-z]:[\\\\/]${U}[\\\\/]|(^|[^A-Za-z0-9_.])/${U}/`);
// Riconosce anche il comando riscritto da RTK: "rtk git ...", "rtk proxy git ...".
const GIT_CMD = /^(?:rtk\s+(?:proxy\s+|bypass\s+)?)?git\s+((?:(?:-[Cc]\s+\S+|--[\w-]+(?:=\S+)?)\s+)*)(add|commit)\b(.*)$/;
// Cambi di cartella dentro lo stesso comando (bash e PowerShell): il dry-run deve partire da lì.
const CD_CMD = /^(?:cd|pushd|Set-Location|sl)\s+(?:-(?:Path|LiteralPath)\s+)?(.+)$/i;
const MAX_SCAN = 2 * 1024 * 1024;

let cmd, cwd;
try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  cmd = input.tool_input?.command ?? '';
  cwd = input.cwd || process.cwd();
} catch {
  process.exit(0); // input illeggibile: non è un git add/commit riconoscibile
}

const unquote = (s) => s.trim().replace(/^["']|["']$/g, '');
let cur = cwd;
const jobs = [];
for (const seg of cmd.split(/&&|\|\||[;|\n]/).map((s) => s.trim())) {
  const c = CD_CMD.exec(seg);
  if (c) { cur = resolve(cur, unquote(c[1])); continue; }
  const m = GIT_CMD.exec(seg);
  if (!m) continue;
  const dash = /-C\s+("[^"]+"|'[^']+'|\S+)/.exec(m[1]);
  jobs.push({ kind: m[2], args: tokenize(m[3]), cwd: dash ? resolve(cur, unquote(dash[1])) : cur });
}
if (jobs.length === 0) process.exit(0);

try {
  const bad = new Map(); // percorso -> motivi
  let stagedCode = false;
  let isCommit = false;
  const roots = new Map(); // cartella -> { root, tracked }
  const ctx = (dir) => {
    if (!roots.has(dir)) {
      const root = git(['rev-parse', '--show-toplevel'], { cwd: dir }).stdout.trim();
      if (!root) throw new Error(`non è un repo git: ${dir}`);
      roots.set(dir, { root, tracked: new Set(git(['ls-files', '-z'], { cwd: root }).stdout.split('\0').filter(Boolean)) });
    }
    return roots.get(dir);
  };
  let lastRoot = null;

  for (const job of jobs) {
    const { root, tracked } = ctx(job.cwd);
    lastRoot = root;
    let names = [];
    let addedByFile = new Map();
    if (job.kind === 'add') {
      if (job.args.some((a) => /^(-p|-i|--patch|--interactive)$/.test(a))) continue; // interattivo: non analizzabile
      const r = git(['add', '--dry-run', ...job.args], { cwd: job.cwd });
      if (r.status !== 0) continue; // git fallirà da solo
      // git add --dry-run stampa già i percorsi relativi alla radice del repo
      names = [...r.stdout.matchAll(/^add '(.*)'$/gm)].map((m) => m[1].replace(/\\/g, '/'));
      const tr = names.filter((n) => tracked.has(n));
      if (tr.length) {
        addedByFile = parseAdded(git(['diff', '-U0', '--no-color', '--no-ext-diff', '--pathspec-from-file=-', '--pathspec-file-nul'], { cwd: root, input: tr.join('\0') }).stdout);
      }
      for (const n of names.filter((n) => !tracked.has(n))) addedByFile.set(n, readNew(join(root, n)));
    } else {
      isCommit = true;
      const all = job.args.some((a) => a === '--all' || (/^-[a-zA-Z]+$/.test(a) && a.includes('a')));
      const base = all ? ['diff', 'HEAD'] : ['diff', '--cached'];
      names = git([...base, '--name-only', '--diff-filter=ACMR', '-z'], { cwd: root }).stdout.split('\0').filter(Boolean);
      addedByFile = parseAdded(git([...base, '-U0', '--no-color', '--no-ext-diff'], { cwd: root }).stdout);
      if (names.some((n) => /\.tsx?$/.test(n))) stagedCode = true;
    }
    for (const n of names) {
      const p = n.replace(/\\/g, '/');
      const why = [];
      if (VIDEO.test(p)) why.push('video');
      const dir = BLOCKED_DIRS.find((d) => ('/' + p).includes('/' + d) || ('/' + p).includes('/web/' + d));
      if (dir) why.push(`file in ${dir}`);
      if ((addedByFile.get(n) ?? []).some((l) => PERSONAL.test(l))) why.push('percorso personale in una riga aggiunta');
      if (why.length) bad.set(p, [...(bad.get(p) ?? []), ...why]);
    }
  }

  if (bad.size) {
    const list = [...bad].map(([p, w]) => `  - ${p}: ${[...new Set(w)].join(', ')}`).join('\n');
    block(`BLOCCATO (guard-staging): la repo è pubblica, questi file non vanno committati:\n${list}\nTogli dallo staging con: git restore --staged <file> (o evita il comando add).`);
  }

  if (isCommit && stagedCode) {
    const root = lastRoot;
    const tsc = join(root, 'web', 'node_modules', 'typescript', 'bin', 'tsc');
    if (!existsSync(tsc)) {
      console.error('guard-staging: tsc non installato in questo worktree, type-check saltato.');
    } else {
      const t = spawnSync(process.execPath, [tsc, '--noEmit', '-p', 'web/tsconfig.json'], { cwd: root, encoding: 'utf8', timeout: 100000 });
      if (t.error) console.error(`guard-staging: type-check non completato (${t.error.code ?? t.error.message}), saltato.`);
      else if (t.status !== 0) block(`BLOCCATO (guard-staging): tsc --noEmit fallisce (exit ${t.status}):\n${(t.stdout + t.stderr).slice(0, 4000)}`);
    }
  }
} catch (e) {
  block(`BLOCCATO (guard-staging): errore interno, controllo non riuscito: ${e.message}`);
}
process.exit(0);

function git(args, opts = {}) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
}
function tokenize(s) {
  return [...s.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}
function parseAdded(diff) {
  const out = new Map();
  let file = null;
  for (const l of diff.split('\n')) {
    if (l.startsWith('+++ ')) {
      file = l.startsWith('+++ b/') ? l.slice(6) : null;
      if (file) out.set(file, []);
    } else if (file && l.startsWith('+')) out.get(file).push(l.slice(1));
  }
  return out;
}
function readNew(path) {
  try {
    if (statSync(path).size > MAX_SCAN) return [];
    const buf = readFileSync(path);
    return buf.includes(0) ? [] : buf.toString('utf8').split('\n');
  } catch {
    return [];
  }
}
function block(msg) {
  console.error(msg);
  process.exit(2);
}
