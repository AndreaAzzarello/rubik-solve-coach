// Server statico locale con supporto Range + CORS: indispensabile per il seek
// di <video> e per non "sporcare" (taint) il canvas quando si legge un file
// locale da un browser Playwright con un'origine diversa da file://.
//
// Estratto da bench/run-bench.ts (era "startVideoServer", uso identico) per
// essere riusato anche da vision/eval, che serve immagini invece di video.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

export function startStaticServer(dir: string): Promise<{ close: () => void; port: number }> {
  const root = path.resolve(dir);
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '');
    const baseHeaders: Record<string, string | number> = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'range',
      'Accept-Ranges': 'bytes',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, baseHeaders).end();
      return;
    }
    const filePath = path.join(root, name);
    if (!filePath.startsWith(root)) {
      res.writeHead(403, baseHeaders).end('forbidden');
      return;
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      res.writeHead(404, baseHeaders).end('not found');
      return;
    }
    const total = stat.size;
    const ext = path.extname(name).toLowerCase();
    const headers: Record<string, string | number> = {
      ...baseHeaders,
      'Content-Type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
    };
    const range = req.headers.range;
    let start = 0;
    let end = total - 1;
    let status = 200;
    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(range);
      start = match && match[1] ? parseInt(match[1], 10) : 0;
      end = match && match[2] ? parseInt(match[2], 10) : total - 1;
      if (!Number.isFinite(start) || start < 0) start = 0;
      if (!Number.isFinite(end) || end >= total) end = total - 1;
      if (start > end) {
        res.writeHead(416, { ...headers, 'Content-Range': `bytes */${total}` }).end();
        return;
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
    }
    headers['Content-Length'] = end - start + 1;

    if (req.method === 'HEAD') {
      res.writeHead(status, headers).end();
      return;
    }

    // Chrome interrompe di continuo le richieste range durante il seek: se lo
    // stream o la connessione cadono, chiudiamo pulito senza far crashare il
    // server e senza mandare una risposta malformata al browser.
    const stream = fs.createReadStream(filePath, { start, end });
    const abort = () => stream.destroy();
    res.on('close', abort);
    stream.on('error', () => {
      res.off('close', abort);
      if (!res.headersSent) res.writeHead(500, baseHeaders);
      res.end();
    });
    res.writeHead(status, headers);
    stream.pipe(res);
  });
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ close: () => server.close(), port });
    });
  });
}
