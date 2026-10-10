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
  build: { target: 'es2021', assetsInlineLimit: 0 },
});
