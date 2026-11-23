// Imported 3D LUTs (.cube files, the format Lightroom, Resolve, Premiere and most LUT packs use).
// Each one becomes a look: the colors are mapped through the table, with a strength. They're kept
// on the device (IndexedDB) and read once at start, so the renderer can use them right away.
import { kvDel, kvGet, kvPut } from './session';

export interface Cube {
  id: number;
  name: string;
  /** points per side */
  size: number;
  /** RGB, red changing fastest (the .cube order), 0..1 */
  data: Float32Array;
}

const LIST = 'cube:list';
/** largest table accepted (65³ is the usual "high quality" size; bigger ones are rare and huge) */
const MAX_SIZE = 65;
const cubes = new Map<number, Cube>();
let loading: Promise<void> | null = null;

export const cubeById = (id: number) => cubes.get(id);
export const cubeList = () => [...cubes.values()];

/** Read the saved LUTs (once). */
export function loadCubes(): Promise<void> {
  loading ??= (async () => {
    const list = ((await kvGet<{ id: number; name: string; size: number }[]>(LIST)) ?? []).filter((c) => c && typeof c.id === 'number');
    for (const c of list) {
      const buf = await kvGet<ArrayBuffer>('cube:' + c.id);
      if (buf && buf.byteLength === c.size ** 3 * 12) cubes.set(c.id, { ...c, data: new Float32Array(buf) });
    }
  })().catch(() => {});
  return loading;
}

/** Parse a .cube file. Throws with a message for the user when it isn't one we can use. */
export function parseCube(text: string, fallbackName: string): Omit<Cube, 'id'> {
  let size = 0, title = '';
  let min = [0, 0, 0], max = [1, 1, 1];
  const vals: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const c = line.charCodeAt(0);
    // numbers: a row of the table
    if ((c >= 48 && c <= 57) || c === 45 || c === 46 || c === 43) {
      const parts = line.split(/\s+/);
      if (parts.length < 3) continue;
      vals.push(+parts[0], +parts[1], +parts[2]);
      continue;
    }
    const [key, ...rest] = line.split(/\s+/);
    const k = key.toUpperCase();
    if (k === 'TITLE') title = rest.join(' ').replace(/^"|"$/g, '');
    else if (k === 'LUT_3D_SIZE') size = Math.round(+rest[0]);
    else if (k === 'LUT_1D_SIZE') throw new Error('That’s a 1D LUT (curves only): Lumen takes 3D .cube LUTs');
    else if (k === 'DOMAIN_MIN') min = rest.slice(0, 3).map(Number);
    else if (k === 'DOMAIN_MAX') max = rest.slice(0, 3).map(Number);
  }
  if (!size) throw new Error('Not a 3D .cube LUT (no LUT_3D_SIZE)');
  if (size < 2 || size > MAX_SIZE) throw new Error(`LUTs up to ${MAX_SIZE}×${MAX_SIZE}×${MAX_SIZE} are supported (this one is ${size})`);
  const n = size ** 3 * 3;
  if (vals.length < n) throw new Error('The LUT is cut short (fewer rows than its size says)');
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const ch = i % 3, x = vals[i];
    if (!Number.isFinite(x)) throw new Error('The LUT has a value that isn’t a number');
    // stored relative to its domain, so the renderer can always read it as 0..1
    data[i] = (x - min[ch]) / Math.max(1e-6, max[ch] - min[ch]);
  }
  const name = (title || fallbackName.replace(/\.cube$/i, '')).trim().slice(0, 28) || 'LUT';
  return { name, size, data };
}

async function saveList() {
  await kvPut(LIST, cubeList().map(({ id, name, size }) => ({ id, name, size })));
}

/** Import a .cube file and keep it on the device. */
export async function addCube(file: File): Promise<Cube> {
  if (file.size > 40e6) throw new Error('That file is too big to be a LUT');
  const c = parseCube(await file.text(), file.name);
  // ids are small whole numbers (they live in the edit's settings, like any slider)
  let id = 1;
  while (cubes.has(id)) id++;
  const cube = { ...c, id };
  await kvPut('cube:' + id, cube.data.buffer.slice(0) as ArrayBuffer);
  cubes.set(id, cube);
  try {
    await saveList();
  } catch (e) {
    cubes.delete(id);
    throw e;
  }
  return cube;
}

export async function removeCube(id: number) {
  cubes.delete(id);
  await saveList().catch(() => {});
  await kvDel('cube:' + id).catch(() => {});
}
