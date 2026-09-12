// Sound-set discovery + resolution.
//
// A sound set is a folder inside `sounds/` named after the set (e.g.
// `sounds/woodblock/`), containing:
//   tick.wav    required — the regular beat
//   accent.wav  optional — the downbeat (falls back to tick.wav if absent)
//
// The special set id "builtin" is always available and uses the synthesized
// click from audio.js (no files required).
//
// Everything is lazy and cheap: we only stat/read when asked, and results are
// cached until the directory changes (the server refreshes the cache when the
// user asks for a fresh list or after adding files).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseWav, normalizeSamples, clickFade } from "./audio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SOUNDS_DIR = path.join(here, "sounds");

export const BUILTIN_ID = "builtin";

let cache = null; // { sets: [...], mtimeMs: <number> }

// List the available sound sets. The "builtin" set is always first.
// Each set: { id, name, tick, accent } where tick/accent are absolute file
// paths, or null for the built-in set (which is synthesized).
export function listSoundSets({ refresh = false } = {}) {
  const dirMtime = safeMtime(SOUNDS_DIR);

  if (!refresh && cache && dirMtime !== null && cache.mtimeMs === dirMtime) {
    return cache.sets;
  }

  const sets = [{ id: BUILTIN_ID, name: "Built-in click", tick: null, accent: null }];

  if (dirMtime !== null) {
    for (const entry of safeReaddir(SOUNDS_DIR)) {
      const dirPath = path.join(SOUNDS_DIR, entry);
      if (!isDirectory(dirPath)) continue;

      const tick = path.join(dirPath, "tick.wav");
      const accentFile = path.join(dirPath, "accent.wav");
      // A set is usable if it has a tick; accent may fall back to tick.
      if (!fileExists(tick)) continue;

      const id = entry;
      sets.push({
        id,
        name: prettify(entry),
        tick,
        accent: fileExists(accentFile) ? accentFile : tick,
      });
    }
  }

  // Keep a stable, predictable order: builtin first, then alphabetical.
  const [builtin, ...rest] = sets;
  rest.sort((a, b) => a.id.localeCompare(b.id));
  sets.splice(0, 1, builtin);

  cache = { sets, mtimeMs: dirMtime };
  return sets;
}

// Resolve a set id to concrete resources.
// Returns:
//   { id, source: "file", tick, accent }      for a file-based set
//   { id, source: "builtin", tick: null, accent: null } for the built-in set
// Throws if the id is not a currently available set.
export function resolveSoundSet(id) {
  const sets = listSoundSets();
  const set = sets.find((s) => s.id === id);
  if (!set) throw new Error(`Unknown sound set: "${id}"`);

  if (set.id === BUILTIN_ID) {
    return { id: BUILTIN_ID, source: "builtin", tick: null, accent: null };
  }
  return { id: set.id, source: "file", tick: set.tick, accent: set.accent };
}

// Load a set's audio as decoded, normalized mono samples — so every file set
// plays at a consistent peak level regardless of how the source files were
// recorded. The tick is normalized to TICK_PEAK and the accent to
// ACCENT_PEAK (a bit higher) so the downbeat reliably reads as louder, no
// matter how the source files were cut.
// Results are cached per (file path, mtime) so we only decode once.
// Returns { tick: Float32Array, accent: Float32Array, sampleRate }.
// Throws if the id is not a currently available file-based set.
const audioCache = new Map(); // key = `${path}\0${mtimeMs}` -> entry
const TICK_PEAK = 0.62;    // regular beat (kept clearly soft)
const ACCENT_PEAK = 1.0;   // downbeat (full scale — stands out vs. the tick)

function loadFileSamples(absolutePath) {
  const mtime = safeMtime(absolutePath);
  if (mtime === null) throw new Error(`cannot read audio file: ${absolutePath}`);
  const key = `${absolutePath}\0${mtime}`;
  const cached = audioCache.get(key);
  if (cached) return cached;

  const raw = fs.readFileSync(absolutePath);
  const { data, sampleRate } = parseWav(raw);

  // Cache the decoded (but not yet level-scaled) samples; we normalize to the
  // desired peak when a set is loaded so tick/accent can use different peaks.
  const entry = { samples: data, sampleRate, path: absolutePath, mtime };
  audioCache.set(key, entry);
  // Keep the cache small: evict stale entries (files that changed or vanished).
  if (audioCache.size > 64) {
    for (const [k, e] of audioCache) {
      if (e.mtime !== safeMtime(e.path)) audioCache.delete(k);
    }
  }
  return entry;
}

// Convenience for the server: decode + normalize a set's tick and accent.
// Accent falls back to the tick samples when the set has no accent.wav.
// Returns { tick, accent, sampleRate } (sampleRate is preserved so re-encoding
// does not change pitch/tempo of the original files).
export function loadSetAudio(id) {
  const set = resolveSoundSet(id);
  if (set.source === "builtin") {
    throw new Error("loadSetAudio is only for file-based sets");
  }
  const tickEntry = loadFileSamples(set.tick);
  const accentEntry = set.accent === set.tick ? tickEntry : loadFileSamples(set.accent);
  return {
    tick: clickFade(normalizeSamples(tickEntry.samples, TICK_PEAK), tickEntry.sampleRate),
    accent: clickFade(normalizeSamples(accentEntry.samples, ACCENT_PEAK), tickEntry.sampleRate),
    sampleRate: tickEntry.sampleRate,
  };
}

// --- small fs helpers ------------------------------------------------------
function fileExists(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}
function isDirectory(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}
function safeReaddir(p) {
  try { return fs.readdirSync(p, { withFileTypes: true }).map((d) => d.name); } catch { return []; }
}
function safeMtime(p) {
  try { return fs.statSync(p).mtimeMs; } catch { return null; }
}
function prettify(id) {
  return id
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}
