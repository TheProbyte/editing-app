// Autosave: keeps the last photo and its edits in IndexedDB so reopening the app
// (or iOS reloading a backgrounded tab) picks up where you left off.

interface Saved {
  file: Blob;
  name: string;
  type: string;
  state: string;
  ts: number;
}

function db(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open('lumen', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction('kv', mode);
    const req = fn(t.objectStore('kv'));
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

export async function saveFile(file: File) {
  try {
    const s: Saved = { file, name: file.name, type: file.type, state: '', ts: Date.now() };
    await tx('readwrite', (st) => st.put(s, 'session'));
  } catch {
    /* storage unavailable (private mode, quota) — autosave is best effort */
  }
}

export async function saveState(state: string) {
  try {
    const s = await tx<Saved | undefined>('readonly', (st) => st.get('session'));
    if (!s) return;
    s.state = state;
    s.ts = Date.now();
    await tx('readwrite', (st) => st.put(s, 'session'));
  } catch {
    /* best effort */
  }
}

export async function loadSession(): Promise<{ file: File; state: string } | null> {
  try {
    const s = await tx<Saved | undefined>('readonly', (st) => st.get('session'));
    if (!s || !s.file) return null;
    return { file: new File([s.file], s.name, { type: s.type }), state: s.state };
  } catch {
    return null;
  }
}

/** Extra photos used by an edit (double exposure), kept on the device by id. */
export async function saveBlob(key: string, blob: Blob) {
  try {
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

export async function listRecents(): Promise<Recent[]> {
  try {
    return ((await tx<Recent[] | undefined>('readonly', (st) => st.get('recent:list'))) ?? []).sort((a, b) => b.ts - a.ts);
  } catch {
    return [];
  }
}

/** Remember (or update) a project. `files` = what it's made from (stored if they're new). */
export async function putRecent(r: Omit<Recent, 'files'>, files: { id: string; file: File }[] | null) {
  try {
    const list = await listRecents();
    const old = list.find((x) => x.id === r.id);
    let metas = old?.files ?? [];
    if (files) {
      metas = [];
      for (const { id, file } of files) {
        const key = fileKey(file);
        const have = await tx<number>('readonly', (st) => st.count('rfile:' + key));
        if (!have) await tx('readwrite', (st) => st.put(file, 'rfile:' + key));
        metas.push({ id, key, name: file.name, type: file.type });
      }
    }
    const next = [{ ...r, files: metas }, ...list.filter((x) => x.id !== r.id)].slice(0, RECENT_MAX);
    await tx('readwrite', (st) => st.put(next, 'recent:list'));
    // files no project uses any more
    const used = new Set(next.flatMap((x) => x.files.map((f) => f.key)));
    for (const x of [...list, ...(old ? [old] : [])]) for (const f of x.files) if (!used.has(f.key)) await tx('readwrite', (st) => st.delete('rfile:' + f.key));
  } catch (e) {
    console.warn('recent projects: not saved', e);
  }
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
