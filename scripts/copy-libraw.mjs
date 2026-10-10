// Copies the LibRaw WebAssembly build into public/ so it is served as-is
// (it spawns its own pthread workers relative to its own URL).
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'libraw-wasm', 'dist');
const dest = join(root, 'public', 'libraw');
mkdirSync(dest, { recursive: true });
for (const f of ['worker.js', 'libraw.js', 'libraw.wasm']) {
  cpSync(join(src, f), join(dest, f));
}
console.log('libraw copied to public/libraw');
