// Copies the WebAssembly runtimes into public/ so they are served as-is:
//  * LibRaw (spawns its own pthread workers relative to its own URL)
//  * MediaPipe vision tasks (subject / people selection for masks)
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const copy = (from, to, files) => {
  mkdirSync(to, { recursive: true });
  for (const f of files) cpSync(join(from, f), join(to, f));
};
copy(join(root, 'node_modules', 'libraw-wasm', 'dist'), join(root, 'public', 'libraw'), ['worker.js', 'libraw.js', 'libraw.wasm']);
copy(join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm'), join(root, 'public', 'mediapipe'), [
  'vision_wasm_internal.js',
  'vision_wasm_internal.wasm',
]);
console.log('libraw + mediapipe copied to public/');
