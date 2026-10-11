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
export async function writeBlob(blob: Blob, name: string, target: 'gallery' | 'cache') {
  await Native.writeStart({ name, mime: blob.type || 'application/octet-stream', target });
  const CH = 3 * 512 * 1024; // multiple of 3 so base64 chunks concatenate cleanly
  for (let o = 0; o < blob.size; o += CH) {
    const bytes = new Uint8Array(await blob.slice(o, o + CH).arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    await Native.writeChunk({ data: btoa(bin) });
  }
  return Native.writeFinish();
}

/** Read a file the native side wrote (e.g. a captured DNG) back into a File. */
export async function fileFromPath(path: string, name: string, type: string) {
  const r = await fetch(Capacitor.convertFileSrc(path));
  if (!r.ok) throw new Error('Could not read ' + name);
  return new File([await r.blob()], name, { type });
}
