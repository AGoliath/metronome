// make_soundset.mjs
//
// Generates the bundled demo sound set (`sounds/woodblock/`) with two soft,
// pleasing clicks — a light "tick" and a rounder "tock" (accent). These are
// simple damped sine bursts: no pitch-glide, no overtones, just a warm click.
//
// You can reuse this to create your own sets:
//   node make_soundset.mjs <target-dir-name>
//   e.g.  node make_soundset.mjs woodblock      (writes sounds/woodblock/)
//   e.g.  node make_soundset.mjs my-set         (writes sounds/my-set/)
//
// The output folder must contain at least tick.wav; accent.wav is optional
// (it falls back to tick.wav). Replace those files with any WAVs you like.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SOUNDS_DIR = path.join(here, "sounds");
const RATE = 44100;

// A soft click: a damped sine. freq + decay shape the character; a gentle
// lowpass-like second term (a slightly detuned, quieter partial) adds warmth
// without sounding bright or "metallic".
function renderClick({ freq, decay, peak, attack = 0.0015, warmth = 0.18 } = {}) {
  const seconds = attack + decay + 0.02;
  const n = Math.max(1, Math.ceil(seconds * RATE));
  const out = new Float32Array(n);

  const twoPiF = 2 * Math.PI * freq;
  const twoPiW = 2 * Math.PI * (freq * 0.5); // a soft sub-octave for warmth
  const attackSamples = Math.max(1, Math.ceil(attack * RATE));
  const decayRate = 1 / (decay * RATE);

  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const aEnv = i < attackSamples ? i / attackSamples : 1;
    const dEnv = Math.exp(-((i - attackSamples) * decayRate));
    const env = aEnv * (i < attackSamples ? 1 : dEnv);
    const wave = Math.sin(twoPiF * t) + warmth * Math.sin(twoPiW * t);
    out[i] = wave * env * peak;
  }
  return out;
}

function toWav(samples, rate = RATE) {
  const dataSize = samples.length * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);   // PCM
  buf.writeUInt16LE(1, 22);   // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  let o = 44;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(v < 0 ? v * 0x8000 : v * 0x7fff, o);
    o += 2;
  }
  return buf;
}

const setDir = path.join(SOUNDS_DIR, process.argv[2] || "woodblock");
fs.mkdirSync(setDir, { recursive: true });

// A light, short tick and a rounder, lower, slightly longer tock.
const tick = renderClick({ freq: 1500, decay: 0.05, peak: 0.6 });
const accent = renderClick({ freq: 1050, decay: 0.11, peak: 0.9, warmth: 0.26 });

fs.writeFileSync(path.join(setDir, "tick.wav"), toWav(tick));
fs.writeFileSync(path.join(setDir, "accent.wav"), toWav(accent));

console.log(`Wrote demo sound set to: ${setDir}`);
console.log(`  • tick.wav   (${fs.statSync(path.join(setDir, "tick.wav")).size} bytes)`);
console.log(`  • accent.wav (${fs.statSync(path.join(setDir, "accent.wav")).size} bytes)`);
