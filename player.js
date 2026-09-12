// Server-side audio playback.
//
// The metronome's clicks are played by the SERVER (not the browser) so the
// sound keeps going even when no browser tab is open. On Windows this is
// delegated to a small, long-lived PowerShell worker (play_worker.ps1) that
// reads base64-encoded WAV lines from stdin and plays each one with the
// system's default audio output (System.Media.SoundPlayer).
//
// This module owns that worker process:
//   - lazily spawns it on first use,
//   - plays clicks by writing base64 lines to its stdin,
//   - health-checks it with a ping/pong over stdout,
//   - transparently restarts it if it ever dies.
//
// Everything degrades gracefully: if the worker cannot be spawned (e.g. no
// PowerShell available), play() simply becomes a no-op and the rest of the
// server still works.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = path.join(here, "play_worker.ps1");

const BACKEND = "windows/soundplayer";

function powershellArgs(script) {
  return ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script];
}

export class AudioPlayer {
  constructor() {
    this.proc = null;
    this.backend = BACKEND;
    this.available = false;
    this._pending = new Map();      // id -> {resolve, timer}
    this._idCounter = 0;
  }

  get isAlive() {
    return !!(this.proc && !this.proc.killed && this.proc.exitCode === null);
  }

  // Spawn the worker if it is not already running and ready.
  async _ensureWorker() {
    if (this.isAlive) return true;

    try {
      this.proc = spawn("powershell", powershellArgs(WORKER_SCRIPT), {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      console.error("[audio] failed to spawn worker:", err.message);
      this.available = false;
      return false;
    }

    this.proc.on("error", (err) => {
      console.error("[audio] worker spawn error:", err.message);
      this.available = false;
      this.proc = null;
    });
    this.proc.on("exit", (code) => {
      // Resolve any pending pings as failures, then clear.
      for (const { resolve, timer } of this._pending.values()) {
        clearTimeout(timer);
        resolve(null);
      }
      this._pending.clear();
      this.proc = null;
    });

    // Accumulate stdout into line-buffered responses.
    let stdoutBuf = "";
    this.proc.stdout.on("data", (d) => {
      stdoutBuf += d.toString("utf8");
      let idx;
      while ((idx = stdoutBuf.indexOf("\n")) !== -1) {
        const line = stdoutBuf.slice(0, idx).replace(/\r$/, "").trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        this._handleStdoutLine(line);
      }
    });

    // Wait until the worker is ready (it prints "ready" on startup? No — it
    // just starts reading stdin). Give PowerShell a moment to boot, then
    // confirm with a ping.
    this.available = true;
    await new Promise((r) => setTimeout(r, 1200));
    const pong = await this._ping(1500);
    if (pong !== "pong") {
      console.warn("[audio] worker did not respond to ping; will retry lazily");
      // Keep the process; play() may still work.
    }
    return true;
  }

  _handleStdoutLine(line) {
    if (line === "pong") {
      // Answer the oldest pending ping (Map preserves insertion order).
      const first = this._pending.keys().next();
      if (!first.done) {
        const id = first.value;
        const { resolve, timer } = this._pending.get(id);
        this._pending.delete(id);
        clearTimeout(timer);
        resolve("pong");
      }
    } else if (line.startsWith("err:")) {
      console.warn("[audio] worker:", line.slice(4).trim());
    }
  }

  _ping(timeoutMs = 1500) {
    if (!this.isAlive) return Promise.resolve(null);
    const id = ++this._idCounter;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        resolve(null);
      }, timeoutMs);
      this._pending.set(id, { resolve, timer });
      try {
        this.proc.stdin.write("ping\n");
      } catch {
        clearTimeout(timer);
        this._pending.delete(id);
        resolve(null);
      }
    });
  }

  // Internal: send a single protocol line to the worker's stdin.
  _send(line) {
    if (!this.isAlive) throw new Error("worker not running");
    this.proc.stdin.write(line + "\n");
  }

  // Play a 16-bit PCM WAV Buffer on the default output device.
  // Resolves to true if it was handed to the worker, false otherwise.
  async play(wavBuffer) {
    if (!wavBuffer || wavBuffer.length < 44) return false;
    const ok = await this._ensureWorker();
    if (!ok || !this.isAlive) return false;
    try {
      const b64 = wavBuffer.toString("base64");
      // base64 is one long token; send it on a single line prefixed with the
      // "b64" verb so the worker dispatches it correctly (vs. a bare payload).
      this._send(`b64 ${b64}`);
      return true;
    } catch (err) {
      console.error("[audio] play failed:", err.message);
      return false;
    }
  }

  // Snapshot of backend status for the UI / API.
  status() {
    return {
      backend: this.available ? this.backend : "unavailable",
      workerAlive: this.isAlive,
    };
  }

  // Stop playback and terminate the worker.
  close() {
    if (this.isAlive) {
      try { this.proc.stdin.write("quit\n"); } catch { /* ignore */ }
      setTimeout(() => {
        try { this.proc.kill(); } catch { /* ignore */ }
      }, 250).unref?.();
    }
  }
}

// Shared singleton so the whole server uses one worker.
export const audioPlayer = new AudioPlayer();
