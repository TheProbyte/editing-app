// Voiceover recording. The microphone is read inside the same AudioContext that plays the
// video, sample by sample (an AudioWorklet), so every recorded sample has a known moment on the
// player's clock and the voice lands exactly where it was spoken. The recording becomes a plain
// WAV file: added to the media like any other file, so it's saved with the project and read
// back the same way (and a WAV's samples are exactly where they say, with no codec delay).

/** Runs on the audio thread: hands on what the microphone hears, in blocks, with the context frame each block starts at. */
const TAP = `
class LumenTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(4096);
    this.n = 0;
    this.f0 = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'flush') {
        this.flush();
        this.port.postMessage({ done: true });
      }
    };
  }
  flush() {
    if (this.n) this.port.postMessage({ f: this.f0, d: this.buf.slice(0, this.n) });
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    // (a gap in the input starts a new block)
    if (this.n && currentFrame !== this.f0 + this.n) this.flush();
    if (!this.n) this.f0 = currentFrame;
    this.buf.set(ch, this.n);
    this.n += ch.length;
    if (this.n + 128 > this.buf.length) this.flush();
    return true;
  }
}
registerProcessor('lumen-tap', LumenTap);
`;

/** contexts the tap has been added to */
const ready = new WeakMap<BaseAudioContext, Promise<void>>();

export interface Recording {
  sr: number;
  /** blocks of samples, each starting at context frame f */
  blocks: { f: number; d: Float32Array }[];
}

export class VoiceRecorder {
  private stream: MediaStream | null = null;
  private src: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private mute: GainNode | null = null;
  private blocks: { f: number; d: Float32Array }[] = [];
  private flushed: (() => void) | null = null;
  /** loudness of what was heard last (0 … 1), for a level meter */
  level = 0;

  constructor(private ctx: AudioContext) {}

  static supported() {
    return !!navigator.mediaDevices?.getUserMedia && typeof AudioWorkletNode !== 'undefined';
  }

  /** Open the microphone and start listening (throws if it can't: no permission, no microphone). */
  async open() {
    const ctx = this.ctx;
    let r = ready.get(ctx);
    if (!r) {
      const url = URL.createObjectURL(new Blob([TAP], { type: 'text/javascript' }));
      r = ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
      ready.set(ctx, r);
      r.catch(() => ready.delete(ctx));
    }
    // (echo cancellation keeps the video's own sound, from the speaker, out of the voice)
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    await r;
    this.src = ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(ctx, 'lumen-tap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
    this.node.port.onmessage = (e) => {
      const m = e.data as { f?: number; d?: Float32Array; done?: boolean };
      if (m.done) return this.flushed?.();
      if (!m.d || m.f === undefined) return;
      this.blocks.push({ f: m.f, d: m.d });
      let pk = 0;
      for (let i = 0; i < m.d.length; i += 4) pk = Math.max(pk, Math.abs(m.d[i]));
      this.level = Math.max(pk, this.level * 0.8);
    };
    // (a node nothing listens to isn't run: it goes to the output through a silent gain)
    this.mute = ctx.createGain();
    this.mute.gain.value = 0;
    this.src.connect(this.node);
    this.node.connect(this.mute);
    this.mute.connect(ctx.destination);
  }

  /**
   * How long after it was spoken a sound reaches the tap, beyond what the output delay
   * accounts for: the microphone's own delay where the browser says, else a typical one.
   */
  inputDelay() {
    const st = this.stream?.getAudioTracks()[0]?.getSettings() as (MediaTrackSettings & { latency?: number }) | undefined;
    const l = st?.latency;
    return typeof l === 'number' && l >= 0 && l < 0.5 ? l : 0.02;
  }

  /** Forget what was heard so far (the count-in), keep listening. */
  reset() {
    this.blocks = [];
  }

  /** Stop listening: everything heard, and the microphone let go. */
  async close(): Promise<Recording> {
    const sr = this.ctx.sampleRate;
    if (this.node) {
      const done = new Promise<void>((r) => (this.flushed = r));
      this.node.port.postMessage('flush');
      await Promise.race([done, new Promise((r) => setTimeout(r, 300))]);
    }
    this.release();
    return { sr, blocks: this.blocks };
  }

  /** Let go of the microphone (also on a failure or cancel). */
  release() {
    try {
      this.src?.disconnect();
      this.node?.disconnect();
      this.mute?.disconnect();
    } catch {
      /* already */
    }
    if (this.node) this.node.port.onmessage = null;
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
    this.src = null;
    this.node = null;
    this.mute = null;
  }
}

/**
 * The samples of a recording laid out on a timeline: sample 0 is at timeline time t0, the
 * block at context frame f belongs at timeline time `at(f)`, and it runs `len` seconds.
 */
export function assemble(rec: Recording, t0: number, len: number, at: (f: number) => number): Float32Array {
  const n = Math.max(0, Math.round(len * rec.sr));
  const out = new Float32Array(n);
  for (const b of rec.blocks) {
    const i0 = Math.round((at(b.f) - t0) * rec.sr);
    const s = Math.max(0, -i0), e = Math.min(b.d.length, n - i0);
    if (e > s) out.set(b.d.subarray(s, e), i0 + s);
  }
  return out;
}

/**
 * Where the speaking starts and ends (seconds), leaving a little room either side: the quiet
 * before the first word and after the last is left out of the clip (it's still in the file, and
 * dragging the clip's edges brings it back). Null if nothing was heard.
 */
export function speechSpan(x: Float32Array, sr: number): [number, number] | null {
  const W = Math.max(1, Math.round(sr * 0.02));
  const nb = Math.floor(x.length / W);
  if (!nb) return null;
  const rms = new Float32Array(nb);
  let top = 0;
  for (let b = 0; b < nb; b++) {
    let s = 0;
    for (let i = b * W, e = i + W; i < e; i++) s += x[i] * x[i];
    rms[b] = Math.sqrt(s / W);
    if (rms[b] > top) top = rms[b];
  }
  if (top < 0.003) return null;
  // speaking: well above the quietest part, and not far below the loudest
  const sorted = Float32Array.from(rms).sort();
  const floor = sorted[Math.floor(nb * 0.1)];
  const th = Math.max(0.004, floor * 3, top * 0.06);
  let a = 0, b = nb - 1;
  while (a < nb && rms[a] < th) a++;
  while (b > a && rms[b] < th) b--;
  const len = x.length / sr;
  return [Math.max(0, (a * W) / sr - 0.15), Math.min(len, ((b + 1) * W) / sr + 0.3)];
}

/** 16-bit mono WAV of the samples. */
export function wavFile(x: Float32Array, sr: number, name: string): File {
  const buf = new ArrayBuffer(44 + x.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + x.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, x.length * 2, true);
  for (let i = 0, o = 44; i < x.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, x[i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new File([buf], name, { type: 'audio/wav', lastModified: Date.now() });
}
