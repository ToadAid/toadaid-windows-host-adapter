# WA-P1A.2 native regression fixture: one disposable window with SYNTHETIC
# values only. Observation target; closes on the close file or after a bound.
param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-f0-9]{16}$')][string]$Nonce,
  [Parameter(Mandatory = $true)][string]$CloseFile,
  [ValidateRange(10, 300)][int]$LifetimeSeconds = 120
)
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
namespace WaP1a2Fixture {
  public static class N {
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder name, int max);
    public static string ClassOf(IntPtr h) { var sb = new StringBuilder(256); GetClassName(h, sb, sb.Capacity); return sb.ToString(); }
  }
}
"@
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$screen = [System.Windows.Forms.Screen]::PrimaryScreen
$form = New-Object System.Windows.Forms.Form
$form.Text = "WA-P1A.2 safety fixture $Nonce"
$form.StartPosition = "Manual"
$form.Location = New-Object System.Drawing.Point(($screen.WorkingArea.Left + 80), ($screen.WorkingArea.Top + 80))
$form.Size = New-Object System.Drawing.Size(520, 300)
$form.TopMost = $true
$form.ShowInTaskbar = $false

$label = New-Object System.Windows.Forms.Label
$label.Text = "WA-P1A.2 visible label"
$label.AutoSize = $true
$label.Location = New-Object System.Drawing.Point(16, 16)
$ordinary = New-Object System.Windows.Forms.TextBox
$ordinary.Name = "wa-p1a2-ordinary"
$ordinary.Text = "wa-p1a2-ordinary-value-$Nonce"
$ordinary.Location = New-Object System.Drawing.Point(16, 56)
$ordinary.Width = 300
$secret = New-Object System.Windows.Forms.TextBox
$secret.Name = "wa-p1a2-secret"
$secret.UseSystemPasswordChar = $true
$secret.Text = "wa-p1a2-secret-value-$Nonce"
$secret.Location = New-Object System.Drawing.Point(16, 96)
$secret.Width = 300
$outside = New-Object System.Windows.Forms.Label
$outside.Text = "WA-P1A.2 outside label"
$outside.AutoSize = $true
$outside.Location = New-Object System.Drawing.Point(-3000, -3000)
foreach ($c in @($label, $ordinary, $secret, $outside)) { $form.Controls.Add($c) }

$deadline = [DateTime]::UtcNow.AddSeconds($LifetimeSeconds)
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 200
$timer.Add_Tick({
  if ([System.IO.File]::Exists($CloseFile) -or [DateTime]::UtcNow -gt $deadline) { $timer.Stop(); $form.Close() }
})
$form.Add_Shown({
  $form.Activate()
  $p = [System.Diagnostics.Process]::GetCurrentProcess()
  [Console]::Out.WriteLine((@{
    marker = "WA_P1A2_FIXTURE_READY"
    pid = $p.Id
    hwnd = [int64]$form.Handle
    bounds = @{ left = $form.Bounds.Left; top = $form.Bounds.Top; right = $form.Bounds.Right; bottom = $form.Bounds.Bottom }
    secretBounds = (& { $r = $form.RectangleToScreen($secret.Bounds); @{ left = $r.Left; top = $r.Top; right = $r.Right; bottom = $r.Bottom } })
    ordinaryBounds = (& { $r = $form.RectangleToScreen($ordinary.Bounds); @{ left = $r.Left; top = $r.Top; right = $r.Right; bottom = $r.Bottom } })
    secretClassName = [WaP1a2Fixture.N]::ClassOf($secret.Handle)
    primary = @{ left = $screen.Bounds.Left; top = $screen.Bounds.Top; right = $screen.Bounds.Right; bottom = $screen.Bounds.Bottom }
  } | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
  $timer.Start()
})
[System.Windows.Forms.Application]::Run($form)
