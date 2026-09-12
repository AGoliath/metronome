# Resolve the friendly name of the Windows DEFAULT audio render (playback) device.
#
# Output: a single line on stdout.
#   - The device name if it can be determined (e.g. "Speakers (Realtek ...)").
#   - "System default output" as a graceful fallback when discovery is not
#     possible (e.g. sandboxed environments where the audio COM API / WMI is
#     unavailable).
#
# Runs with:  powershell -NoProfile -ExecutionPolicy Bypass -File get_device_name.ps1
# Exit code is always 0 so the server never hard-fails on this.

$ErrorActionPreference = "Continue"
$name = $null

# --- Layer 0: MME / WinMM default — the endpoint the sound ACTUALLY plays on
# System.Media.SoundPlayer (used by the playback worker) is built on the WinMM
# waveOut stack, whose default is device index 0 (WAVE_MAPPER). That is the
# endpoint the click is genuinely heard on, so it takes priority over the Core
# Audio "default" — Windows can set those two to DIFFERENT endpoints, and in
# that case Core Audio's default (what the old code reported) was misleading.
function Get-MmeDefaultName {
  try {
    $csharp = @"
using System;
using System.Runtime.InteropServices;
public class MMEDefault {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct WAVEOUTCAPS {
    public ushort wMid; public ushort wPid; public uint dwDriverVersion;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string a;
    public uint dwFormats; public ushort wChannels; public ushort wReserved;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string b;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string c;
  }
  [DllImport("winmm.dll", CharSet = CharSet.Unicode)] public static extern int waveOutGetNumDevs();
  [DllImport("winmm.dll", CharSet = CharSet.Unicode)] public static extern int waveOutGetDevCaps(uint n, out WAVEOUTCAPS caps, uint size);
  // A "good" name has real ASCII text and no CJK/mojibake (which appears when
  // the struct layout is off or the name is not UTF-16 clean).
  static bool Good(string s) {
    if (s == null) return false;
    bool hasAscii = false, hasCjk = false;
    foreach (char ch in s) {
      if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9')) hasAscii = true;
      if (ch >= 0x4E00 && ch <= 0x9FFF) hasCjk = true;
    }
    return hasAscii && !hasCjk;
  }
  public static string Name() {
    if (waveOutGetNumDevs() == 0) return null;
    WAVEOUTCAPS caps;
    uint size = (uint)Marshal.SizeOf(typeof(WAVEOUTCAPS));
    if (waveOutGetDevCaps(0, out caps, size) != 0) return null;   // index 0 = WAVE_MAPPER default
    foreach (string s in new string[] { caps.a, caps.b, caps.c })
      if (Good(s)) return s.Trim();
    return null;
  }
}
"@
    Add-Type -TypeDefinition $csharp -ErrorAction Stop | Out-Null
    $n = [MMEDefault]::Name()
    if ($n) { return $n }
  } catch {
    return $null
  }
}

# --- Layer 1: Core Audio COM API (authoritative default endpoint) -----------
function Try-ComApi {
  try {
    $csharp = @"
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DBB3F19E2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
  [PreserveSig] int GetDefaultAudioEndpoint([In] int dataFlow, [In] int role, [MarshalAs(UnmanagedType.Interface)] out IMMDevice device);
}
[ComImport, Guid("D666868E-CEB2-4347-A67F-1D7169EE7B32"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
  [PreserveSig] int OpenPropertyStore([In] int stgmAccess, [MarshalAs(UnmanagedType.Interface)] out IPropertyStore store);
}
[ComImport, Guid("886d89b9-2056-4696-975e-7545254131c1"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPropertyStore {
  [PreserveSig] int GetCount(out int count);
  [PreserveSig] int GetAt([In] int index, out PROPERTYKEY key, out PROPVARIANT value);
  [PreserveSig] int Contains([In] ref PROPERTYKEY key, out int contains);
  [PreserveSig] int GetValue([In] ref PROPERTYKEY key, [MarshalAs(UnmanagedType.LPPropVariant)] out object value);
  [PreserveSig] int SetValue([In] ref PROPERTYKEY key, [In] ref PROPVARIANT value);
}
[StructLayout(LayoutKind.Sequential)]
struct PROPERTYKEY { public Guid fmtid; public uint pid; }
[StructLayout(LayoutKind.Sequential)]
struct PROPVARIANT {
  public ushort vt; public ushort wReserved1; public ushort wReserved2; public ushort wReserved3;
  public IntPtr ptr;
}
public class Audio {
  [DllImport("Ole32.dll", PreserveSig=true)]
  public static extern int CreateClassInstance(ref Guid clsid, IntPtr outer, ref Guid iid, out Object o);
  public static string GetDefaultRenderName() {
    Guid clsid = new Guid("BCDE0390-E62F-11D0-A8BB-00A0C922E18B");
    Guid iid  = new Guid("A95664D2-9614-4F35-A746-DE8DBB3F19E2");
    Object o;
    int hr = CreateClassInstance(ref clsid, IntPtr.Zero, ref iid, out o);
    if (hr != 0) return null;
    IMMDeviceEnumerator en = (IMMDeviceEnumerator)o;
    IMMDevice dev;
    int hr2 = en.GetDefaultAudioEndpoint(0, 0, out dev);   // render, console
    if (hr2 != 0 || dev == null) return null;
    IPropertyStore store;
    int hr3 = dev.OpenPropertyStore(0, out store);          // read-only
    if (hr3 != 0 || store == null) return null;
    PROPERTYKEY friendly = new PROPERTYKEY();
    friendly.fmtid = new Guid("a45c254e-debf-4e7d-817a-f6bd74e4ad03");
    friendly.pid = 14;
    object value;
    int hr4 = store.GetValue(ref friendly, out value);
    if (hr4 != 0 || value == null) return null;
    return value as string;
  }
}
"@
    $t = Add-Type -TypeDefinition $csharp -PassThru -ErrorAction Stop
    return [Audio]::GetDefaultRenderName()
  } catch {
    return $null
  }
}

# --- Layer 2: WMI (Win32_SoundDevice) ---------------------------------------
function Try-Wmi {
  try {
    # Prefer the device flagged as default; otherwise fall back to the first "Speakers"-like name.
    $devices = Get-CimInstance -ClassName Win32_SoundDevice -ErrorAction Stop
    $default = $devices | Where-Object { $_.Default -eq 1 -or $_.Default -eq $true } | Select-Object -First 1
    if ($default -and $default.Name) { return $default.Name }
    $any = $devices | Where-Object { $_.Name -and $_.Status -ne "Unavailable" } | Select-Object -First 1
    if ($any -and $any.Name) { return $any.Name }
  } catch { }
  return $null
}

# --- Layer 3: Registry (MMDevices render FriendlyName) ----------------------
function Try-Registry {
  try {
    $base = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Render"
    if (-not (Test-Path $base)) { return $null }
    $friendlyGuid = "{a45c254e-debf-4e7d-817a-f6bd74e4ad03}"
    $devices = Get-ChildItem $base -ErrorAction SilentlyContinue
    foreach ($d in $devices) {
      $st = (Get-ItemProperty $d.PSPath -ErrorAction SilentlyContinue).DeviceState
      if ($st -ne 4) { continue }   # DeviceState 4 == active
      $fn = (Get-ItemProperty "$($d.PSPath)\Properties\$friendlyGuid" -ErrorAction SilentlyContinue).FriendlyName
      if ($fn) { return $fn }
    }
  } catch { }
  return $null
}

# Resolve in order of trust. Layer 0 is the endpoint the playback worker
# (System.Media.SoundPlayer / WinMM) actually plays on, so it wins; the rest
# are fallbacks for environments where the WinMM default can't be read.
$name = Get-MmeDefaultName
if (-not $name) { $name = Try-ComApi }
if (-not $name) { $name = Try-Wmi }
if (-not $name) { $name = Try-Registry }
if (-not $name) { $name = "System default output" }

# Emit a single, clean line (strip CR/LF just in case of odd names).
$clean = ([string]$name).Replace("`r","").Replace("`n","").Trim()
if ([string]::IsNullOrWhiteSpace($clean)) { $clean = "System default output" }
Write-Output $clean
exit 0
