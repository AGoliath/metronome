import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateClick, toWav, scaleSamples } from "./audio.js";
import { audioPlayer } from "./player.js";
import { getDeviceName } from "./device.js";
import { listSoundSets, resolveSoundSet, loadSetAudio, BUILTIN_ID } from "./sounds.js";
import { listPresets, savePreset, deletePreset, setSetlist, exportPresets, importPresets } from "./presets.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const SAMPLE_RATE = 44100;

// ---------------------------------------------------------------------------
// Metronome configuration (shared mutable state)
// ---------------------------------------------------------------------------
const config = {
  running: false,
  bpm: 120,               // 40..300
  beatsPerMeasure: 4,     // 1..16 (top number of the time signature)
  subdivision: 1,         // 1 = beat, 2 = eighths, 3 = triplets, 4 = sixteenths
  accentEveryBeat: false, // accent every beat vs. only the downbeat
  volume: 0.75,           // 0..1
  soundSet: BUILTIN_ID,   // id of the active sound set (see sounds/)
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// Validate + coerce an incoming config object, returning a sanitized copy.
function sanitizeConfig(incoming) {
  const next = { ...config };
  if (incoming) {
    if (typeof incoming.bpm === "number" && isFinite(incoming.bpm))
      next.bpm = clamp(Math.round(incoming.bpm), 40, 300);
    if (typeof incoming.beatsPerMeasure === "number" && isFinite(incoming.beatsPerMeasure))
      next.beatsPerMeasure = clamp(Math.round(incoming.beatsPerMeasure), 1, 16);
    if ([1, 2, 3, 4].includes(incoming.subdivision))
      next.subdivision = incoming.subdivision;
    if (typeof incoming.accentEveryBeat === "boolean")
      next.accentEveryBeat = incoming.accentEveryBeat;
    if (typeof incoming.volume === "number" && isFinite(incoming.volume))
      next.volume = clamp(incoming.volume, 0, 1);
    // soundSet must be a currently available set id (or the built-in).
    if (typeof incoming.soundSet === "string") {
      const ids = listSoundSets().map((s) => s.id);
      if (ids.includes(incoming.soundSet)) next.soundSet = incoming.soundSet;
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// Beat scheduler (lookahead model — "A Tale of Two Clocks")
// ---------------------------------------------------------------------------
// The scheduler pre-computes which beats fall inside a small lookahead window
// and emits each one as it is due. The browser plays the sound at the exact
// AudioContext time so timing stays tight even under browser event jitter.
const LOOKAHEAD_MS = 25;      // how far ahead we compute beats
const SCHEDULER_INTERVAL_MS = 8; // how often we run the scheduler

let schedulerTimer = null;
let nextBeatTime = 0;         // performance.now() ms of the next scheduled beat
let currentBeat = 0;          // absolute beat index (0-based)
let streamClients = new Set(); // SSE response writers

// Build the list of clicks that occur "within" one beat when a subdivision
// is applied. Returns an array of { offsetMs, accent, level } offsets
// relative to the beat's start time.
function clicksForBeat(beatIndex, c) {
  const beatDuration = (60000 / c.bpm);
  const sub = c.subdivision;

  if (sub === 1) {
    // One click per beat: accent the downbeat (or every beat if requested).
    const accent = c.accentEveryBeat || beatIndex % c.beatsPerMeasure === 0;
    return [{ offsetMs: 0, accent, level: accent ? "accent" : "tick" }];
  }

  // Even/even subdivision (straight 8th/16th feel).
  const step = beatDuration / sub;
  const clicks = [];
  for (let i = 0; i < sub; i++) {
    const onDownbeat = beatIndex % c.beatsPerMeasure === 0 && i === 0;
    const accent = c.accentEveryBeat ? (i === 0) : onDownbeat;
    clicks.push({ offsetMs: i * step, accent, level: accent ? "accent" : "tick" });
  }
  return clicks;
}

function schedulerTick() {
  const now = performance.now();
  const c = config;
  while (nextBeatTime < now + LOOKAHEAD_MS) {
    const beatDuration = 60000 / c.bpm;
    for (const click of clicksForBeat(currentBeat, c)) {
      emitClick({
        when: nextBeatTime + click.offsetMs,
        level: click.level,
        beat: currentBeat,
        inMeasure: (currentBeat % c.beatsPerMeasure) + 1,
      });
    }
    nextBeatTime += beatDuration;
    currentBeat += 1;
  }
}

function startScheduler() {
  if (schedulerTimer) return;
  nextBeatTime = performance.now() + 50; // small lead-in
  currentBeat = 0;
  schedulerTimer = setInterval(schedulerTick, SCHEDULER_INTERVAL_MS);
  schedulerTick();
}

function stopScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Server-side playback + Server-Sent Events (status/visualization channel)
// ---------------------------------------------------------------------------
// The SERVER plays each click (so the sound keeps going with no browser open).
// The click is scheduled to fire at its exact beat time, and the same event is
// also broadcast to any open web UI over SSE purely for visualization.
//
// Render a set's click (file or built-in) into a WAV Buffer that honors the
// master volume. For file sets this loads the (decoded, peak-normalized)
// samples, scales them by volume, and re-encodes; for the built-in set it
// synthesizes directly. This is why the Volume slider now works for every set,
// and why all file sets play at a consistent level.
function clickBufferFor(setId, level) {
  const isAccent = level === "accent";
  try {
    const set = resolveSoundSet(setId);
    if (set.source === "file") {
      const { tick, accent, sampleRate } = loadSetAudio(setId);
      const samples = scaleSamples(isAccent ? accent : tick, config.volume);
      return toWav(samples, sampleRate);
    }
  } catch {
    /* fall through to the built-in click below */
  }
  return generateClick({ accent: isAccent, volume: config.volume });
}

// The active set's click, honoring the master volume (used for playback + /api/click).
function clickBuffer(level) {
  return clickBufferFor(config.soundSet, level);
}

//
// Play one click at the given time, using whichever sound set is active.
// The click is always rendered to WAV bytes (file sets are normalized + scaled
// by the master volume; the built-in set is synthesized) and handed to the
// worker, so behavior is identical for both sources.
function scheduleClick(when, level) {
  const play = () => {
    const wav = clickBuffer(level);
    audioPlayer.play(wav);
  };

  const delay = Math.max(0, when - performance.now());
  if (delay < 1.5) play();
  else setTimeout(play, delay);
}

function emitClick(payload) {
  // Server-side playback (the actual sound).
  scheduleClick(payload.when, payload.level);

  // Optional SSE broadcast (browser visualization / status only).
  const line = `data: ${JSON.stringify({ type: "click", ...payload })}\n\n`;
  for (const writer of streamClients) {
    try { writer.write(line); } catch { /* client gone */ }
  }
}

function handleStream(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`data: ${JSON.stringify({ type: "hello", config, running: config.running })}\n\n`);
  res.write(`:ok\n\n`);

  streamClients.add(res);
  const keepAlive = setInterval(() => {
    try { res.write(`:keepalive\n\n`); } catch { /* ignore */ }
  }, 15000);

  req.on("close", () => {
    clearInterval(keepAlive);
    streamClients.delete(res);
  });
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { resolve({}); }
    });
  });
}

// Return a WAV Buffer for the active sound set (synthesized for the built-in
// set, or normalized + volume-scaled for file-based sets).
async function clickWav({ accent }) {
  return clickBuffer(accent ? "accent" : "tick");
}

async function handleClick(req, res, url) {
  const params = url.searchParams;
  const accent = params.get("level") === "accent";

  try {
    const wav = await clickWav({ accent });
    res.writeHead(200, {
      "Content-Type": "audio/wav",
      "Content-Length": wav.length,
      "Cache-Control": "no-store",
    });
    res.end(wav);
  } catch (err) {
    console.error("Failed to generate click:", err);
    sendJson(res, 500, { error: "Audio generation failed" });
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";

  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end("Forbidden"); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// Request router
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const route = `${req.method} ${url.pathname}`;

  try {
    if (route === "GET /api/stream") return handleStream(req, res);
    if (route === "GET /api/click") return await handleClick(req, res, url);
    if (route === "GET /api/config") return sendJson(res, 200, config);

    // List the available sound sets (freshly discovered from sounds/).
    if (route === "GET /api/sounds") {
      return sendJson(res, 200, { active: config.soundSet, sets: listSoundSets({ refresh: true }) });
    }

    // Play a one-shot preview of a set's tick and accent (for the UI's
    // "preview" button and the CLI's `preview` command).
    if (route === "POST /api/preview") {
      const body = await readBody(req);
      const id = typeof body?.soundSet === "string" ? body.soundSet : config.soundSet;
      let set;
      try {
        set = resolveSoundSet(id);
      } catch (err) {
        return sendJson(res, 404, { error: err.message });
      }

      const fire = (wav) => {
        try { audioPlayer.play(wav); } catch { /* worker may not be ready yet */ }
      };
      fire(clickBufferFor(id, "tick"));
      setTimeout(() => fire(clickBufferFor(id, "accent")), 180);

      return sendJson(res, 200, { ok: true, soundSet: set.id });
    }

    // --- Song presets (all selectable options except volume) --------------
    if (route === "GET /api/presets") {
      return sendJson(res, 200, { presets: listPresets() });
    }

    // Download the presets as a standalone JSON file (matches presets.json).
    if (route === "GET /api/presets/export") {
      const raw = JSON.stringify(exportPresets(), null, 2) + "\n";
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": 'attachment; filename="metronome-presets.json"',
        "Cache-Control": "no-store",
      });
      res.end(raw);
      return;
    }

    // Replace the whole preset list from an uploaded file.
    if (route === "POST /api/presets/import") {
      const body = await readBody(req);
      try {
        importPresets(body);
        return sendJson(res, 200, { ok: true, presets: listPresets() });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    if (route === "POST /api/presets") {
      const body = await readBody(req);
      try {
        const preset = savePreset(body);
        return sendJson(res, 200, { ok: true, preset, presets: listPresets() });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    const presetDelete = url.pathname.match(/^\/api\/presets\/([^/]+)$/);
    if (req.method === "DELETE" && presetDelete) {
      try {
        const removed = deletePreset(decodeURIComponent(presetDelete[1]));
        if (!removed) return sendJson(res, 404, { error: "No such preset" });
        return sendJson(res, 200, { ok: true, presets: listPresets() });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    const presetFav = url.pathname.match(/^\/api\/presets\/([^/]+)\/(favorite|setlist)$/);
    if (req.method === "POST" && presetFav) {
      const body = await readBody(req);
      const inSetlist = body && (body.inSetlist === true || body.favorite === true);
      const updated = setSetlist(decodeURIComponent(presetFav[1]), inSetlist);
      if (!updated) return sendJson(res, 404, { error: "No such preset" });
      return sendJson(res, 200, { ok: true, presets: listPresets() });
    }

    if (route === "POST /api/config") {
      const body = await readBody(req);
      Object.assign(config, sanitizeConfig(body));
      return sendJson(res, 200, config);
    }

    if (route === "POST /api/start") {
      config.running = true;
      startScheduler();
      return sendJson(res, 200, { running: true, config });
    }

    if (route === "POST /api/stop") {
      config.running = false;
      stopScheduler();
      return sendJson(res, 200, { running: false, config });
    }

    if (route === "GET /api/health") {
      return sendJson(res, 200, { ok: true, running: config.running, config });
    }

    if (route === "GET /api/audio") {
      // Which output device is the server playing on, and is the playback
      // backend healthy?
      let deviceName = "System default output";
      try { deviceName = await getDeviceName(); } catch { /* keep fallback */ }
      return sendJson(res, 200, { ...audioPlayer.status(), deviceName });
    }

    if (req.method === "GET") return serveStatic(req, res, url);

    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
  } catch (err) {
    console.error("Request error:", err);
    if (!res.headersSent) sendJson(res, 500, { error: "Internal server error" });
  }
});

server.listen(PORT, () => {
  console.log(`Metronome running at http://localhost:${PORT}`);
  console.log(`  • Sound is played by the SERVER on this machine's default audio output.`);
  console.log(`  • Keep the server running (no browser needed) for the clicks to continue.`);
  console.log(`  • CLI: node cli.js  (start/stop/status from the terminal)`);

  // Pre-resolve the device name so the first /api/audio call is instant.
  getDeviceName().then((name) => {
    console.log(`  • Default output device: ${name}`);
  }).catch(() => {
    console.log(`  • Default output device: (could not determine name)`);
  });
});

// ---------------------------------------------------------------------------
// Graceful shutdown: stop the scheduler and terminate the playback worker.
// ---------------------------------------------------------------------------
function shutdown(reason) {
  console.log(`\n[metronome] ${reason} — shutting down.`);
  stopScheduler();
  audioPlayer.close();
  server.close(() => process.exit(0));
  // Force-exit if the server refuses to close within a moment.
  setTimeout(() => process.exit(0), 1500).unref?.();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
