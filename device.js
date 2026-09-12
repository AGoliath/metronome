// Resolve the friendly name of the audio output device the metronome ACTUALLY
// plays on.
//
// Delegates to get_device_name.ps1, which tries (in order of trust):
//   0. MME / WinMM default (WAVE_MAPPER) — the endpoint System.Media.SoundPlayer
//      genuinely plays on. Windows can set this to a DIFFERENT endpoint than
//      the Core Audio default, so it takes priority over the label the old
//      code reported.
//   1. Core Audio COM API (default endpoint),
//   2. WMI Win32_SoundDevice,
//   3. MMDevices registry (FriendlyName),
//   4. a generic "System default output" fallback.
//
// The result is cached for a short TTL so the PowerShell process is not spawned
// on every /api/audio poll, yet the label stays in sync if the default device
// changes. If a re-resolve transiently falls back to the generic label, the
// last real name is retained so the UI never flickers to "System default output".

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, "get_device_name.ps1");

const FALLBACK = "System default output";
// How long a resolved name is trusted before we re-resolve. Kept just under the
// UI's 4s /api/audio poll cadence so the label can't drift out of sync.
const TTL_MS = 5000;

let cached = null;
let cachedAt = 0;
let inFlight = null;

function runDiscovery() {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const finish = (name) => {
      if (settled) return;
      settled = true;
      resolve(name && name.trim() ? name.trim() : FALLBACK);
    };

    let proc;
    try {
      proc = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      return finish(FALLBACK);
    }

    const timer = setTimeout(() => {
      try { proc.kill(); } catch { /* ignore */ }
      finish(FALLBACK);
    }, 8000);

    proc.stdout.on("data", (d) => { out += d.toString("utf8"); });
    proc.on("error", () => { clearTimeout(timer); finish(FALLBACK); });
    proc.on("exit", () => {
      clearTimeout(timer);
      // Take the first non-empty line as the name.
      const line = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      finish(line);
    });
  });
}

// Return the cached device name, resolving it on first use.
// Return the device name, re-resolving once the TTL has elapsed. The last
// good (non-fallback) name is retained across polls, so a transient
// resolution failure never makes the UI blink to "System default output".
export async function getDeviceName() {
  const now = Date.now();
  if (cached && now - cachedAt < TTL_MS) return cached;

  if (!inFlight) inFlight = runDiscovery().finally(() => { inFlight = null; });
  const fresh = await inFlight;

  if (fresh && fresh !== FALLBACK) {
    cached = fresh;
    cachedAt = now;
  } else if (cached) {
    // Keep the previous real name; just refresh its timestamp.
    cachedAt = now;
  } else {
    cached = fresh;
    cachedAt = now;
  }
  return cached;
}
