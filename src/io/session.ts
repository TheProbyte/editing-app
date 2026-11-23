// Autosave: keeps the last photo and its edits in IndexedDB so reopening the app
// (or iOS reloading a backgrounded tab) picks up where you left off.

interface Saved {
  file: Blob;
  name: string;
  type: string;
  state: string;
  ts: number;
}

/** One connection for the whole session (opened on first use, again if the browser closes it). */
let dbp: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  const p = new Promise<IDBDatabase>((res, rej) => {
    const r = indexedDB.open('lumen', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => {
      const d = r.result;
      const drop = () => {
        if (dbp === p) dbp = null;
      };
      d.onclose = drop;
      d.onversionchange = () => {
        d.close();
        drop();
      };
      res(d);
    };
    r.onerror = () => rej(r.error);
  });
  dbp = p;
  p.catch(() => {
    if (dbp === p) dbp = null;
  });
  return p;
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((res, rej) => {
    let t: IDBTransaction;
    try {
      t = d.transaction('kv', mode);
    } catch (e) {
      // the connection went away: open a new one next time
      dbp = null;
      rej(e);
      return;
    }
    const req = fn(t.objectStore('kv'));
    // done only once the transaction commits: a file that doesn't fit (quota) fails there, as an
    // abort, after its request has already "succeeded"
    t.oncomplete = () => res(req.result);
    t.onabort = t.onerror = () => rej(t.error ?? req.error ?? new Error('storage transaction failed'));
  });
}

// The photo and its edit are kept under separate keys: the edit is saved after every change, and
// writing it must not write the (large) photo again each time.
const STATE_KEY = 'session:state';

export async function saveFile(file: File) {
  try {
    const s: Saved = { file, name: file.name, type: file.type, state: '', ts: Date.now() };
    await tx('readwrite', (st) => {
      st.put('', STATE_KEY);
      return st.put(s, 'session');
    });
  } catch {
    /* storage unavailable (private mode, quota) — autosave is best effort */
  }
}

export async function saveState(state: string) {
  try {
    await tx('readwrite', (st) => st.put(state, STATE_KEY));
  } catch {
    /* best effort */
  }
}

export async function loadSession(): Promise<{ file: File; state: string } | null> {
  try {
    const s = await tx<Saved | undefined>('readonly', (st) => st.get('session'));
    if (!s || !s.file) return null;
    // (an autosave from before the edit had its own key carries it inside the record)
    const state = await tx<string | undefined>('readonly', (st) => st.get(STATE_KEY));
    return { file: new File([s.file], s.name, { type: s.type }), state: typeof state === 'string' ? state : s.state ?? '' };
  } catch {
    return null;
  }
}

/** Extra photos used by an edit (double exposure), kept on the device by id. */
export async function saveBlob(key: string, blob: Blob) {
  try {
    fresh.add('blob:' + key);
    await tx('readwrite', (st) => st.put(blob, 'blob:' + key));
  } catch {
    /* best effort */
  }
}

export async function loadBlob(key: string): Promise<Blob | null> {
  try {
    return ((await tx<Blob | undefined>('readonly', (st) => st.get('blob:' + key))) ?? null);
  } catch {
    return null;
  }
}

// ---- recent projects: the last few photos and videos with their edits, for the home screen.
// Files are stored once each (by name, size and date), shared between projects that use them.

export interface RecentFile {
  /** media id inside the project (videos) */
  id: string;
  key: string;
  name: string;
  type: string;
  /** bytes (saved since storage sizes are shown; older entries are measured when asked) */
  size?: number;
}
export interface Recent {
  id: string;
  kind: 'photo' | 'video';
  name: string;
  ts: number;
  thumb: Blob | null;
  /** the edit (JSON), as history stores it */
  state: string;
  files: RecentFile[];
}

const RECENT_MAX = 8;
const fileKey = (f: File) => `${f.name}|${f.size}|${f.lastModified}`;
/** Keys written since the app started: the clean-up below never touches these. */
const fresh = new Set<string>();
/** Files that didn't fit on the device: not tried again this session (a video can be gigabytes to copy). */
const tooBig = new Set<string>();
/** putRecent calls in flight, and the clean-up while it runs: they wait for each other. */
let writers = 0;
let sweeping: Promise<void> | null = null;
let askedPersist = false;

/** False when the browser says this many bytes clearly won't fit in the app's storage. */
async function fits(bytes: number) {
  try {
    const { quota, usage } = await navigator.storage.estimate();
    return !quota || bytes < (quota - (usage ?? 0)) * 0.9;
  } catch {
    return true;
  }
}

/** Ask the browser not to clear the app's storage (projects, downloaded models) when space runs low. */
function keepStorage() {
  if (askedPersist) return;
  askedPersist = true;
  try {
    void navigator.storage.persist().catch(() => {});
  } catch {
    /* not supported */
  }
}

export async function listRecents(): Promise<Recent[]> {
  try {
    return ((await tx<Recent[] | undefined>('readonly', (st) => st.get('recent:list'))) ?? []).sort((a, b) => b.ts - a.ts);
  } catch {
    return [];
  }
}

/** Remember (or update) a project. `files` = what it's made from (stored if they're new). */
export async function putRecent(r: Omit<Recent, 'files'>, files: { id: string; file: File }[] | null) {
  writers++;
  try {
    if (sweeping) await sweeping;
    const list = await listRecents();
    const old = list.find((x) => x.id === r.id);
    let metas = old?.files ?? [];
    if (files) {
      metas = [];
      for (const { id, file } of files) {
        const key = fileKey(file);
        // a project is only remembered whole: if a file can't be kept, the list stays as it was
        if (tooBig.has(key)) throw new Error('no room for ' + file.name);
        const have = await tx<number>('readonly', (st) => st.count('rfile:' + key));
        if (!have) {
          fresh.add('rfile:' + key);
          try {
            if (!(await fits(file.size))) throw new Error('no room for ' + file.name);
            await tx('readwrite', (st) => st.put(file, 'rfile:' + key));
          } catch (e) {
            tooBig.add(key);
            throw e;
          }
        }
        metas.push({ id, key, name: file.name, type: file.type, size: file.size });
      }
    }
    let next = [{ ...r, files: metas }, ...list.filter((x) => x.id !== r.id)].slice(0, RECENT_MAX);
    // over the size limit set in Storage: the oldest projects go first (never this one)
    const cap = recentCap();
    if (cap) {
      while (next.length > 1 && (await bytesOf(next)) > cap) next = next.slice(0, -1);
    }
    await tx('readwrite', (st) => st.put(next, 'recent:list'));
    keepStorage();
    // files no project uses any more
    const used = new Set(next.flatMap((x) => x.files.map((f) => f.key)));
    for (const x of [...list, ...(old ? [old] : [])]) for (const f of x.files) if (!used.has(f.key)) await tx('readwrite', (st) => st.delete('rfile:' + f.key));
  } catch (e) {
    console.warn('recent projects: not saved', e);
  } finally {
    writers--;
  }
}

// ---- storage sizes (the Storage sheet)

/** The most the recent projects may take up, in bytes (0: no limit but the device's). */
export function recentCap() {
  try {
    return Math.max(0, Number(localStorage.getItem('lumen.recentCap') ?? 0) || 0);
  } catch {
    return 0;
  }
}
export function setRecentCap(bytes: number) {
  try {
    localStorage.setItem('lumen.recentCap', String(Math.max(0, Math.round(bytes))));
  } catch {
    /* private mode */
  }
}

/** A stored file's size (measured, without reading it, for entries saved before sizes were kept). */
async function sizeOf(f: RecentFile) {
  if (typeof f.size === 'number') return f.size;
  try {
    return (await tx<Blob | undefined>('readonly', (st) => st.get('rfile:' + f.key)))?.size ?? 0;
  } catch {
    return 0;
  }
}

/** Bytes the files of these projects take (a file two projects share counts once). */
async function bytesOf(list: Recent[]) {
  const seen = new Map<string, RecentFile>();
  for (const r of list) for (const f of r.files) seen.set(f.key, f);
  let n = 0;
  for (const f of seen.values()) n += await sizeOf(f);
  return n;
}

export interface StorageReport {
  /** each recent project and what its files take (shared files counted in each) */
  projects: { id: string; kind: Recent['kind']; name: string; ts: number; bytes: number }[];
  /** all recent projects together (shared files once) */
  projectBytes: number;
  /** AI models the app downloaded (kept for offline use) */
  modelBytes: number;
  models: { name: string; bytes: number }[];
  /** everything the app stores, and what the browser allows (0 = unknown) */
  usage: number;
  quota: number;
  persisted: boolean;
}

/** The cache the app's downloaded AI models live in (see src/ai/segment.ts). */
const MODEL_CACHE = 'lumen-models-v1';

export async function storageReport(): Promise<StorageReport> {
  const list = await listRecents();
  const projects = [];
  for (const r of list) {
    let b = 0;
    for (const f of r.files) b += await sizeOf(f);
    projects.push({ id: r.id, kind: r.kind, name: r.name, ts: r.ts, bytes: b });
  }
  const models: StorageReport['models'] = [];
  try {
    if (await caches.has(MODEL_CACHE)) {
      const c = await caches.open(MODEL_CACHE);
      for (const req of await c.keys()) {
        const res = await c.match(req);
        const n = Number(res?.headers.get('content-length') ?? 0) || (res ? (await res.blob()).size : 0);
        models.push({ name: modelName(req.url), bytes: n });
      }
    }
  } catch {
    /* no cache storage */
  }
  let usage = 0, quota = 0, persisted = false;
  try {
    const e = await navigator.storage.estimate();
    usage = e.usage ?? 0;
    quota = e.quota ?? 0;
    persisted = await navigator.storage.persisted();
  } catch {
    /* not supported */
  }
  return { projects, projectBytes: await bytesOf(list), models, modelBytes: models.reduce((a, m) => a + m.bytes, 0), usage, quota, persisted };
}

/** What a downloaded model is for, in words. */
function modelName(url: string) {
  const u = url.toLowerCase();
  if (u.includes('depth')) return 'Depth (lens blur)';
  if (u.includes('lama')) return 'LaMa (best AI fill)';
  if (u.includes('interactive') || u.includes('magic_touch')) return 'Subject masks';
  if (u.includes('selfie') || u.includes('multiclass')) return 'People masks';
  if (u.includes('whisper')) return 'Captions';
  return decodeURIComponent(new URL(url).pathname.split('/').pop() ?? url);
}

/** Forget the downloaded AI models (they download again the next time they're needed). */
export async function clearModels() {
  try {
    await caches.delete(MODEL_CACHE);
  } catch {
    /* best effort */
  }
}

/** Forget every recent project and its stored files. */
export async function clearRecents() {
  try {
    const list = await listRecents();
    await tx('readwrite', (st) => st.put([], 'recent:list'));
    const keys = new Set(list.flatMap((r) => r.files.map((f) => 'rfile:' + f.key)));
    for (const k of keys) await tx('readwrite', (st) => st.delete(k));
  } catch {
    /* best effort */
  }
}

/** Apply the size limit now (after it's lowered): the oldest projects go. */
export async function trimRecents() {
  const cap = recentCap();
  if (!cap) return;
  const list = await listRecents();
  let next = list;
  while (next.length > 1 && (await bytesOf(next)) > cap) next = next.slice(0, -1);
  for (const r of list.slice(next.length)) await dropRecent(r.id);
}

/** Only the edit / thumbnail changed (cheap: files untouched). */
export async function touchRecent(id: string, patch: Partial<Pick<Recent, 'state' | 'thumb' | 'name'>>) {
  try {
    const list = await listRecents();
    const r = list.find((x) => x.id === id);
    if (!r) return;
    Object.assign(r, patch, { ts: Date.now() });
    await tx('readwrite', (st) => st.put(list, 'recent:list'));
  } catch {
    /* best effort */
  }
}

export async function recentFiles(r: Recent): Promise<{ id: string; file: File }[] | null> {
  try {
    const out: { id: string; file: File }[] = [];
    for (const f of r.files) {
      const b = await tx<Blob | undefined>('readonly', (st) => st.get('rfile:' + f.key));
      if (!b) return null;
      out.push({ id: f.id, file: new File([b], f.name, { type: f.type }) });
    }
    return out;
  } catch {
    return null;
  }
}

export async function dropRecent(id: string) {
  try {
    const list = await listRecents();
    const gone = list.find((x) => x.id === id);
    const next = list.filter((x) => x.id !== id);
    await tx('readwrite', (st) => st.put(next, 'recent:list'));
    const used = new Set(next.flatMap((x) => x.files.map((f) => f.key)));
    for (const f of gone?.files ?? []) if (!used.has(f.key)) await tx('readwrite', (st) => st.delete('rfile:' + f.key));
  } catch {
    /* best effort */
  }
}

/**
 * Clean-up, once after launch: stored files no recent project lists any more (left behind if the
 * app was closed mid-save) and double-exposure photos no edit refers to. `liveState` is the edit
 * on screen (JSON), so what it uses stays. Careful by design: if anything can't be read, or a
 * project is being saved right now, nothing is deleted.
 */
export function sweepStorage(liveState = ''): Promise<void> {
  if (writers || sweeping) return sweeping ?? Promise.resolve();
  const p = (async () => {
    try {
      const keys = await tx<IDBValidKey[]>('readonly', (st) => st.getAllKeys());
      const list = (await tx<Recent[] | undefined>('readonly', (st) => st.get('recent:list'))) ?? [];
      const session = await tx<Saved | undefined>('readonly', (st) => st.get('session'));
      const state = await tx<string | undefined>('readonly', (st) => st.get(STATE_KEY));
      if (!Array.isArray(list) || list.some((r) => !r || !Array.isArray(r.files))) return;
      const used = new Set(list.flatMap((r) => r.files.map((f) => 'rfile:' + f.key)));
      // every edit that could name a double-exposure photo, as text: an id found anywhere in it counts
      const edits = [liveState, state, session?.state, ...list.map((r) => r.state)].filter((x) => typeof x === 'string').join('\n');
      const dead = keys.filter((k): k is string => {
        if (typeof k !== 'string' || fresh.has(k)) return false;
        if (k.startsWith('rfile:')) return !used.has(k);
        if (k.startsWith('blob:ov:')) return !edits.includes(k.slice(8));
        return false;
      });
      if (!dead.length) return;
      await tx('readwrite', (st) => {
        let last!: IDBRequest<undefined>;
        for (const k of dead) last = st.delete(k);
        return last;
      });
    } catch {
      /* best effort */
    }
  })();
  sweeping = p;
  void p.then(() => {
    if (sweeping === p) sweeping = null;
  });
  return p;
}
