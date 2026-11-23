// Reverse: a copy of a stretch of footage that plays backwards (picture and sound), made once and
// kept as a file of its own. Video only decodes forwards, so the copy is built from the end: one
// stretch between whole frames ("key frames") at a time is decoded, held, and written out in
// reverse; the sound is decoded, turned round and written after it.
import {
  AudioBufferSink, AudioBufferSource, BufferTarget, EncodedPacketSink, Mp4OutputFormat, Output, VideoSample,
  VideoSampleSource, getFirstEncodableAudioCodec, getFirstEncodableVideoCodec,
} from 'mediabunny';
import type { Media, MediaLib } from './media';

/** the copy's long side at most (keeps the frames held per stretch, and the file, a sane size) */
const LONG = 1920;
/** frames held at once (a long stretch between key frames is done in parts) */
const HOLD = 24;
/** longest stretch that can be reversed (seconds; it's built in memory) */
export const REVERSE_MAX = 180;

export async function reverseFootage(m: Media, lib: MediaLib, from: number, to: number, progress: (f: number) => void, cancelled: () => boolean): Promise<File> {
  if (!m.video) throw new Error('No picture to reverse');
  if (to - from > REVERSE_MAX) throw new Error(`Clips up to ${REVERSE_MAX / 60} minutes can be reversed`);
  const k = Math.min(1, LONG / Math.max(m.w, m.h));
  const W = Math.max(2, Math.round((m.w * k) / 2) * 2), H = Math.max(2, Math.round((m.h * k) / 2) * 2);
  const fps = m.fps || 30;
  const vcodec = await getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9', 'av1'], { width: W, height: H });
  if (!vcodec) throw new Error(`This phone can’t encode ${W}×${H} video`);
  const acodec = m.audio ? await getFirstEncodableAudioCodec(['aac', 'opus'], { numberOfChannels: 2, sampleRate: 48000 }) : null;
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const video = new VideoSampleSource({ codec: vcodec, bitrate: Math.round(Math.min(40e6, W * H * fps * 0.2)), keyFrameInterval: 1 });
  output.addVideoTrack(video, { frameRate: fps });
  const audio = acodec ? new AudioBufferSource({ codec: acodec, bitrate: 192_000 }) : null;
  if (audio) output.addAudioTrack(audio);
  await output.start();
  const abort = () => {
    if (cancelled()) throw new DOMException('cancelled', 'AbortError');
  };
  try {
    // where the stretches start: the key frames from the one before `from` up to `to`
    const ks = new EncodedPacketSink(m.video);
    const keys: number[] = [];
    let pk = await ks.getKeyPacket(from, { metadataOnly: true });
    keys.push(pk ? pk.timestamp : 0);
    for (pk = pk && (await ks.getNextKeyPacket(pk, { metadataOnly: true })); pk && pk.timestamp < to; pk = await ks.getNextKeyPacket(pk, { metadataOnly: true })) keys.push(pk.timestamp);
    const sink = lib.videoSink(m)!;
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d')!;
    // a frame of the source at its end time te comes out at (to - te): the last frame first
    let done = 0;
    const span = Math.max(1e-6, to - from);
    for (let g = keys.length - 1; g >= 0; g--) {
      const g0 = keys[g], g1 = g + 1 < keys.length ? keys[g + 1] : to;
      // the frames of this stretch, in parts of HOLD from its end (each part decodes the stretch
      // from its key frame; only the part's own frames are kept)
      const times: { ts: number; dur: number }[] = [];
      for await (const s of sink.samples(g0, g1)) {
        if (s.timestamp + (s.duration || 1 / fps) > from + 1e-4 && s.timestamp < to - 1e-4) times.push({ ts: s.timestamp, dur: s.duration || 1 / fps });
        s.close();
      }
      for (let end = times.length; end > 0; end -= HOLD) {
        abort();
        const start = Math.max(0, end - HOLD);
        const want = new Set(times.slice(start, end).map((t) => t.ts));
        const held: { ts: number; dur: number; bmp: ImageBitmap }[] = [];
        for await (const s of sink.samples(g0, times[end - 1].ts + 1e-4)) {
          if (want.has(s.timestamp)) {
            // turned upright and sized for the copy
            ctx.clearRect(0, 0, W, H);
            s.drawWithFit(ctx, { fit: 'fill' });
            held.push({ ts: s.timestamp, dur: s.duration || 1 / fps, bmp: canvas.transferToImageBitmap() });
          }
          s.close();
        }
        for (let i = held.length - 1; i >= 0; i--) {
          const f = held[i];
          // clamped to the stretch being reversed (the first and last frames can stick out of it)
          const te = Math.min(to, f.ts + f.dur), tb = Math.max(from, f.ts);
          const sample = new VideoSample(f.bmp, { timestamp: to - te, duration: Math.max(1e-3, te - tb) });
          await video.add(sample);
          sample.close();
          f.bmp.close();
        }
        done += held.length;
        progress(Math.min(0.95, (done / Math.max(1, (span * fps))) * 0.95));
      }
    }
    video.close();
    // the sound, back to front
    if (audio && m.audio) {
      const as = new AudioBufferSink(m.audio);
      const parts: { ts: number; b: AudioBuffer }[] = [];
      let sr = 48000, ch = 2;
      for await (const w of as.buffers(from, to)) {
        abort();
        parts.push({ ts: w.timestamp, b: w.buffer });
        sr = w.buffer.sampleRate;
        ch = Math.min(2, w.buffer.numberOfChannels);
      }
      const len = Math.max(1, Math.round((to - from) * sr));
      const out = new AudioBuffer({ numberOfChannels: ch, length: len, sampleRate: sr });
      // laid out by the buffers' own times (the first can start before `from`; gaps stay gaps),
      // then turned round
      const chans = Array.from({ length: ch }, (_, c) => out.getChannelData(c));
      for (const { ts, b } of parts) {
        const at = Math.round((ts - from) * sr);
        for (let c = 0; c < ch; c++) {
          const src = b.getChannelData(Math.min(c, b.numberOfChannels - 1));
          for (let i = 0; i < src.length; i++) {
            const j = at + i;
            if (j >= 0 && j < len) chans[c][j] = src[i];
          }
        }
      }
      for (const d of chans) d.reverse();
      await audio.add(out);
      audio.close();
    }
    progress(0.98);
    await output.finalize();
    const buf = (output.target as BufferTarget).buffer;
    if (!buf) throw new Error('The reversed copy came out empty');
    const base = m.name.replace(/\.[^.]+$/, '');
    return new File([buf], `${base} reversed.mp4`, { type: 'video/mp4', lastModified: Date.now() });
  } catch (e) {
    await output.cancel().catch(() => {});
    throw e;
  }
}
