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
