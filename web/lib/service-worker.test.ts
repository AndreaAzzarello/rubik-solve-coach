import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const SW_SOURCE = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'sw.js'),
  'utf8',
);
const ORIGIN = 'https://app.example';

type FakeResponse = { ok: boolean; status: number; tag: string; clone(): FakeResponse };
const response = (tag: string, status = 200): FakeResponse => ({
  ok: status >= 200 && status < 300,
  status,
  tag,
  clone() { return this; },
});

// Esegue public/sw.js in un contesto isolato con self, caches e fetch finti.
function loadServiceWorker(cachedUrls: Record<string, FakeResponse>) {
  const handlers: Record<string, (event: unknown) => void> = {};
  const puts: string[] = [];
  const fetched: string[] = [];
  const cache = { put: async (request: { url: string }) => { puts.push(request.url); }, addAll: async () => undefined };
  const context = {
    URL,
    self: {
      location: { origin: ORIGIN },
      addEventListener: (type: string, handler: (event: unknown) => void) => { handlers[type] = handler; },
      skipWaiting: () => undefined,
      clients: { claim: async () => undefined },
    },
    caches: {
      match: async (request: { url: string }) => cachedUrls[request.url],
      open: async () => cache,
      keys: async () => [],
      delete: async () => true,
    },
    fetch: async (request: { url: string }) => { fetched.push(request.url); return response(`rete:${request.url}`); },
  };
  vm.runInNewContext(SW_SOURCE, context);
  return {
    puts,
    fetched,
    async request(url: string, mode = 'no-cors') {
      let responded: Promise<FakeResponse> | undefined;
      handlers.fetch({
        request: { method: 'GET', url, mode },
        respondWith: (promise: Promise<FakeResponse>) => { responded = promise; },
        waitUntil: () => undefined,
      });
      return responded ? await responded : undefined;
    },
  };
}

test('i file di /mediapipe/ gia in cache si servono dalla cache senza toccare la rete', async () => {
  const url = `${ORIGIN}/mediapipe/wasm/vision_wasm_internal.wasm`;
  const sw = loadServiceWorker({ [url]: response('cache') });
  const result = await sw.request(url);
  assert.equal(result?.tag, 'cache');
  assert.deepEqual(sw.fetched, []);
});

test('un file di /mediapipe/ non in cache si scarica e si salva solo se la risposta e 200', async () => {
  const url = `${ORIGIN}/mediapipe/hand_landmarker.task`;
  const sw = loadServiceWorker({});
  const result = await sw.request(url);
  assert.equal(result?.tag, `rete:${url}`);
  assert.deepEqual(sw.fetched, [url]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sw.puts, [url]);
});

test('le altre risorse della stessa origine restano stale-while-revalidate', async () => {
  const url = `${ORIGIN}/models/cube-face-keypoints.onnx`;
  const sw = loadServiceWorker({ [url]: response('cache') });
  const result = await sw.request(url);
  assert.equal(result?.tag, 'cache');
  assert.deepEqual(sw.fetched, [url]);
});

test('le risorse di altre origini non vengono gestite ne messe in cache', async () => {
  const sw = loadServiceWorker({});
  const result = await sw.request('https://altro.example/mediapipe/hand_landmarker.task');
  assert.equal(result, undefined);
  assert.deepEqual(sw.fetched, []);
  assert.deepEqual(sw.puts, []);
});
