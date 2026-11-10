// Percorso di un file statico di public/ rispettando il basePath dell'app.
// vinext inietta a build time `process.env.__NEXT_ROUTER_BASEPATH` dal
// `basePath` di next.config (vuoto se non impostato); `import.meta.env.BASE_URL`
// di Vite non e' usato da vinext. Con il deploy alla radice (Workers, OpenAI
// Sites) il risultato e' semplicemente `/<percorso>`.
export function assetUrl(path: string, basePath: string = process.env.__NEXT_ROUTER_BASEPATH ?? ''): string {
  const base = basePath.replace(/\/+$/, '');
  return `${base}/${path.replace(/^\/+/, '')}`;
}
