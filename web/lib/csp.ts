// CSP minima, applicata con un <meta> nel layout (vale per qualunque host:
// Workers, OpenAI Sites, dev server, senza dipendere dagli header di risposta).
//
// Solo connect-src: fetch/XHR/WebSocket/sendBeacon possono andare soltanto
// all'origine dell'app, a blob: (il video scelto) e a data:. Serve a bloccare la
// telemetria che MediaPipe tasks-vision 1.0.1 tenta di inviare a
// odml.pa.googleapis.com. Nessun'altra direttiva (script-src, worker-src, ...)
// per non rompere WASM e worker: la CSP completa e' un compito del redesign.
export const CONNECT_ONLY_CSP = "connect-src 'self' blob: data:";
