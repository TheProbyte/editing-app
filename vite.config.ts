import { defineConfig } from 'vite';

// The RAW decoder (LibRaw compiled to WebAssembly with threads) needs
// SharedArrayBuffer, which browsers only allow on cross-origin isolated pages.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  base: './',
  server: { headers: isolation },
  preview: { headers: isolation },
  // ONNX Runtime Web: use the build that loads its WebAssembly from public/ort (see neuralWorker.ts)
  // instead of bundling a second copy of the 14 MB runtime into assets/.
  resolve: { conditions: ['onnxruntime-web-use-extern-wasm'] },
  worker: { format: 'es' },
  build: { target: 'es2021', assetsInlineLimit: 0 },
});
