// Client: connects to the metronome server, drives the UI, and shows which
// output device the SERVER is playing on.
//
// NOTE: Audio playback happens entirely on the server. The browser no longer
// synthesizes or plays any sound — it only visualizes beats and reflects the
// server's configuration and output device.

const API = {
  stream: "/api/stream",
  config: "/api/config",
  start: "/api/start",
  stop: "/api/stop",
  audio: "/api/audio",
  sounds: "/api/sounds",
  preview: "/api/preview",
  presets: "/api/presets",
  presetsExport: "/api/presets/export",
  presetsImport: "/api/presets/import",
};

const state = {
  running: false,
  config: { bpm: 120, beatsPerMeasure: 4, subdivision: 1, accentEveryBeat: false, volume: 0.75 },
};

let eventSource = null;
let audioPoll = null;

// --- Sound output (server-side) ------------------------------------------
// Fetch the device name + backend from the server and render it in the UI.
async function refreshAudioInfo() {
  try {
    const res = await fetch(API.audio);
    if (!res.ok) return;
    const data = await res.json();
    renderAudioInfo(data);
  } catch {
    // Server unreachable; the SSE onerror handler updates the connection badge.
  }
}

function renderAudioInfo(data) {
  const name = $("deviceName");
  const badge = $("audioBackend");
  const device = document.querySelector(".device");

  if (name) {
    name.textContent = data.deviceName || "Unknown device";
    const isGeneric = /default/i.test(data.deviceName || "");
    name.classList.toggle("is-default", isGeneric);
  }

  if (badge) {
    const alive = !!data.workerAlive;
    const backendOk = data.backend && data.backend !== "unavailable";
    badge.textContent = backendOk ? (alive ? data.backend : "ready") : "standby";
    badge.classList.toggle("ok", backendOk);
    badge.classList.toggle("off", !backendOk);
  }

  if (device) {
    device.classList.toggle("is-playing", state.running);
  }
}

// Keep the device display fresh (device can change at runtime).
function startAudioPolling() {
  if (audioPoll) clearInterval(audioPoll);
  audioPoll = setInterval(refreshAudioInfo, 4000);
}

// --- Sound sets ----------------------------------------------------------
// Load the available sound sets from the server and populate the selector.
async function loadSoundSets() {
  try {
    const res = await fetch(API.sounds);
    if (!res.ok) return;
    const data = await res.json();
    renderSoundSets(data);
  } catch {
    // Server unreachable; connection badge handles visibility.
  }
}

function renderSoundSets(data) {
  const sel = $("soundSetSel");
  if (!sel) return;
  const sets = data.sets || [];
  const active = data.active || "builtin";

  // Preserve current selection across refreshes when possible.
  const current = sel.value || active;

  sel.innerHTML = "";
  for (const s of sets) {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = s.name || s.id;
    sel.appendChild(opt);
  }

  // Select the server's active set (or the last user choice if still present).
  const wantValue = sets.some((s) => s.id === current) ? current : active;
  sel.value = wantValue;
  if (sel.value !== wantValue) sel.value = active;
}

// Send a one-shot preview of the (currently selected) sound set.
async function previewSoundSet() {
  const sel = $("soundSetSel");
  const soundSet = sel ? sel.value : "builtin";
  try {
    await fetch(API.preview, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ soundSet }),
    });
  } catch {
    /* ignore */
  }
}

// --- Song presets --------------------------------------------------------
// Load the list of saved presets from the server and render them.
async function loadPresets() {
  try {
    const res = await fetch(API.presets);
    if (!res.ok) return;
    const data = await res.json();
    renderPresets(data.presets || []);
  } catch {
    // Server unreachable; the connection badge already reflects that.
  }
}

// Download all presets as a standalone JSON file (metronome-presets.json).
function downloadPresets() {
  const a = document.createElement("a");
  a.href = API.presetsExport;
  a.download = "metronome-presets.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// Replace all presets from a chosen JSON file (array or { presets: [...] }).
async function importPresets() {
  const input = $("presetFile");
  const file = input && input.files && input.files[0];
  if (!file) return;
  let text;
  try { text = await file.text(); } catch { alert("Could not read that file."); return; }
  let data;
  try { data = JSON.parse(text); } catch { alert("That file is not valid JSON."); return; }
  const res = await fetch(API.presetsImport, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (res.ok) {
    const d = await res.json();
    renderPresets(d.presets || []);
    if (input) input.value = "";
  } else {
    const d = await res.json().catch(() => ({}));
    alert(d.error || "Could not import presets.");
  }
}

const SUB_LABELS = { 1: "beat", 2: "eighths", 3: "triplets", 4: "sixteenths" };

let latestPresets = [];

function renderPresets(presets) {
  latestPresets = presets || [];
  const list = $("presetList");
  const empty = $("presetEmpty");
  if (!list) return;
  list.innerHTML = "";
  if (empty) empty.hidden = presets.length > 0;

  for (const p of presets) {
    const li = document.createElement("li");
    li.className = "preset-item";

    const name = document.createElement("button");
    name.className = "preset-item__load";
    name.type = "button";
    name.textContent = p.name;
    name.title = "Load this preset";
    name.addEventListener("click", () => applyPreset(p));

    const meta = document.createElement("span");
    meta.className = "preset-item__meta";
    meta.textContent = `${p.bpm} BPM · ${SUB_LABELS[p.subdivision] || p.subdivision} · ${p.beatsPerMeasure}/m`;

    const overwrite = document.createElement("button");
    overwrite.className = "preset-item__overwrite";
    overwrite.type = "button";
    overwrite.setAttribute("aria-label", "Overwrite with current settings");
    overwrite.title = "Overwrite with current settings";
    overwrite.innerHTML =
      '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" ' +
      'stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M2.5 3 L10 3 L13.5 6.5 L13.5 13.5 L2.5 13.5 Z"/>' +
      '<rect x="4.5" y="3" width="4" height="3.2" rx="0.3"/>' +
      '<rect x="4.5" y="9.6" width="7" height="3.9" rx="0.3"/>' +
      '</svg>';
    overwrite.addEventListener("click", () => overwritePresetUI(p.name, overwrite));

    const del = document.createElement("button");
    del.className = "preset-item__del";
    del.type = "button";
    del.textContent = "✕";
    del.title = "Delete this preset";
    del.addEventListener("click", () => deletePresetUI(p.name));

    const star = document.createElement("button");
    star.className = "preset-item__setlist" + (p.inSetlist ? " is-setlist" : "");
    star.type = "button";
    star.setAttribute("aria-label", p.inSetlist ? "Remove from setlist" : "Add to setlist");
    star.innerHTML =
      '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" ' +
      'stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">' +
      '<line x1="1.5" y1="2.5" x2="11.5" y2="2.5"/>' +
      '<line x1="1.5" y1="6" x2="11.5" y2="6"/>' +
      '<line x1="1.5" y1="9.5" x2="8" y2="9.5"/>' +
      '<circle cx="10.4" cy="13" r="1.8" fill="currentColor" stroke="none"/>' +
      '<line x1="12.2" y1="13" x2="12.2" y2="7"/>' +
      '<path d="M12.2 7 q 1.8 -0.2 2.3 1.2"/>' +
      '</svg>';
    star.title = p.inSetlist ? "Remove from setlist" : "Add to setlist";
    star.addEventListener("click", () => toggleSetlist(p.name));

    li.append(name, meta, star, overwrite, del);
    li.dataset.name = (p.name || "").toLowerCase();
    list.appendChild(li);
  }
  filterPresets();
  renderSetlist();
}

// Show/hide preset items based on the search box; also toggles the
// "no presets" and "no matches" messages.
function filterPresets() {
  const list = $("presetList");
  if (!list) return;
  const empty = $("presetEmpty");
  const noMatch = $("presetNoMatch");
  const searchEl = $("presetSearch");
  const q = (searchEl ? searchEl.value : "").trim().toLowerCase();
  let visible = 0;
  for (const li of list.querySelectorAll(".preset-item")) {
    const match = !q || (li.dataset.name || "").includes(q);
    li.hidden = !match;
    if (match) visible++;
  }
  const total = latestPresets.length;
  if (empty) empty.hidden = total > 0;
  if (noMatch) noMatch.hidden = !(total > 0 && visible === 0);
}

// Render the "Setlist" row (right under the quick-set BPM buttons) with a
// button for every setlist preset; clicking one applies that preset.
function renderSetlist() {
  const row = $("setlistPresets");
  if (!row) return;
  row.querySelectorAll(".setlist").forEach((b) => b.remove());
  const items = latestPresets.filter((p) => p.inSetlist);
  if (!items.length) { row.hidden = true; return; }
  row.hidden = false;
  for (const p of items) {
    const b = document.createElement("button");
    b.className = "setlist";
    b.type = "button";
    b.textContent = p.name;
    b.title = `${p.bpm} BPM · ${SUB_LABELS[p.subdivision] || p.subdivision} · ${p.beatsPerMeasure}/m`;
    b.addEventListener("click", () => applyPreset(p));
    row.appendChild(b);
  }
}

// Toggle a preset's setlist flag, then refresh both the list and the row.
async function toggleSetlist(name) {
  const current = latestPresets.find((p) => p.name === name);
  const inSetlist = !(current && current.inSetlist);
  const res = await fetch(`${API.presets}/${encodeURIComponent(name)}/setlist`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ inSetlist }),
  });
  if (res.ok) {
    const data = await res.json();
    renderPresets(data.presets || []);
  }
}

// Save the current settings (minus volume) under the entered name.
async function savePresetUI() {
  const nameEl = $("presetName");
  const btn = $("savePresetBtn");
  const name = (nameEl?.value || "").trim();
  if (!name) {
    nameEl?.focus();
    return;
  }
  const c = state.config;
  const payload = {
    name,
    bpm: c.bpm,
    beatsPerMeasure: c.beatsPerMeasure,
    subdivision: c.subdivision,
    accentEveryBeat: c.accentEveryBeat,
    soundSet: c.soundSet,
  };
  if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
  try {
    const res = await fetch(API.presets, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      nameEl.value = "";
      const data = await res.json();
      renderPresets(data.presets || []);
    } else {
      const data = await res.json().catch(() => ({}));
      alert(data.error || "Could not save preset");
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Save preset"; }
  }
}

// Load a saved preset into the running config (volume is left untouched).
async function applyPreset(p) {
  const patch = {
    bpm: p.bpm,
    beatsPerMeasure: p.beatsPerMeasure,
    subdivision: p.subdivision,
    accentEveryBeat: p.accentEveryBeat,
    soundSet: p.soundSet,
  };
  await applyConfig(patch);
}

// Re-save the current settings (minus volume) under an existing preset's name.
async function overwritePresetUI(name, btn) {
  if (!confirm(`Overwrite “${name}” with the current settings?\nThe saved values will be replaced.`)) return;
  const c = state.config;
  const payload = {
    name,
    bpm: c.bpm,
    beatsPerMeasure: c.beatsPerMeasure,
    subdivision: c.subdivision,
    accentEveryBeat: c.accentEveryBeat,
    soundSet: c.soundSet,
  };
  if (btn) { btn.disabled = true; }
  try {
    const res = await fetch(API.presets, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      const data = await res.json();
      renderPresets(data.presets || []);
    } else {
      const data = await res.json().catch(() => ({}));
      alert(data.error || "Could not overwrite preset");
    }
  } finally {
    if (btn) { btn.disabled = false; }
  }
}

// Delete a saved preset by name.
async function deletePresetUI(name) {
  if (!confirm(`Delete preset “${name}”?`)) return;
  const res = await fetch(`${API.presets}/${encodeURIComponent(name)}`, { method: "DELETE" });
  if (res.ok) {
    const data = await res.json();
    renderPresets(data.presets || []);
  }
}

// --- Stream --------------------------------------------------------------
// The SSE channel is now a status/visualization feed only: it tells us when a
// beat fires so we can light up the measure dots. It does NOT play audio.
function connectStream() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(API.stream);

  eventSource.onmessage = (event) => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }

    if (data.type === "hello") {
      if (data.config) state.config = { ...state.config, ...data.config };
      setRunning(!!data.running, { fromServer: true });
      syncUiFromConfig();
    } else if (data.type === "click") {
      pulseBeat(data.inMeasure, data.level === "accent");
    }
  };

  eventSource.onerror = () => {
    // EventSource auto-reconnects; flash a subtle indicator.
    setConnection(false);
  };
  eventSource.onopen = () => {
    setConnection(true);
    refreshAudioInfo();
  };
}

// --- Controls -------------------------------------------------------------
async function post(url) {
  const res = await fetch(url, { method: "POST" });
  if (res.ok) {
    const data = await res.json();
    if (data.config) state.config = { ...state.config, ...data.config };
  }
  return res;
}

async function applyConfig(patch) {
  const res = await fetch(API.config, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (res.ok) {
    const data = await res.json();
    state.config = { ...state.config, ...data };
    syncUiFromConfig();
  }
}

async function setRunning(run, { fromServer = false } = {}) {
  state.running = run;
  if (!fromServer) {
    await post(run ? API.start : API.stop);
    // Starting playback can spawn the server's audio worker; refresh the badge.
    refreshAudioInfo();
  }
  const btn = document.getElementById("playBtn");
  const hint = document.getElementById("runHint");
  const device = document.querySelector(".device");
  if (btn) {
    btn.textContent = run ? "⏸ Stop" : "▶ Play";
    btn.classList.toggle("running", run);
  }
  if (hint) hint.textContent = run ? "Metronome is running" : "Metronome is stopped";
  if (device) device.classList.toggle("is-playing", run);
}

// --- UI syncing ----------------------------------------------------------
const $ = (id) => document.getElementById(id);

function syncUiFromConfig() {
  const c = state.config;
  if ($("bpmValue")) $("bpmValue").textContent = c.bpm;
  if ($("bpmSlider")) $("bpmSlider").value = c.bpm;
  markActivePreset(c.bpm);
  if ($("soundSetSel")) $("soundSetSel").value = c.soundSet;
  if ($("beatsSel")) $("beatsSel").value = String(c.beatsPerMeasure);
  if ($("subSel")) $("subSel").value = String(c.subdivision);
  if ($("accentEvery")) $("accentEvery").checked = c.accentEveryBeat;
  renderBeatDots();
}

function renderBeatDots() {
  const wrap = $("beatDots");
  if (!wrap) return;
  const n = state.config.beatsPerMeasure;
  wrap.innerHTML = "";
  for (let i = 1; i <= n; i++) {
    const dot = document.createElement("span");
    dot.className = "beat-dot" + (i === 1 ? " accent" : "");
    dot.dataset.beat = String(i);
    wrap.appendChild(dot);
  }
}

function pulseBeat(beat, accent) {
  const wrap = $("beatDots");
  if (!wrap) return;
  const dot = wrap.querySelector(`[data-beat="${beat}"]`);
  if (!dot) return;
  dot.classList.add("active");
  dot.classList.toggle("accent-flash", accent);
  clearTimeout(dot._t);
  dot._t = setTimeout(() => {
    dot.classList.remove("active", "accent-flash");
  }, Math.max(120, 60000 / state.config.bpm * 0.5));
}

function setConnection(connected) {
  const el = $("conn");
  if (el) {
    el.textContent = connected ? "Connected" : "Reconnecting…";
    el.classList.toggle("offline", !connected);
  }
}

// --- Wiring --------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  // Play / stop
  $("playBtn").addEventListener("click", async () => {
    await setRunning(!state.running);
  });

  // BPM slider
  $("bpmSlider").addEventListener("input", (e) => {
    const bpm = Number(e.target.value);
    $("bpmValue").textContent = bpm;
    state.config.bpm = bpm;
  });
  $("bpmSlider").addEventListener("change", (e) => applyConfig({ bpm: Number(e.target.value) }));

  // Quick BPM nudge buttons
  $("bpmMinus").addEventListener("click", () => nudgeBpm(-1));
  $("bpmPlus").addEventListener("click", () => nudgeBpm(1));
  $("bpmMinusBig").addEventListener("click", () => nudgeBpm(-5));
  $("bpmPlusBig").addEventListener("click", () => nudgeBpm(5));

  // Quick-set tempo preset buttons
  document.querySelectorAll(".preset").forEach((btn) => {
    btn.addEventListener("click", () => setBpm(Number(btn.dataset.bpm)));
  });

  // Beats per measure
  $("beatsSel").addEventListener("change", (e) => {
    const v = Number(e.target.value);
    applyConfig({ beatsPerMeasure: v });
  });

  // Subdivision (rhythm density)
  $("subSel").addEventListener("change", (e) => applyConfig({ subdivision: Number(e.target.value) }));

  // Sound set (which tick/accent sounds to use)
  $("soundSetSel").addEventListener("change", (e) => applyConfig({ soundSet: e.target.value }));
  $("previewBtn").addEventListener("click", () => previewSoundSet());
  $("refreshSoundsBtn").addEventListener("click", () => loadSoundSets());

  // Song presets
  $("savePresetBtn").addEventListener("click", () => savePresetUI());
  $("refreshPresetsBtn").addEventListener("click", () => loadPresets());
  $("downloadPresetsBtn").addEventListener("click", () => downloadPresets());
  $("uploadPresetsBtn").addEventListener("click", () => $("presetFile").click());
  $("presetFile").addEventListener("change", () => importPresets());
  $("presetSearch").addEventListener("input", () => filterPresets());
  $("presetName").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); savePresetUI(); }
  });

  // Accent every beat
  $("accentEvery").addEventListener("change", (e) => applyConfig({ accentEveryBeat: e.target.checked }));

  // Tap tempo
  const taps = [];
  $("tapBtn").addEventListener("click", () => {
    const now = performance.now();
    taps.push(now);
    if (taps.length > 4) taps.shift();
    if (taps.length >= 2) {
      const intervals = [];
      for (let i = 1; i < taps.length; i++) intervals.push(taps[i] - taps[i - 1]);
      const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const bpm = Math.round(Math.min(300, Math.max(40, 60000 / avg)));
      $("bpmSlider").value = bpm;
      $("bpmValue").textContent = bpm;
      state.config.bpm = bpm;
      applyConfig({ bpm });
    }
  });

  // Keyboard: space to toggle
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space" && e.target === document.body) {
      e.preventDefault();
      setRunning(!state.running);
    }
  });

  // Init
  syncUiFromConfig();
  loadSoundSets();
  loadPresets();
  refreshAudioInfo();
  startAudioPolling();
  connectStream();
});

function nudgeBpm(delta) {
  setBpm(state.config.bpm + delta);
}

// Set the tempo to a specific value (used by the quick-set preset buttons).
function setBpm(value) {
  const next = Math.min(300, Math.max(40, Math.round(Number(value) || 0)));
  $("bpmSlider").value = next;
  $("bpmValue").textContent = next;
  state.config.bpm = next;
  markActivePreset(next);
  applyConfig({ bpm: next });
}

// Highlight the preset button whose BPM matches the current tempo (if any).
function markActivePreset(bpm) {
  document.querySelectorAll(".preset").forEach((btn) => {
    btn.classList.toggle("is-active", Number(btn.dataset.bpm) === bpm);
  });
}
