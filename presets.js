// Song presets: let the user save the current metronome settings under a
// custom name and reload them later.
//
// A preset stores every selectable option EXCEPT volume:
//   { name, bpm, beatsPerMeasure, subdivision, accentEveryBeat, soundSet }
//
// Presets persist in `presets.json` next to this file (created on first save).
// Names are unique — saving with an existing name overwrites that preset.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(here, "presets.json");

// Read the preset list. Missing/corrupt file → empty list.
function read() {
  let list = [];
  try {
    const raw = fs.readFileSync(FILE, "utf8");
    const data = JSON.parse(raw);
    if (Array.isArray(data)) list = data;
  } catch {
    /* not there yet, or unreadable — treat as empty */
  }
  // Migrate the old "favorite" flag to "inSetlist" (kept backwards-compatible).
  let changed = false;
  for (const p of list) {
    if (p && p.favorite !== undefined && p.inSetlist === undefined) {
      p.inSetlist = p.favorite === true;
      delete p.favorite;
      changed = true;
    }
  }
  if (changed) write(list);
  return list;
}

function write(list) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2) + "\n", "utf8");
}

// Keep only the fields we persist, dropping volume (and anything unknown).
function sanitizePreset(p) {
  const clean = {};
  if (typeof p.bpm === "number" && isFinite(p.bpm)) clean.bpm = Math.round(p.bpm);
  if (typeof p.beatsPerMeasure === "number" && isFinite(p.beatsPerMeasure)) clean.beatsPerMeasure = Math.round(p.beatsPerMeasure);
  if ([1, 2, 3, 4].includes(p.subdivision)) clean.subdivision = p.subdivision;
  if (typeof p.accentEveryBeat === "boolean") clean.accentEveryBeat = p.accentEveryBeat;
  if (typeof p.soundSet === "string") clean.soundSet = p.soundSet;
  const inSetlist = typeof p.inSetlist === "boolean" ? p.inSetlist
    : (typeof p.favorite === "boolean" ? p.favorite : undefined);
  if (typeof inSetlist === "boolean") clean.inSetlist = inSetlist;
  return clean; // note: no volume
}

// Public shape returned to the UI (stable key order).
function toPublic(p) {
  return {
    name: p.name,
    bpm: p.bpm,
    beatsPerMeasure: p.beatsPerMeasure,
    subdivision: p.subdivision,
    accentEveryBeat: p.accentEveryBeat,
    soundSet: p.soundSet,
    inSetlist: p.inSetlist === true || p.favorite === true,
    savedAt: p.savedAt,
  };
}

// All saved presets (newest first).
export function listPresets() {
  return read().map(toPublic).reverse();
}

// Save (create or overwrite) a preset by name. Returns the stored preset.
export function savePreset(p) {
  if (!p || typeof p.name !== "string" || !p.name.trim()) {
    throw new Error("A preset name is required");
  }
  const name = p.name.trim().slice(0, 60);
  const clean = sanitizePreset(p);
  if (Object.keys(clean).length === 0) {
    throw new Error("Nothing to save in this preset");
  }
  const list = read();
  const idx = list.findIndex((x) => x.name === name);
  const prevInSetlist = idx >= 0 ? (list[idx].inSetlist === true || list[idx].favorite === true) : false;
  const entry = {
    name,
    ...clean,
    inSetlist: clean.inSetlist === undefined ? prevInSetlist : clean.inSetlist,
    savedAt: new Date().toISOString(),
  };
  if (idx >= 0) list[idx] = entry;
  else list.push(entry);
  write(list);
  return entry;
}

// Delete a preset by name. Returns true if something was removed.
export function deletePreset(name) {
  if (typeof name !== "string" || !name.trim()) throw new Error("A preset name is required");
  const list = read();
  const next = list.filter((x) => x.name !== name.trim());
  if (next.length === list.length) return false;
  write(next);
  return true;
}

// Add (or remove) a preset to/from the setlist by name. Returns true if a
// preset was updated. Setlist presets appear in the quick-access row in the UI.
export function setSetlist(name, inSetlist) {
  if (typeof name !== "string" || !name.trim()) throw new Error("A preset name is required");
  const list = read();
  const idx = list.findIndex((x) => x.name === name.trim());
  if (idx < 0) return false;
  list[idx].inSetlist = inSetlist === true;
  delete list[idx].favorite;
  write(list);
  return true;
}

// The raw stored list, exactly as it appears in presets.json (for download).
export function exportPresets() {
  return read();
}

// Replace the whole preset list from an uploaded file. Accepts either a
// JSON array of presets or an object of the form { presets: [...] }.
// Entries without a name are dropped; duplicates keep the last one.
// Returns the stored list. Throws if nothing valid was supplied.
export function importPresets(input) {
  const arr = Array.isArray(input)
    ? input
    : (input && Array.isArray(input.presets) ? input.presets : null);
  if (!arr) throw new Error("Expected a list of presets");
  const next = [];
  for (const p of arr) {
    if (!p || typeof p.name !== "string" || !p.name.trim()) continue;
    const name = p.name.trim().slice(0, 60);
    const clean = sanitizePreset(p);
    const entry = {
      name,
      ...clean,
      inSetlist: clean.inSetlist === true,
      savedAt: typeof p.savedAt === "string" ? p.savedAt : new Date().toISOString(),
    };
    const idx = next.findIndex((x) => x.name === name);
    if (idx >= 0) next[idx] = entry;
    else next.push(entry);
  }
  if (next.length === 0) throw new Error("No valid presets in file");
  write(next);
  return next;
}
