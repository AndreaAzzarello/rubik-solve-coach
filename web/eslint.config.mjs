import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Runtime Emscripten di MediaPipe servito da public/mediapipe: codice generato
  // da Google, non nostro. Lintarlo produce solo falsi positivi (require() del
  // loader, this-alias, "react-hooks" su _emscripten_glUseProgram).
  globalIgnores(['.next/**', 'out/**', 'build/**', 'next-env.d.ts', 'public/mediapipe/**']),
]);

export default eslintConfig;
