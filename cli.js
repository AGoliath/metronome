#!/usr/bin/env node
// Terminal control for the metronome server.
//
//   node cli.js                     Start the server (if needed) and begin playing.
//   node cli.js stop                Stop the metronome (server keeps running).
//   node cli.js status              Show current config + running state.
//   node cli.js bpm <120>           Set tempo.
//   node cli.js beats <4>           Set beats per measure.
//   node cli.js sub <2>             Set subdivision (1=beat 2=eighths 3=triplets 4=sixteenths).
//   node cli.js accent <on|off>     Toggle accent-every-beat.
//   node cli.js volume <0.7>        Set volume (0-1).
//   node cli.js device              Show which output device the server plays on.
//   node cli.js sounds              List the available sound sets.
//   node cli.js set <id>            Choose the active sound set.
//   node cli.js preview [id]        Play a one-off preview of a set (default: current).
//   node cli.js presets             List saved song presets.
//   node cli.js apply <name>        Apply a saved preset (tempo, beats, subdivision, accent, sound).
//
// All commands talk to the server over HTTP (default http://localhost:3000).
// Audio is played by the SERVER (not the browser), so it keeps going as long
// as the server is running.
const BASE = process.env.METRONOME_URL || "http://localhost:3000";

async function request(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const [cmd = "start", arg] = process.argv.slice(2);

try {
  switch (cmd) {
    case "start":
    case "play": {
      const out = await request("POST", "/api/start");
      console.log(`Playing. ${fmtConfig(out.config)}`);
      break;
    }
    case "stop": {
      const out = await request("POST", "/api/stop");
      console.log(`Stopped. ${fmtConfig(out.config)}`);
      break;
    }
    case "status":
    case "config": {
      const out = await request("GET", "/api/config");
      console.log(fmtConfig(out));
      break;
    }
    case "bpm": {
      const bpm = Number(arg);
      if (!Number.isFinite(bpm)) fail("Usage: node cli.js bpm <tempo>");
      const out = await request("POST", "/api/config", { bpm });
      console.log(`BPM = ${out.bpm}`);
      break;
    }
    case "beats": {
      const beatsPerMeasure = Number(arg);
      if (!Number.isFinite(beatsPerMeasure)) fail("Usage: node cli.js beats <count>");
      const out = await request("POST", "/api/config", { beatsPerMeasure });
      console.log(`Beats per measure = ${out.beatsPerMeasure}`);
      break;
    }
    case "sub": {
      const subdivision = Number(arg);
      if (![1, 2, 3, 4].includes(subdivision)) fail("Usage: node cli.js sub <1|2|3|4>");
      const out = await request("POST", "/api/config", { subdivision });
      console.log(`Subdivision = ${out.subdivision}`);
      break;
    }
    case "accent": {
      const accentEveryBeat = /^(on|1|true|yes)$/i.test(arg || "");
      const out = await request("POST", "/api/config", { accentEveryBeat });
      console.log(`Accent every beat = ${out.accentEveryBeat ? "on" : "off"}`);
      break;
    }
    case "volume": {
      const volume = Number(arg);
      if (!Number.isFinite(volume)) fail("Usage: node cli.js volume <0-1>");
      const out = await request("POST", "/api/config", { volume });
      console.log(`Volume = ${out.volume}`);
      break;
    }
    case "device":
    case "audio": {
      const out = await request("GET", "/api/audio");
      console.log(`Device  = ${out.deviceName}`);
      console.log(`Backend = ${out.backend}`);
      console.log(`Worker  = ${out.workerAlive ? "running" : "idle (spawns on first click)"}`);
      break;
    }
    case "sounds":
    case "sets": {
      const out = await request("GET", "/api/sounds");
      console.log(`Active sound set: ${out.active}`);
      console.log("Available sets:");
      for (const s of out.sets || []) {
        const marker = s.id === out.active ? "•" : " ";
        console.log(`  ${marker} ${s.id}`);
      }
      break;
    }
    case "set": {
      if (!arg) fail("Usage: node cli.js set <sound-set-id>   (see: node cli.js sounds)");
      const out = await request("POST", "/api/config", { soundSet: arg });
      if (out.soundSet !== arg) {
        fail(`"${arg}" is not an available sound set. Try: node cli.js sounds`);
      }
      console.log(`Sound set = ${out.soundSet}`);
      break;
    }
    case "preview": {
      const soundSet = arg || (await request("GET", "/api/config")).soundSet;
      const out = await request("POST", "/api/preview", { soundSet });
      console.log(`Previewed sound set: ${out.soundSet}`);
      break;
    }
    case "presets":
    case "preset-list": {
      const out = await request("GET", "/api/presets");
      const presets = out.presets || [];
      if (!presets.length) { console.log("No presets saved yet."); break; }
      for (const p of presets) {
        console.log(`  • ${p.name}   —   ${p.bpm} BPM · ${p.subdivision} · ${p.beatsPerMeasure}/measure${p.accentEveryBeat ? " · accent every beat" : ""} · ${p.soundSet}`);
      }
      break;
    }
    case "apply":
    case "preset": {
      if (!arg) {
        console.log("No preset name given. Available presets:");
        const list = (await request("GET", "/api/presets")).presets || [];
        for (const p of list) console.log(`  • ${p.name}`);
        break;
      }
      const cfg = (await request("GET", "/api/presets")).presets.find((p) => p.name === arg);
      if (!cfg) { fail(`No preset named "${arg}". List them with: node cli.js presets`); }
      const out = await request("POST", "/api/config", {
        bpm: cfg.bpm,
        beatsPerMeasure: cfg.beatsPerMeasure,
        subdivision: cfg.subdivision,
        accentEveryBeat: cfg.accentEveryBeat,
        soundSet: cfg.soundSet,
      });
      console.log(`Applied preset "${arg}". ${fmtConfig(out)}`);
      break;
    }
    default:
      console.log("Commands: start | stop | status | bpm | beats | sub | accent | volume | device | sounds | set | preview | presets | apply <name>");
      console.log("Example:  node cli.js bpm 96");
      console.log("          node cli.js set woodblock && node cli.js preview");
  }
} catch (err) {
  if (err?.cause?.code === "ECONNREFUSED") {
    fail("Could not reach the metronome server. Start it first:  node server.js");
  }
  fail(`Error: ${err?.message || err}`);
}

function fmtConfig(c) {
  const running = c.running ? "RUNNING" : "stopped";
  return [
    running,
    `bpm ${c.bpm}`,
    `${c.beatsPerMeasure}/measure`,
    `sub ${c.subdivision}`,
    c.accentEveryBeat ? "accent every beat" : "accent downbeat",
    `volume ${c.volume}`,
    c.soundSet ? `sound: ${c.soundSet}` : "",
  ].filter(Boolean).join("  ·  ");
}
