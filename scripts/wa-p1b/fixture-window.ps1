# WA-P1B disposable SYNTHETIC fixture window. Observation proof target only.
# Shows synthetic, non-sensitive text. No input, clipboard, file, registry or
# process action against anything else. Closes itself when the close file
# appears or after a bounded lifetime.
param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-f0-9]{16}$')][string]$Nonce,
  [Parameter(Mandatory = $true)][string]$CloseFile,
  [ValidateRange(10, 600)][int]$LifetimeSeconds = 240
)
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$screen = [System.Windows.Forms.Screen]::PrimaryScreen

# Cover: hides the operator's real desktop on the primary display while the
# display/region pixels are captured, so screenshots contain only synthetic content.
$cover = New-Object System.Windows.Forms.Form
$cover.Text = "WA-P1B synthetic cover $Nonce"
$cover.FormBorderStyle = "None"
$cover.StartPosition = "Manual"
$cover.Bounds = $screen.Bounds
$cover.BackColor = [System.Drawing.Color]::FromArgb(255, 32, 96, 64)
$cover.TopMost = $true
$cover.ShowInTaskbar = $false

$main = New-Object System.Windows.Forms.Form
$main.Text = "WA-P1B synthetic fixture $Nonce"
$main.StartPosition = "Manual"
$main.Location = New-Object System.Drawing.Point(($screen.Bounds.Left + 120), ($screen.Bounds.Top + 120))
$main.Size = New-Object System.Drawing.Size(640, 400)
$main.BackColor = [System.Drawing.Color]::FromArgb(255, 240, 240, 240)
$main.TopMost = $true
$main.ShowInTaskbar = $false

function New-Label([string]$Text, [int]$X, [int]$Y) {
  $l = New-Object System.Windows.Forms.Label
  $l.Text = $Text
  $l.AutoSize = $true
  $l.Location = New-Object System.Drawing.Point($X, $Y)
  return $l
}

# Two sibling subtrees (panel A / panel B) so traversal must visit siblings.
$panelA = New-Object System.Windows.Forms.Panel
$panelA.Name = "wa-p1b-panel-a"
$panelA.Location = New-Object System.Drawing.Point(16, 16)
$panelA.Size = New-Object System.Drawing.Size(290, 150)
$panelA.Controls.Add((New-Label "WA-P1B synthetic text alpha" 8 8))
$ordinary = New-Object System.Windows.Forms.TextBox
$ordinary.Name = "wa-p1b-ordinary-input"
$ordinary.Text = "synthetic ordinary text"
$ordinary.Location = New-Object System.Drawing.Point(8, 48)
$ordinary.Width = 240
$panelA.Controls.Add($ordinary)

$panelB = New-Object System.Windows.Forms.Panel
$panelB.Name = "wa-p1b-panel-b"
$panelB.Location = New-Object System.Drawing.Point(320, 16)
$panelB.Size = New-Object System.Drawing.Size(290, 150)
$panelB.Controls.Add((New-Label "WA-P1B synthetic text beta" 8 8))
$secret = New-Object System.Windows.Forms.TextBox
$secret.Name = "wa-p1b-password-input"
$secret.UseSystemPasswordChar = $true
$secret.Text = "synthetic-not-a-secret"
$secret.Location = New-Object System.Drawing.Point(8, 48)
$secret.Width = 240
$panelB.Controls.Add($secret)

# A label beneath the occluder: UIA sees it; on-screen pixels show the occluder.
$gamma = New-Label "WA-P1B occluded text gamma" 24 220
# A child positioned far outside the window: geometry must be filtered.
$clipped = New-Label "WA-P1B clipped text delta" -4000 -4000

$main.Controls.Add($panelA)
$main.Controls.Add($panelB)
$main.Controls.Add($gamma)
$main.Controls.Add($clipped)

# Occluder: solid magenta top-level window over the gamma label.
$occluder = New-Object System.Windows.Forms.Form
$occluder.Text = "WA-P1B synthetic occluder $Nonce"
$occluder.FormBorderStyle = "None"
$occluder.StartPosition = "Manual"
$occluder.BackColor = [System.Drawing.Color]::FromArgb(255, 255, 0, 255)
$occluder.TopMost = $true
$occluder.ShowInTaskbar = $false

# A minimized top-level window: invalid/offscreen geometry must be filtered.
$minimized = New-Object System.Windows.Forms.Form
$minimized.Text = "WA-P1B minimized fixture $Nonce"
$minimized.StartPosition = "Manual"
$minimized.Location = New-Object System.Drawing.Point(($screen.Bounds.Left + 200), ($screen.Bounds.Top + 200))
$minimized.Size = New-Object System.Drawing.Size(300, 200)
$minimized.WindowState = "Minimized"
$minimized.Controls.Add((New-Label "WA-P1B minimized text epsilon" 8 8))

$deadline = [DateTime]::UtcNow.AddSeconds($LifetimeSeconds)
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 250
$timer.Add_Tick({
  if ([System.IO.File]::Exists($CloseFile) -or [DateTime]::UtcNow -gt $deadline) {
    $timer.Stop()
    foreach ($f in @($occluder, $minimized, $cover)) { try { $f.Close() } catch {} }
    $main.Close()
  }
})

$main.Add_Shown({
  $cover.Show()
  $minimized.Show()
  $main.BringToFront()
  $main.Activate()
  $origin = $main.PointToScreen($gamma.Location)
  $occluder.Bounds = New-Object System.Drawing.Rectangle(($origin.X - 8), ($origin.Y - 8), 320, 48)
  $occluder.Show()
  $occluder.BringToFront()
  [System.Windows.Forms.Application]::DoEvents()
  $proc = [System.Diagnostics.Process]::GetCurrentProcess()
  $ready = @{
    marker = "WA_P1B_FIXTURE_READY"
    nonce = $Nonce
    pid = $proc.Id
    sessionId = $proc.SessionId
    processStartUtc = $proc.StartTime.ToUniversalTime().ToString("o")
    mainHwnd = [int64]$main.Handle
    minimizedHwnd = [int64]$minimized.Handle
    coverHwnd = [int64]$cover.Handle
    occluderHwnd = [int64]$occluder.Handle
    mainBounds = @{ left = $main.Bounds.Left; top = $main.Bounds.Top; right = $main.Bounds.Right; bottom = $main.Bounds.Bottom }
    occluderBounds = @{ left = $occluder.Bounds.Left; top = $occluder.Bounds.Top; right = $occluder.Bounds.Right; bottom = $occluder.Bounds.Bottom }
    primaryBounds = @{ left = $screen.Bounds.Left; top = $screen.Bounds.Top; right = $screen.Bounds.Right; bottom = $screen.Bounds.Bottom }
  } | ConvertTo-Json -Compress
  [Console]::Out.WriteLine($ready)
  [Console]::Out.Flush()
  $timer.Start()
})

[System.Windows.Forms.Application]::Run($main)
[Console]::Out.WriteLine('{"marker":"WA_P1B_FIXTURE_CLOSED"}')
[Console]::Out.Flush()
