$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Sha256-Bytes([byte[]]$Bytes) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace("-", "").ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Sha256-Text([string]$Text) {
  return Sha256-Bytes ([System.Text.Encoding]::UTF8.GetBytes($Text))
}

function Artifact-Token([string]$Epoch) {
  return (Sha256-Text $Epoch).Substring(0, 16)
}

function Write-Utf8JsonArtifact(
  [string]$ArtifactRoot,
  [string]$Id,
  [object]$Value,
  [string]$Kind
) {
  $json = $Value | ConvertTo-Json -Depth 12 -Compress
  $path = [System.IO.Path]::Combine($ArtifactRoot, "$Id.json")
  [System.IO.File]::WriteAllText(
    $path,
    $json,
    [System.Text.UTF8Encoding]::new($false)
  )
  $bytes = [System.IO.File]::ReadAllBytes($path)
  return @{
    artifact = @{
      id = $Id
      kind = $Kind
      sha256 = Sha256-Bytes $bytes
    }
    file = @{
      id = $Id
      path = $path
    }
  }
}

function Hwnd-FromId([string]$WindowId) {
  if ($WindowId -notmatch '^hwnd-([0-9]{1,20})$') {
    throw "windowId must use hwnd-<decimal> format"
  }
  return [IntPtr]::new([Int64]$Matches[1])
}

function Add-User32 {
  if (-not ("ToadAid.User32" -as [type])) {
    Add-Type @"
using System;
using System.Runtime.InteropServices;
namespace ToadAid {
  public static class User32 {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
  }
}
"@
  }
}

function Display-Inventory {
  Add-Type -AssemblyName System.Windows.Forms
  $screens = [System.Windows.Forms.Screen]::AllScreens
  $items = @()
  for ($i = 0; $i -lt $screens.Length; $i++) {
    $s = $screens[$i]
    $items += @{
      id = $i
      deviceName = $s.DeviceName
      primary = [bool]$s.Primary
      bounds = @{
        left = $s.Bounds.Left
        top = $s.Bounds.Top
        right = $s.Bounds.Right
        bottom = $s.Bounds.Bottom
        width = $s.Bounds.Width
        height = $s.Bounds.Height
      }
      workingArea = @{
        left = $s.WorkingArea.Left
        top = $s.WorkingArea.Top
        right = $s.WorkingArea.Right
        bottom = $s.WorkingArea.Bottom
        width = $s.WorkingArea.Width
        height = $s.WorkingArea.Height
      }
    }
  }
  return ,$items
}

function Resolve-AuthorizedRects([object]$Parameters) {
  Add-Type -AssemblyName System.Windows.Forms
  $rects = @()

  if ($null -ne $Parameters.region) {
    $region = $Parameters.region
    $regionRect = @{
      left = [double]$region.left
      top = [double]$region.top
      right = [double]$region.right
      bottom = [double]$region.bottom
    }

    if ($Parameters.displayIds.Count -gt 0) {
      $screens = [System.Windows.Forms.Screen]::AllScreens
      $contained = $false
      foreach ($rawId in $Parameters.displayIds) {
        $id = [int]$rawId
        if ($id -lt 0 -or $id -ge $screens.Length) {
          throw "requested display id is unavailable: $id"
        }
        $b = $screens[$id].Bounds
        if (
          $regionRect.left -ge $b.Left -and
          $regionRect.top -ge $b.Top -and
          $regionRect.right -le $b.Right -and
          $regionRect.bottom -le $b.Bottom
        ) {
          $contained = $true
          break
        }
      }
      if (-not $contained) {
        throw "requested region is not contained by an authorized display"
      }
    }

    return ,@($regionRect)
  }

  $screens = [System.Windows.Forms.Screen]::AllScreens
  foreach ($rawId in $Parameters.displayIds) {
    $id = [int]$rawId
    if ($id -lt 0 -or $id -ge $screens.Length) {
      throw "requested display id is unavailable: $id"
    }
    $b = $screens[$id].Bounds
    $rects += @{
      left = [double]$b.Left
      top = [double]$b.Top
      right = [double]$b.Right
      bottom = [double]$b.Bottom
    }
  }
  return ,$rects
}

function Rect-OverlapsAny(
  [System.Windows.Rect]$Rect,
  [object[]]$Scopes
) {
  if ($Rect.Width -le 0 -or $Rect.Height -le 0) {
    return $false
  }
  $right = $Rect.Left + $Rect.Width
  $bottom = $Rect.Top + $Rect.Height

  foreach ($scope in $Scopes) {
    if (
      $Rect.Left -lt [double]$scope.right -and
      $right -gt [double]$scope.left -and
      $Rect.Top -lt [double]$scope.bottom -and
      $bottom -gt [double]$scope.top
    ) {
      return $true
    }
  }
  return $false
}

function Rect-ContainedByAny(
  [System.Windows.Rect]$Rect,
  [object[]]$Scopes
) {
  if ($Rect.Width -le 0 -or $Rect.Height -le 0) {
    return $false
  }
  $right = $Rect.Left + $Rect.Width
  $bottom = $Rect.Top + $Rect.Height

  foreach ($scope in $Scopes) {
    if (
      $Rect.Left -ge [double]$scope.left -and
      $Rect.Top -ge [double]$scope.top -and
      $right -le [double]$scope.right -and
      $bottom -le [double]$scope.bottom
    ) {
      return $true
    }
  }
  return $false
}

function Capture-Rect(
  [string]$Path,
  [int]$Left,
  [int]$Top,
  [int]$Width,
  [int]$Height
) {
  if ($Width -le 0 -or $Height -le 0) {
    throw "screenshot bounds must be positive"
  }

  Add-Type -AssemblyName System.Drawing
  $bitmap = [System.Drawing.Bitmap]::new($Width, $Height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen(
      $Left,
      $Top,
      0,
      0,
      [System.Drawing.Size]::new($Width, $Height),
      [System.Drawing.CopyPixelOperation]::SourceCopy
    )
    $bitmap.Save(
      $Path,
      [System.Drawing.Imaging.ImageFormat]::Png
    )
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

function Screenshot-Artifacts(
  [object]$Parameters,
  [string]$ArtifactRoot,
  [string]$Epoch
) {
  $artifacts = @()
  $files = @()
  $displayIds = @()

  $token = Artifact-Token $Epoch

  if ($null -ne $Parameters.region) {
    $null = Resolve-AuthorizedRects $Parameters
    $r = $Parameters.region
    $id = "screenshot-$token-region"
    $path = [System.IO.Path]::Combine($ArtifactRoot, "$id.png")
    Capture-Rect $path ([int]$r.left) ([int]$r.top) ([int]($r.right - $r.left)) ([int]($r.bottom - $r.top))
    $bytes = [System.IO.File]::ReadAllBytes($path)
    $artifacts += @{
      id = $id
      kind = "SCREENSHOT"
      sha256 = Sha256-Bytes $bytes
    }
    $files += @{
      id = $id
      path = $path
    }
    foreach ($d in $Parameters.displayIds) {
      $displayIds += [int]$d
    }
    return @{
      artifacts = $artifacts
      files = $files
      displayIds = $displayIds
    }
  }

  Add-Type -AssemblyName System.Windows.Forms
  $screens = [System.Windows.Forms.Screen]::AllScreens
  foreach ($rawId in $Parameters.displayIds) {
    $idNumber = [int]$rawId
    if ($idNumber -lt 0 -or $idNumber -ge $screens.Length) {
      throw "requested display id is unavailable: $idNumber"
    }
    $s = $screens[$idNumber]
    $id = "screenshot-$token-d$idNumber"
    $path = [System.IO.Path]::Combine($ArtifactRoot, "$id.png")
    Capture-Rect $path $s.Bounds.Left $s.Bounds.Top $s.Bounds.Width $s.Bounds.Height
    $bytes = [System.IO.File]::ReadAllBytes($path)
    $artifacts += @{
      id = $id
      kind = "SCREENSHOT"
      sha256 = Sha256-Bytes $bytes
    }
    $files += @{
      id = $id
      path = $path
    }
    $displayIds += $idNumber
  }

  return @{
    artifacts = $artifacts
    files = $files
    displayIds = $displayIds
  }
}

function Input-Security([System.Windows.Automation.AutomationElement]$Element) {
  try {
    if ([bool]$Element.Current.IsPassword) {
      return "SECRET_OR_PASSWORD"
    }
  } catch {}

  try {
    $isEdit =
      $Element.Current.ControlType.Id -eq
      [System.Windows.Automation.ControlType]::Edit.Id
    $supportsValue =
      [bool]$Element.GetCurrentPropertyValue(
        [System.Windows.Automation.AutomationElement]::IsValuePatternAvailableProperty
      )
    if ($isEdit -and $supportsValue) {
      return "ORDINARY_TEXT"
    }
  } catch {}

  return "UNKNOWN"
}

function Ui-Snapshot(
  [object]$Parameters,
  [string]$ArtifactRoot,
  [string]$Epoch
) {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes

  if ($Parameters.useDom) {
    throw "Windows UI snapshot v1 refuses useDom=true"
  }

  $token = Artifact-Token $Epoch
  $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
  $queue = [System.Collections.Generic.Queue[System.Windows.Automation.AutomationElement]]::new()
  $authorizedRects = $null
  $root = $null

  if ($null -ne $Parameters.windowId) {
    if (
      $Parameters.displayIds.Count -gt 0 -or
      $null -ne $Parameters.region
    ) {
      throw "mixed window + display/region UI scope is unsupported"
    }
    $hwnd = Hwnd-FromId ([string]$Parameters.windowId)
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
    if ($null -eq $root) {
      throw "window handle is unavailable"
    }
    $first = $walker.GetFirstChild($root)
    if ($null -ne $first) {
      $queue.Enqueue($first)
    }
  } else {
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $authorizedRects = @(Resolve-AuthorizedRects $Parameters)
    if ($authorizedRects.Count -lt 1) {
      throw "display/region UI snapshot requires authorized visual scope"
    }

    $top = $walker.GetFirstChild($root)
    while ($null -ne $top) {
      try {
        $topRect = $top.Current.BoundingRectangle
        if (Rect-OverlapsAny $topRect $authorizedRects) {
          $queue.Enqueue($top)
        }
      } catch {}
      $top = $walker.GetNextSibling($top)
    }
  }

  $max = [int]$Parameters.maxElements
  $tree = @()
  $elements = @()

  while ($queue.Count -gt 0 -and $tree.Count -lt $max) {
    $element = $queue.Dequeue()
    $recordElement = $true
    $rect = $null

    try {
      $rect = $element.Current.BoundingRectangle
      if ($null -ne $authorizedRects) {
        $recordElement = Rect-ContainedByAny $rect $authorizedRects
      }
    } catch {
      $recordElement = $false
    }

    if ($recordElement) {
      try {
        $name = [string]$element.Current.Name
        if ($name.Length -gt 256) {
          $name = $name.Substring(0, 256)
        }
        $automationId = [string]$element.Current.AutomationId
        if ($automationId.Length -gt 256) {
          $automationId = $automationId.Substring(0, 256)
        }
        $className = [string]$element.Current.ClassName
        if ($className.Length -gt 128) {
          $className = $className.Substring(0, 128)
        }
        $controlType = [string]$element.Current.ControlType.ProgrammaticName
        $processId = [int]$element.Current.ProcessId

        $record = @{
          name = $name
          automationId = $automationId
          className = $className
          controlType = $controlType
          processId = $processId
          enabled = [bool]$element.Current.IsEnabled
          offscreen = [bool]$element.Current.IsOffscreen
          keyboardFocusable = [bool]$element.Current.IsKeyboardFocusable
          bounds = @{
            left = [double]$rect.Left
            top = [double]$rect.Top
            width = [double]$rect.Width
            height = [double]$rect.Height
          }
        }

        $fingerprint = $record | ConvertTo-Json -Depth 8 -Compress
        $evidenceSha = Sha256-Text $fingerprint
        $elementId = "uia-$($evidenceSha.Substring(0, 32))"
        $record.elementId = $elementId
        $tree += $record

        if ($null -ne $Parameters.windowId) {
          $elements += @{
            elementId = $elementId
            evidenceSha256 = $evidenceSha
            inputSecurity = Input-Security $element
          }
        }
      } catch {}
    }

    try {
      $child = $walker.GetFirstChild($element)
      if ($null -ne $child) {
        $queue.Enqueue($child)
      }
      if ($null -ne $Parameters.windowId) {
        $sibling = $walker.GetNextSibling($element)
        if ($null -ne $sibling) {
          $queue.Enqueue($sibling)
        }
      }
    } catch {}
  }

  $id = "ui-tree-$token-0"
  $artifact = Write-Utf8JsonArtifact $ArtifactRoot $id @{
    windowId = $Parameters.windowId
    displayIds = @($Parameters.displayIds)
    region = $Parameters.region
    truncated = ($queue.Count -gt 0)
    elements = $tree
  } "UI_TREE"

  $artifacts = @($artifact.artifact)
  $files = @($artifact.file)

  if ([bool]$Parameters.includeScreenshot) {
    if ($null -ne $Parameters.windowId) {
      $rect = $root.Current.BoundingRectangle
      if ($rect.Width -gt 0 -and $rect.Height -gt 0) {
        $sid = "screenshot-$token-window"
        $spath = [System.IO.Path]::Combine($ArtifactRoot, "$sid.png")
        Capture-Rect $spath ([int]$rect.Left) ([int]$rect.Top) ([int]$rect.Width) ([int]$rect.Height)
        $bytes = [System.IO.File]::ReadAllBytes($spath)
        $artifacts += @{
          id = $sid
          kind = "SCREENSHOT"
          sha256 = Sha256-Bytes $bytes
        }
        $files += @{
          id = $sid
          path = $spath
        }
      }
    } else {
      $capture = Screenshot-Artifacts $Parameters $ArtifactRoot $Epoch
      $artifacts += @($capture.artifacts)
      $files += @($capture.files)
    }
  }

  return @{
    artifacts = $artifacts
    files = $files
    elements = $elements
  }
}

function Element-IsWithinWindow(
  [System.Windows.Automation.AutomationElement]$Element,
  [IntPtr]$Hwnd
) {
  $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
  $current = $Element
  $depth = 0

  while ($null -ne $current -and $depth -lt 128) {
    try {
      if (
        [int64]$current.Current.NativeWindowHandle -eq
        [int64]$Hwnd
      ) {
        return $true
      }
    } catch {}

    try {
      $current = $walker.GetParent($current)
    } catch {
      return $false
    }
    $depth += 1
  }

  return $false
}

function Wait-For(
  [object]$Parameters,
  [string]$ArtifactRoot,
  [string]$Epoch
) {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-User32

  if (
    $Parameters.condition -eq "element_exists" -or
    $Parameters.condition -eq "element_enabled"
  ) {
    throw "selectorless element wait condition is unsupported in WA-P1"
  }

  $hwnd = Hwnd-FromId ([string]$Parameters.windowId)
  $token = Artifact-Token $Epoch
  $deadline = [DateTime]::UtcNow.AddMilliseconds([int]$Parameters.timeoutMs)
  $matched = $false

  while ([DateTime]::UtcNow -lt $deadline) {
    $window = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
    if ($null -ne $window) {
      switch ([string]$Parameters.condition) {
        "active_window" {
          $matched = ([ToadAid.User32]::GetForegroundWindow() -eq $hwnd)
        }
        "text_exists" {
          $condition = [System.Windows.Automation.PropertyCondition]::new(
            [System.Windows.Automation.AutomationElement]::NameProperty,
            [string]$Parameters.text
          )
          $found = $window.FindFirst(
            [System.Windows.Automation.TreeScope]::Descendants,
            $condition
          )
          $matched = ($null -ne $found)
        }
        "focused_element" {
          $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
          if ($null -ne $focused) {
            $matched = Element-IsWithinWindow $focused $hwnd
          }
        }
        default {
          throw "unsupported wait condition"
        }
      }
    }

    if ($matched) {
      break
    }

    Start-Sleep -Milliseconds ([int]$Parameters.intervalMs)
  }

  $id = "wait-result-$token-0"
  $artifact = Write-Utf8JsonArtifact $ArtifactRoot $id @{
    windowId = $Parameters.windowId
    condition = $Parameters.condition
    matched = $matched
  } "WAIT_RESULT"

  return @{
    artifacts = @($artifact.artifact)
    files = @($artifact.file)
    matched = $matched
  }
}

$stdin = [Console]::In.ReadToEnd()
$envelope = $stdin | ConvertFrom-Json
$request = $envelope.request
$artifactRoot = [System.IO.Path]::GetFullPath([string]$envelope.artifactRoot)

[System.IO.Directory]::CreateDirectory($artifactRoot) | Out-Null

$parameters = $request.parameters
$epoch = [string]$request.observationEpoch
$artifacts = @()
$files = @()
$displayIds = @()
$windowId = $parameters.windowId
$elements = $null
$matched = $null

switch ([string]$parameters.kind) {
  "DISPLAY_INVENTORY" {
    $inventory = Display-Inventory
    $token = Artifact-Token $epoch
    $id = "display-inventory-$token-0"
    $artifact = Write-Utf8JsonArtifact $artifactRoot $id @{
      displays = $inventory
    } "DISPLAY_INVENTORY"
    $artifacts = @($artifact.artifact)
    $files = @($artifact.file)
    foreach ($display in $inventory) {
      $displayIds += [int]$display.id
    }
  }

  "SCREENSHOT" {
    $capture = Screenshot-Artifacts $parameters $artifactRoot $epoch
    $artifacts = @($capture.artifacts)
    $files = @($capture.files)
    $displayIds = @($capture.displayIds)
  }

  "UI_SNAPSHOT" {
    $snapshot = Ui-Snapshot $parameters $artifactRoot $epoch
    $artifacts = @($snapshot.artifacts)
    $files = @($snapshot.files)
    if ($null -ne $parameters.windowId) {
      $elements = @($snapshot.elements)
    }
    foreach ($d in $parameters.displayIds) {
      $displayIds += [int]$d
    }
  }

  "WAIT_FOR" {
    $wait = Wait-For $parameters $artifactRoot $epoch
    $artifacts = @($wait.artifacts)
    $files = @($wait.files)
    $matched = [bool]$wait.matched
  }

  default {
    throw "unsupported observation kind"
  }
}

$evidenceBasis = @{
  observationEpoch = $epoch
  hostId = [string]$request.hostId
  sessionId = [string]$request.sessionId
  kind = [string]$parameters.kind
  artifacts = $artifacts
  displayIds = $displayIds
  windowId = $windowId
  matched = $matched
} | ConvertTo-Json -Depth 16 -Compress

$result = @{
  observationEpoch = $epoch
  hostId = [string]$request.hostId
  sessionId = [string]$request.sessionId
  displayIds = $displayIds
  windowId = $windowId
  evidenceSha256 = Sha256-Text $evidenceBasis
  artifacts = $artifacts
  artifactFiles = $files
}

if ($null -ne $elements) {
  $result.elements = $elements
}
if ($null -ne $matched) {
  $result.matched = $matched
}

[Console]::Out.Write(
  ($result | ConvertTo-Json -Depth 20 -Compress)
)
