# Metronome playback worker.
#
# Plays WAV sounds on the system's DEFAULT playback device as soon as they are
# received on stdin. This keeps a dedicated process alive so the server can
# push clicks over a loopback socket and the metronome keeps sounding even when
# no browser is open.
#
# Protocol (stdin, one message per line):
#   b64  <base64 of a 16-bit PCM WAV>     -> play an in-memory WAV
#   ping                                  -> respond with "pong"
#   quit                                  -> stop and exit
#   <bare base64>                         -> legacy: treat as an in-memory WAV
#
# Runs with:  powershell -NoProfile -ExecutionPolicy Bypass -File play_worker.ps1

$ErrorActionPreference = "Stop"

# SoundPlayer reads the WAV lazily/asynchronously, so we cannot delete the
# file right after Play() — doing so while it is still reading is what causes a
# brief glitch after each click. Instead we rotate through a small pool of
# fixed-name files and only reuse a file many clicks later (by which time any
# earlier playback of it is long finished). Files are cleaned up on exit.
$poolSize = 32
$poolIndex = 0
$poolPath = @(0..($poolSize - 1)) | ForEach-Object { Join-Path $env:TEMP ("metronom_pool_{0}.wav" -f $_) }

# Play a base64-encoded WAV on the system default device (rotating temp pool).
function Invoke-Base64Wav([string]$b64) {
  $bytes = [Convert]::FromBase64String($b64)
  if ($bytes.Length -lt 44) { return }

  $path = $poolPath[$poolIndex]
  $poolIndex = ($poolIndex + 1) % $poolSize
  [System.IO.File]::WriteAllBytes($path, $bytes)

  $sp = New-Object System.Media.SoundPlayer -ArgumentList $path
  [void]$sp.Play()
  # Keep the audio thread from racing ahead of us issuing the next click.
  Start-Sleep -Milliseconds 25
}

# Remove the temp pool (safe now that no playback is pending).
function Clear-Pool {
  foreach ($p in $poolPath) { Remove-Item $p -Force -ErrorAction SilentlyContinue }
}

# Read lines from stdin until it closes (or "quit" is received).
# Console.ReadLine() is blocking but returns each line as soon as it is sent.
while ($true) {
  $line = [System.Console]::ReadLine()
  if ($null -eq $line) { break }   # stdin closed
  $line = $line.Trim()
  if ($line.Length -eq 0) { continue }

  if ($line -eq "quit") { break }
  if ($line -eq "ping") { Write-Output "pong"; [Console]::Out.Flush(); continue }

  # Protocol lines start with a known verb; anything else is a bare base64 WAV.
  if ($line.StartsWith("b64 ", [StringComparison]::Ordinal)) {
    try { Invoke-Base64Wav $line.Substring(4).Trim() } catch { Write-Warning "play failed: $($_.Exception.Message)" }
    continue
  }

  # Legacy: a bare base64 WAV payload.
  try {
    Invoke-Base64Wav $line
  } catch {
    Write-Warning "play failed: $($_.Exception.Message)"
  }
}

# We are exiting (quit or stdin closed): safe to remove the temp pool now.
Clear-Pool
