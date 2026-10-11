// Bridge to the Android app's native features (no-ops on the web).
import { Capacitor, registerPlugin } from '@capacitor/core';

interface LumenNativePlugin {
  tick(o: { strong: boolean }): Promise<void>;
  captureRaw(): Promise<{ path: string; name: string; savedToGallery: boolean }>;
  writeStart(o: { name: string; mime: string; target: 'gallery' | 'cache' }): Promise<void>;
  writeChunk(o: { data: string }): Promise<void>;
  writeFinish(): Promise<{ path?: string; uri?: string }>;
  decodeFile(o: { path: string }): Promise<{ path: string; width: number; height: number }>;
}

export const isNative = Capacitor.isNativePlatform();
export const Native = registerPlugin<LumenNativePlugin>('LumenNative');

/** Stream a blob to the gallery (Pictures/Lumen) or the app cache, in chunks over the bridge. */
export async function writeBlob(blob: Blob, name: string, target: 'gallery' | 'cache', onProgress?: (f: number) => void) {
  await Native.writeStart({ name, mime: blob.type || 'application/octet-stream', target });
  const CH = 3 * 768 * 1024; // multiple of 3 so base64 chunks concatenate cleanly
  // the browser's own base64 encoder (FileReader) is far faster than building strings by hand
  const b64 = (part: Blob) =>
    new Promise<string>((res, rej) => {
      const r = new FileReader();
      r.onload = () => {
        const s = r.result as string;
        res(s.slice(s.indexOf(',') + 1));
      };
      r.onerror = () => rej(r.error);
      r.readAsDataURL(part);
    });
  let next = blob.size ? b64(blob.slice(0, CH)) : Promise.resolve('');
  for (let o = 0; o < blob.size; o += CH) {
    const data = await next;
    // encode the following chunk while this one crosses the bridge
    next = o + CH < blob.size ? b64(blob.slice(o + CH, o + 2 * CH)) : Promise.resolve('');
    await Native.writeChunk({ data });
    onProgress?.(Math.min(1, (o + CH) / blob.size));
  }
  return Native.writeFinish();
}

/** Read a file the native side wrote (e.g. a captured DNG) back into a File. */
export async function fileFromPath(path: string, name: string, type: string) {
  const r = await fetch(Capacitor.convertFileSrc(path));
  if (!r.ok) throw new Error('Could not read ' + name);
  return new File([await r.blob()], name, { type });
}
