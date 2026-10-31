/**
 * C1: the moments' sounds, synthesized (oscillators, filtered noise, envelopes) from the scores in
 * jingles.json: one jingle per rebirth variant and a soft pop for the coffee "+1". Nothing is
 * sampled. `scheduleJingle` works on any BaseAudioContext, so the dev runner renders the very
 * same graph offline (renderJingle) to put it under the recorded video.
 */
import { FX_JINGLE_VOLUME, FX_POP_VOLUME, FX_WAV_RATE, FX_WAV_SEC } from '../../constants.js';
import { playSynth } from '../../notificationSound.js';
import type { FxKind } from './director.js';
import scores from './jingles.json';

interface ToneNote {
  t: 'tone';
  w: OscillatorType;
  f: number[];
  at: number;
  d: number;
  v: number;
  vib?: number;
}
interface NoiseNote {
  t: 'noise';
  at: number;
  d: number;
  v: number;
  band: number[];
}
type Note = ToneNote | NoiseNote;

const SCORES = scores as unknown as Record<FxKind, Note[]>;
const ATTACK_SEC = 0.006;
const SILENT = 0.0001;
const VIB_DEPTH = 0.012; // of the pitch
const NOISE_Q = 1.2;
const NOISE_SEED = 0x2f6b;

/** One envelope: a quick rise, an exponential fall to silence at `at + d`. */
function envelope(
  ctx: BaseAudioContext,
  out: AudioNode,
  at: number,
  d: number,
  v: number,
): GainNode {
  const g = ctx.createGain();
  g.gain.setValueAtTime(SILENT, at);
  g.gain.linearRampToValueAtTime(v, at + ATTACK_SEC);
  g.gain.exponentialRampToValueAtTime(SILENT, at + d);
  g.connect(out);
  return g;
}

/** A second of white noise from a fixed seed (the offline render is the same every time). */
function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = buf.getChannelData(0);
  let s = NOISE_SEED;
  for (let i = 0; i < data.length; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    data[i] = (s / 0xffffffff) * 2 - 1;
  }
  return buf;
}

/** Schedule `kind`'s score on `ctx` from time `at`, at loudness `level` (0..1). */
export function scheduleJingle(
  ctx: BaseAudioContext,
  kind: FxKind,
  at: number,
  level: number,
): void {
  const master = ctx.createGain();
  master.gain.value = level * (kind === 'coffee' ? FX_POP_VOLUME : FX_JINGLE_VOLUME);
  master.connect(ctx.destination);
  let noise: AudioBuffer | null = null;
  for (const n of SCORES[kind]) {
    const t0 = at + n.at;
    const g = envelope(ctx, master, t0, n.d, n.v);
    if (n.t === 'tone') {
      const osc = ctx.createOscillator();
      osc.type = n.w;
      osc.frequency.setValueAtTime(n.f[0], t0);
      if (n.f.length > 1) osc.frequency.exponentialRampToValueAtTime(n.f[1], t0 + n.d);
      if (n.vib) {
        const lfo = ctx.createOscillator();
        const depth = ctx.createGain();
        lfo.frequency.value = n.vib;
        depth.gain.value = n.f[0] * VIB_DEPTH;
        lfo.connect(depth).connect(osc.frequency);
        lfo.start(t0);
        lfo.stop(t0 + n.d);
      }
      osc.connect(g);
      osc.start(t0);
      osc.stop(t0 + n.d);
    } else {
      noise ??= noiseBuffer(ctx);
      const src = ctx.createBufferSource();
      src.buffer = noise;
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.Q.value = NOISE_Q;
      filter.frequency.setValueAtTime(n.band[0], t0);
      filter.frequency.exponentialRampToValueAtTime(n.band[1], t0 + n.d);
      src.connect(filter).connect(g);
      src.start(t0);
      src.stop(t0 + n.d);
    }
  }
}

/** Play `kind`'s sound now, only while the office's sound setting is on. */
export function playFxSound(kind: FxKind): void {
  void playSynth((ctx, level) => scheduleJingle(ctx, kind, ctx.currentTime, level));
}

/** The dev runner: `kind`'s sound rendered offline (mono samples at FX_WAV_RATE, full volume). */
export async function renderJingle(kind: FxKind): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, FX_WAV_RATE * FX_WAV_SEC, FX_WAV_RATE);
  scheduleJingle(ctx, kind, 0, 1);
  return (await ctx.startRendering()).getChannelData(0);
}
