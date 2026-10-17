# WA-P1B read-only environment and window-identity probe. Reads only; emits one
# JSON line. Account identity is emitted as a SHA-256 of the user SID, never a name.
param(
  [ValidatePattern('^[0-9]{1,20}$')][string]$Hwnd = ""
)
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
namespace WaP1bProbe {
  public static class N {
    [DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId();
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr GetThreadDesktop(uint threadId);
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool GetUserObjectInformation(IntPtr h, int index, StringBuilder buffer, int length, out int needed);
    [DllImport("user32.dll")] public static extern IntPtr GetThreadDpiAwarenessContext();
    [DllImport("user32.dll")] public static extern int GetAwarenessFromDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    public static string ObjectName(IntPtr h) {
      var sb = new StringBuilder(256);
      int needed;
      return GetUserObjectInformation(h, 2, sb, sb.Capacity * 2, out needed) ? sb.ToString() : null;
    }
  }
}
"@

function Sha256Text([string]$t) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($t)))).Replace("-", "").ToLowerInvariant() }
  finally { $sha.Dispose() }
}

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$integrity = "UNKNOWN"
# WindowsIdentity.Groups omits the mandatory integrity label; read it from the
# token's group list as printed by whoami (read-only, local, explicit path).
$labelSids = @()
try {
  $whoami = [System.IO.Path]::Combine([Environment]::SystemDirectory, "whoami.exe")
  $labelSids = @(& $whoami /groups /fo csv /nh | ForEach-Object { ($_ -split '","')[2] } | Where-Object { $_ -like 'S-1-16-*' })
} catch {}
foreach ($g in @($identity.Groups | ForEach-Object { $_.Value }) + $labelSids) {
  switch ($g) {
    "S-1-16-4096" { $integrity = "LOW" }
    "S-1-16-8192" { $integrity = "MEDIUM" }
    "S-1-16-8448" { $integrity = "MEDIUM_PLUS" }
    "S-1-16-12288" { $integrity = "HIGH" }
    "S-1-16-16384" { $integrity = "SYSTEM" }
  }
}
$proc = [System.Diagnostics.Process]::GetCurrentProcess()
$cv = Get-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion" -ErrorAction SilentlyContinue
$appliedDpi = $null
try { $appliedDpi = [int](Get-ItemProperty -Path "HKCU:\Control Panel\Desktop\WindowMetrics" -Name AppliedDPI -ErrorAction Stop).AppliedDPI } catch {}
$awareness = $null
try { $awareness = [WaP1bProbe.N]::GetAwarenessFromDpiAwarenessContext([WaP1bProbe.N]::GetThreadDpiAwarenessContext()) } catch {}
Add-Type -AssemblyName System.Windows.Forms

$out = [ordered]@{
  marker = "WA_P1B_ENV"
  osVersion = [Environment]::OSVersion.Version.ToString()
  productName = if ($cv) { [string]$cv.ProductName } else { $null }
  displayVersion = if ($cv -and ($cv.PSObject.Properties.Name -contains "DisplayVersion")) { [string]$cv.DisplayVersion } else { $null }
  currentBuild = if ($cv) { [string]$cv.CurrentBuild } else { $null }
  ubr = if ($cv -and ($cv.PSObject.Properties.Name -contains "UBR")) { [int]$cv.UBR } else { $null }
  is64BitOs = [Environment]::Is64BitOperatingSystem
  is64BitProcess = [Environment]::Is64BitProcess
  processArchitecture = [string]$env:PROCESSOR_ARCHITECTURE
  sessionId = $proc.SessionId
  activeConsoleSessionId = [int][WaP1bProbe.N]::WTSGetActiveConsoleSessionId()
  remoteSession = [bool][System.Windows.Forms.SystemInformation]::TerminalServerSession
  windowStation = [WaP1bProbe.N]::ObjectName([WaP1bProbe.N]::GetProcessWindowStation())
  desktop = [WaP1bProbe.N]::ObjectName([WaP1bProbe.N]::GetThreadDesktop([WaP1bProbe.N]::GetCurrentThreadId()))
  userSidSha256 = Sha256Text $identity.User.Value
  integrityLevel = $integrity
  appliedDpi = $appliedDpi
  probeDpiAwareness = $awareness
  powershellVersion = $PSVersionTable.PSVersion.ToString()
  clrVersion = [Environment]::Version.ToString()
}

if ($Hwnd -ne "") {
  $h = [IntPtr]::new([Int64]$Hwnd)
  $pidOut = [uint32]0
  $alive = [WaP1bProbe.N]::IsWindow($h)
  $null = [WaP1bProbe.N]::GetWindowThreadProcessId($h, [ref]$pidOut)
  $window = [ordered]@{ isWindow = [bool]$alive; ownerPid = [int]$pidOut; ownerSessionId = $null; ownerStartUtc = $null }
  if ($alive -and $pidOut -ne 0) {
    try {
      $p = [System.Diagnostics.Process]::GetProcessById([int]$pidOut)
      $window.ownerSessionId = $p.SessionId
      $window.ownerStartUtc = $p.StartTime.ToUniversalTime().ToString("o")
    } catch {}
  }
  $out.window = $window
}

[Console]::Out.Write(($out | ConvertTo-Json -Compress -Depth 4))
