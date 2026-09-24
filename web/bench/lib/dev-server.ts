// Avvio del dev server dell'app (vinext) e attesa che sia pronto: estratto da
// bench/run-bench.ts (era locale li') perche' ora lo riusa anche
// vision/annotate, che ha bisogno della pipeline reale
// (reconstructInspectionFromVideo via /bench) per trovare la finestra di
// ispezione dei video, non solo il bench stesso.

import { spawn, type ChildProcess } from 'node:child_process';

export async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { method: 'GET' });
      if (response.ok || response.status === 404) return;
      lastError = `HTTP ${response.status}`;
    } catch (caught) {
      lastError = caught instanceof Error ? caught.message : String(caught);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`server non raggiungibile a ${url} entro ${timeoutMs}ms (${lastError})`);
}

export function startDevServer(
  webRoot: string,
  logPrefix = '[dev-server]',
  readyPath = '/bench',
): Promise<{ close: () => Promise<void>; baseUrl: string }> {
  const log = (...parts: unknown[]) => console.log(logPrefix, ...parts);
  const command = process.env.BENCH_SERVER_CMD || 'pnpm exec vinext dev';
  log(`avvio dev server: ${command}`);
  const child: ChildProcess = spawn(command, {
    cwd: webRoot,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, BROWSER: 'none' },
  });

  let resolved = false;
  const portPromise = new Promise<string>((resolve, reject) => {
    const onData = (buffer: Buffer) => {
      const text = buffer.toString();
      process.stdout.write(text.replace(/^/gm, '  | '));
      // vinext colora l'output: la porta arriva avvolta da sequenze ANSI
      // (es. "localhost:\x1b[1m3000\x1b[22m/"), quindi vanno rimosse prima.
      // Il carattere ESC (\x1b) va incluso nel match: rimuovere solo "[...m"
      // lascia l'ESC "nudo" incastrato fra ":" e la porta, che spezza la
      // regex dell'URL sotto - intermittente, dipende da come i chunk di
      // stdout si spezzano (visto dal vivo: bench bloccato 180s nonostante
      // il dev server fosse gia' pronto).
      const plain = text.replace(/\x1b\[[0-9;]*m/g, '');
      const match = /https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/.exec(plain);
      if (match && !resolved) {
        resolved = true;
        resolve(`http://localhost:${match[1]}`);
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('exit', (code) => {
      if (!resolved) reject(new Error(`il dev server e' uscito prima di essere pronto (codice ${code})`));
    });
    setTimeout(() => {
      if (!resolved) reject(new Error('nessun URL localhost dal dev server entro 180s'));
    }, 180000);
  });

  return portPromise.then(async (baseUrl) => {
    await waitForHttp(`${baseUrl}${readyPath}`, 120000);
    return {
      baseUrl,
      close: () => new Promise<void>((resolve) => {
        child.on('exit', () => resolve());
        // su Windows serve killare l'albero dei processi
        if (process.platform === 'win32' && child.pid) {
          spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { stdio: 'ignore' });
        } else {
          child.kill('SIGTERM');
        }
        setTimeout(resolve, 5000);
      }),
    };
  });
}
