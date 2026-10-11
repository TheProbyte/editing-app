import { inpaint } from './inpaint';

self.onmessage = (e: MessageEvent<{ rgba: Uint8ClampedArray; w: number; h: number; mask: Uint8Array }>) => {
  const { rgba, w, h, mask } = e.data;
  try {
    const r = inpaint(rgba, w, h, mask, (f) => (self as unknown as Worker).postMessage({ progress: f }));
    (self as unknown as Worker).postMessage({ done: r.rgba }, [r.rgba.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ error: (err as Error).message || 'Fill failed' });
  }
};
