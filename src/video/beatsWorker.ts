// Finds a song's beats off the main thread (a few minutes of music is a second or so of work,
// which would stall the editor).
import { findBeats } from './beats';

self.onmessage = (e: MessageEvent<{ x: Float32Array; sr: number }>) => {
  try {
    const b = findBeats([e.data.x], e.data.sr);
    (self as unknown as Worker).postMessage({ beats: b });
  } catch (err) {
    (self as unknown as Worker).postMessage({ error: (err as Error).message || String(err) });
  }
};
