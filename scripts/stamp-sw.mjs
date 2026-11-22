// After `vite build`: tells the service worker (dist/sw.js) what this build is made of, so it can
//  * save the app shell (page, icons, everything under assets/) ahead of time, and
//  * tell one build from the next, and one set of WebAssembly runtimes from the next.
// Never fails the build: without it the worker just saves files as they're used.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// (another folder can be given, for trying this out on a copy)
const dist = process.argv[2] ? resolve(process.argv[2]) : join(root, 'dist');

const walk = (dir) =>
  !existsSync(dir) ? [] : readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))
    .sort();
const rel = (f) => relative(dist, f).split(sep).join('/');
/** A short fingerprint of some files: their names and contents. */
const digest = (files) => {
  const h = createHash('sha256');
  for (const f of files) h.update(rel(f) + '\n').update(readFileSync(f));
  return h.digest('hex').slice(0, 12);
};

try {
  const sw = join(dist, 'sw.js');
  let src = readFileSync(sw, 'utf8');
  const top = ['index.html', 'manifest.webmanifest', 'icon.svg', 'icon-180.png', 'icon-192.png', 'icon-512.png']
    .map((f) => join(dist, f)).filter((f) => existsSync(f));
  const shell = [...top, ...walk(join(dist, 'assets'))];
  // the big runtimes are not fetched ahead (tens of MB): they only name their own cache
  const runtimes = ['libraw', 'mediapipe', 'ort', 'models'].flatMap((d) => walk(join(dist, d)));
  // the page is saved under the app's own address, the rest under their paths
  const list = shell.map(rel).map((p) => (p === 'index.html' ? './' : p));
  const values = {
    "'__BUILD__'": JSON.stringify(digest(shell)),
    "'__RUNTIMES__'": JSON.stringify(digest(runtimes)),
    '/*__PRECACHE__*/': list.map((p) => JSON.stringify(p)).join(', '),
  };
  for (const [mark, value] of Object.entries(values)) {
    if (!src.includes(mark)) throw new Error(`"${mark}" not found in sw.js`);
    src = src.replace(mark, () => value);
  }
  writeFileSync(sw, src);
  console.log(`service worker: ${list.length} shell files, build ${values["'__BUILD__'"]}, runtimes ${values["'__RUNTIMES__'"]}`);
} catch (e) {
  console.warn('service worker not stamped (it will cache files as they are used):', e.message);
}
