// Resolve the friendly name of the default audio output device.
//
// Delegates to get_device_name.ps1, which tries (in order):
//   1. Core Audio COM API (authoritative default endpoint),
//   2. WMI Win32_SoundDevice,
//   3. MMDevices registry (FriendlyName),
//   4. a generic "System default output" fallback.
//
// The result is cached, so the PowerShell process is spawned at most once.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, "get_device_name.ps1");

const FALLBACK = "System default output";

let cached = null;
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
export async function getDeviceName() {
  if (cached) return cached;
  if (!inFlight) inFlight = runDiscovery().finally(() => { inFlight = null; });
  cached = await inFlight;
  return cached;
}
