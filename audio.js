// Audio engine: renders a single metronome click as raw PCM samples using
// pure JavaScript DSP (a sine burst shaped by a fast attack + exponential
// decay), then encodes it to a 16-bit PCM WAV file.
//
// This needs no native dependencies and works on any Node.js version.
// A "tick" is a short, high click; a "tock" (downbeat accent) is a lower,
// louder, longer click. Both are deterministic so the browser can cache
// them per tempo/volume.

const DEFAULT_SAMPLE_RATE = 44100;

// Render a single click and return a Float32Array of mono samples.
//
// Simple, clean voices (no pitch-modulation, no overtones):
//   • tick   — a short, soft mid-range click.
//   • accent — a slightly lower, longer, louder click.
// This is the BUILT-IN fallback when no user sound set is selected.
function renderClick({
  accent = false,
  volume = 0.75,
  attack = 0.001,
  decay = accent ? 0.08 : 0.045,
  sampleRate = DEFAULT_SAMPLE_RATE,
} = {}) {
  const seconds = attack + decay + 0.02;
  const length = Math.max(1, Math.ceil(seconds * sampleRate));
  const out = new Float32Array(length);

  const freq = accent ? 1200 : 1750;
  const peak = Math.min(1, volume * (accent ? 0.85 : 0.5));
  const twoPiF = 2 * Math.PI * freq;
  const attackSamples = Math.max(1, Math.ceil(attack * sampleRate));
  const decayRate = 1 / (decay * sampleRate);

  for (let n = 0; n < length; n++) {
    const t = n / sampleRate;
    const wave = Math.sin(twoPiF * t);

    const attackEnv = n < attackSamples ? n / attackSamples : 1;
    const decayEnv = Math.exp(-((n - attackSamples) * decayRate));
    const env = attackEnv * (n < attackSamples ? 1 : decayEnv);

    out[n] = wave * env * peak;
  }
  return out;
}

// Encode mono PCM samples into a 16-bit WAV file (Buffer).
function toWav(samples, sampleRate = DEFAULT_SAMPLE_RATE) {
  const mono = samples.length;
  const dataSize = mono * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  // RIFF header
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);          // PCM fmt chunk size
  buffer.writeUInt16LE(1, 20);           // format = PCM
  buffer.writeUInt16LE(1, 22);           // channels = 1
  buffer.writeUInt32LE(sampleRate, 24);  // sample rate
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32);           // block align
  buffer.writeUInt16LE(16, 34);          // bits per sample
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  let offset = 44;
  for (let i = 0; i < mono; i++) {
    const value = samples[i];
    const clamped = Math.max(-1, Math.min(1, value));
    buffer.writeInt16LE(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, offset);
    offset += 2;
  }
  return buffer;
}

// Generate a click WAV. Memoized so repeated requests are cheap.
const cache = new Map();
function generateClick(options) {
  const sampleRate = DEFAULT_SAMPLE_RATE;
  const key = JSON.stringify({ ...options, sampleRate });
  if (!cache.has(key)) {
    const samples = clickFade(renderClick({ ...options, sampleRate }), sampleRate);
    cache.set(key, toWav(samples, sampleRate));
  }
  return cache.get(key);
}

// --- WAV decode + gain tools (for user-provided sound sets) -----------------
//
// These let the server normalize a set of imported WAV files to a consistent
// level (so a loud file and a quiet file play at the same volume) and apply
// the 0–1 master volume on top.

// Decode a WAV Buffer into a mono Float32Array (stereo is downmixed).
// Supports 8/16/32-bit PCM (format 1) and 32-bit float (format 3).
// Throws on anything it can't parse — callers should fall back to the raw bytes.
function parseWav(buffer) {
  if (!buffer || buffer.length < 12) throw new Error("not a WAV file");
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE")
    throw new Error("not a RIFF/WAVE file");

  let offset = 12;
  let format = 0, channels = 1, sampleRate = 0, bitsPerSample = 16;
  let data = null;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (chunkId === "fmt ") {
      format = buffer.readUInt16LE(start);
      channels = buffer.readUInt16LE(start + 2);
      sampleRate = buffer.readUInt32LE(start + 4);
      bitsPerSample = buffer.readUInt16LE(start + 14);
    } else if (chunkId === "data") {
      const n = Math.min(chunkSize, buffer.length - start);
      data = buffer.subarray(start, start + n);
    }
    offset = start + chunkSize + (chunkSize & 1); // chunks are word-aligned
  }

  if (!sampleRate || !data) throw new Error("WAV missing fmt/data");
  if (format !== 1 && format !== 3) throw new Error(`unsupported WAV format ${format}`);

  const bytesPerSample = bitsPerSample / 8;
  if (bytesPerSample !== 1 && bytesPerSample !== 2 && bytesPerSample !== 4)
    throw new Error(`unsupported sample size ${bitsPerSample}`);

  const dv = new DataView(data.buffer, data.byteOffset, data.length);
  const frameSize = bytesPerSample * channels;
  const frames = Math.floor(data.length / frameSize);
  const out = new Float32Array(frames);

  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      const p = i * frameSize + c * bytesPerSample;
      let s;
      if (format === 3 && bytesPerSample === 4) s = dv.getFloat32(p, true);
      else if (bytesPerSample === 2) s = dv.getInt16(p, true) / 32768;
      else if (bytesPerSample === 1) s = (dv.getUint8(p) - 128) / 128;
      else s = 0;
      sum += s;
    }
    out[i] = sum / channels; // downmix to mono
  }
  return { data: out, sampleRate };
}

// Return a new sample array scaled so its largest peak equals `targetPeak`.
// Quiet files are amplified (capped by `maxGain` to avoid pumping up hiss);
// loud files are attenuated. Silent input is returned unchanged.
function normalizeSamples(data, targetPeak = 0.95, maxGain = 8) {
  let maxAbs = 0;
  for (let i = 0; i < data.length; i++) {
    const a = data[i] < 0 ? -data[i] : data[i];
    if (a > maxAbs) maxAbs = a;
  }
  if (maxAbs < 1e-6) return data;
  let gain = targetPeak / maxAbs;
  if (gain > maxGain) gain = maxGain;
  if (gain > 0.999 && gain < 1.001) return data;
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] * gain;
  return out;
}

// Return a new sample array scaled by `factor` (0..1 for the volume slider),
// clamped to the full-scale range so it never clips.
function scaleSamples(data, factor) {
  if (factor === 1) return data;
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    let v = data[i] * factor;
    if (v > 1) v = 1;
    else if (v < -1) v = -1;
    out[i] = v;
  }
  return out;
}

// Apply a short linear fade-in and fade-out so a click starts and ends at
// silence. This removes the "pop"/click artifact that occurs when a sample is
// cut off mid-value (the file's first/last sample is non-zero) and when the
// audio engine stops reading abruptly.
// Returns a new sample array. Fade lengths are clamped to the sample count.
function clickFade(data, sampleRate = 44100, fadeInSec = 0.002, fadeOutSec = 0.012) {
  const n = data.length;
  if (n === 0) return data;
  const out = new Float32Array(n);
  const fadeIn = Math.min(n, Math.max(1, Math.round(fadeInSec * sampleRate)));
  const fadeOut = Math.min(n, Math.max(1, Math.round(fadeOutSec * sampleRate)));
  for (let i = 0; i < n; i++) {
    let g = 1;
    if (i < fadeIn) g *= (i + 1) / fadeIn;                 // ramp up to 1
    if (i >= n - fadeOut) g *= (n - i) / fadeOut;          // ramp down to 0
    out[i] = data[i] * g;
  }
  return out;
}

export { renderClick, toWav, generateClick, parseWav, normalizeSamples, scaleSamples, clickFade };
