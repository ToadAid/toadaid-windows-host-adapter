$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$script:WorkerDeadlineUtc = $null

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
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW", SetLastError = true)]
    public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
    [DllImport("kernel32.dll")]
    public static extern void SetLastError(uint code);
    // WA-P1A.2 review: a style of 0 is ambiguous (failure, or a window with no
    // style bits). Only a non-zero read counts as a verified style.
    public static bool TryGetStyle(IntPtr hWnd, out int style) {
      SetLastError(0);
      style = GetWindowLong(hWnd, -16);
      return style != 0;
    }
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

# WA-P1A.2 F4: a region is capturable only if every point of it lies on some
# display. Exact for axis-aligned rectangles: split the region at every display
# edge and require each cell to be covered. Pure; unit-tested by dot-sourcing.
function Region-CoveredByDisplays([object]$Region, [object[]]$Displays) {
  $l = [double]$Region.left; $t = [double]$Region.top
  $r = [double]$Region.right; $b = [double]$Region.bottom
  if (-not ($r -gt $l -and $b -gt $t)) { return $false }
  $xs = [System.Collections.Generic.SortedSet[double]]::new()
  $ys = [System.Collections.Generic.SortedSet[double]]::new()
  $null = $xs.Add($l); $null = $xs.Add($r); $null = $ys.Add($t); $null = $ys.Add($b)
  foreach ($d in $Displays) {
    foreach ($x in @([double]$d.left, [double]$d.right)) { if ($x -gt $l -and $x -lt $r) { $null = $xs.Add($x) } }
    foreach ($y in @([double]$d.top, [double]$d.bottom)) { if ($y -gt $t -and $y -lt $b) { $null = $ys.Add($y) } }
  }
  $xa = @($xs); $ya = @($ys)
  for ($i = 0; $i -lt $xa.Count - 1; $i++) {
    for ($j = 0; $j -lt $ya.Count - 1; $j++) {
      $cx = ($xa[$i] + $xa[$i + 1]) / 2; $cy = ($ya[$j] + $ya[$j + 1]) / 2
      $covered = $false
      foreach ($d in $Displays) {
        if ($cx -ge [double]$d.left -and $cx -lt [double]$d.right -and $cy -ge [double]$d.top -and $cy -lt [double]$d.bottom) { $covered = $true; break }
      }
      if (-not $covered) { return $false }
    }
  }
  return $true
}

function Display-Rects {
  Add-Type -AssemblyName System.Windows.Forms
  $out = @()
  foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
    $out += @{ left = [double]$s.Bounds.Left; top = [double]$s.Bounds.Top; right = [double]$s.Bounds.Right; bottom = [double]$s.Bounds.Bottom }
  }
  return ,$out
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
    } elseif (-not (Region-CoveredByDisplays $regionRect (Display-Rects))) {
      throw "requested region is not fully on a display"
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

function Rect-IsValid(
  [System.Windows.Rect]$Rect
) {
  foreach ($value in @(
    [double]$Rect.Left,
    [double]$Rect.Top,
    [double]$Rect.Width,
    [double]$Rect.Height
  )) {
    if (
      [double]::IsNaN($value) -or
      [double]::IsInfinity($value) -or
      [Math]::Abs($value) -gt 10000000
    ) {
      return $false
    }
  }
  return (
    $Rect.Width -gt 0 -and
    $Rect.Height -gt 0
  )
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

# WA-P1A.2 F1: names are recorded only for elements positively known to be
# non-input display text. Anything input-like, password-like, or not
# positively classified has its name withheld (fail closed); UIA's own
# classification alone is not trusted (native WinForms edits surface as Pane
# with their value as Name). Pure decision over observed facts; unit-tested.
$script:NameSafeControlTypes = @(
  "ControlType.Text", "ControlType.Button", "ControlType.CheckBox", "ControlType.RadioButton",
  "ControlType.MenuItem", "ControlType.MenuBar", "ControlType.Menu", "ControlType.TabItem",
  "ControlType.Tab", "ControlType.ListItem", "ControlType.TreeItem", "ControlType.Hyperlink",
  "ControlType.Image", "ControlType.Group", "ControlType.Window", "ControlType.TitleBar",
  "ControlType.Header", "ControlType.HeaderItem", "ControlType.ToolBar", "ControlType.StatusBar",
  "ControlType.ToolTip", "ControlType.Separator", "ControlType.ScrollBar", "ControlType.Thumb",
  "ControlType.List", "ControlType.Tree"
)

function Text-PolicyFor([object]$Facts) {
  $type = [string]$Facts.controlType
  $class = [string]$Facts.className
  $editClass = $class -match '(?i)(edit|richedit|textbox|password|passwordbox)'
  $editType = @("ControlType.Edit", "ControlType.Document", "ControlType.ComboBox") -contains $type
  # A Win32 style counts only when it was read from a real handle and is non-zero.
  $styleVerified = [bool]$Facts.win32StyleKnown -and [int64]$Facts.nativeWindowHandle -ne 0 -and [int64]$Facts.win32Style -ne 0
  $esPassword = $editClass -and $styleVerified -and (([int64]$Facts.win32Style -band 0x20) -ne 0)
  # An edit-like class whose password style cannot be verified is treated as a
  # password field: the absence of ES_PASSWORD is never assumed.
  $editStyleUnverified = $editClass -and -not $styleVerified
  $sensitive = [bool]$Facts.isPassword -or $esPassword -or $editStyleUnverified -or ($class -match '(?i)password') -or [bool]$Facts.factsIncomplete
  $inputLike = $editType -or $editClass -or [bool]$Facts.valuePattern -or [bool]$Facts.textPattern
  $safeWin32Class = $class -match '^(?i:Static|Button|#32770)$' -or $class -match '^WindowsForms10\.(?i:STATIC|BUTTON|Window)\.'
  $nameSafe = (-not $sensitive) -and (-not $inputLike) -and (
    ($script:NameSafeControlTypes -contains $type) -or
    ((@("ControlType.Pane", "ControlType.Custom") -contains $type) -and $safeWin32Class)
  )
  if ($sensitive) {
    $security = "SECRET_OR_PASSWORD"
  } elseif ($type -eq "ControlType.Edit" -and [bool]$Facts.valuePattern -and $editClass -and $styleVerified -and -not $esPassword) {
    # ORDINARY_TEXT needs positive, mutually consistent evidence: a UIA Edit with
    # a value pattern, an edit Win32 class and a verified non-password style.
    # ValuePattern alone (e.g. a windowless Edit) is not enough.
    $security = "ORDINARY_TEXT"
  } else {
    $security = "UNKNOWN"
  }
  return @{ inputSecurity = $security; nameRecorded = [bool]$nameSafe }
}

# WA-P1A.2 review: free-form UIA identifiers are persisted only when they are
# short, plain identifiers; anything else (or anything from a sensitive
# element) is withheld rather than stored. Pure; unit-tested.
function Safe-Identifier([string]$Value, [bool]$Sensitive, [int]$MaxLength) {
  if ($Sensitive -or [string]::IsNullOrEmpty($Value)) { return $null }
  if ($Value.Length -gt $MaxLength) { return $null }
  if ($Value -notmatch '^[A-Za-z0-9_.:#$-]+$') { return $null }
  return $Value
}

function Element-TextFacts([System.Windows.Automation.AutomationElement]$Element) {
  $facts = @{ controlType = ""; className = ""; isPassword = $false; valuePattern = $false; textPattern = $false; nativeWindowHandle = 0; win32Style = 0; win32StyleKnown = $false; factsIncomplete = $false }
  try {
    $facts.controlType = [string]$Element.Current.ControlType.ProgrammaticName
    $facts.className = [string]$Element.Current.ClassName
    $facts.isPassword = [bool]$Element.Current.IsPassword
    $facts.nativeWindowHandle = [int64]$Element.Current.NativeWindowHandle
    $facts.valuePattern = [bool]$Element.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::IsValuePatternAvailableProperty)
    $facts.textPattern = [bool]$Element.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::IsTextPatternAvailableProperty)
  } catch {
    $facts.factsIncomplete = $true
  }
  if ($facts.nativeWindowHandle -ne 0) {
    try {
      Add-User32
      $style = 0
      $facts.win32StyleKnown = [ToadAid.User32]::TryGetStyle([IntPtr]::new($facts.nativeWindowHandle), [ref]$style)
      $facts.win32Style = [int64]$style
    } catch {
      $facts.factsIncomplete = $true
    }
  }
  return $facts
}

function Input-Security([System.Windows.Automation.AutomationElement]$Element) {
  return (Text-PolicyFor (Element-TextFacts $Element)).inputSecurity
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
  $windowScopeRects = $null
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
    # WA-P1A.2 F2: exact-window evidence must lie inside the window's own bounds.
    $windowRect = $root.Current.BoundingRectangle
    if (-not (Rect-IsValid $windowRect)) {
      throw "window geometry is unavailable"
    }
    $windowScopeRects = @(@{
      left = [double]$windowRect.Left
      top = [double]$windowRect.Top
      right = [double]($windowRect.Left + $windowRect.Width)
      bottom = [double]($windowRect.Top + $windowRect.Height)
    })
    $child = $walker.GetFirstChild($root)
    while ($null -ne $child) {
      $queue.Enqueue($child)
      $child = $walker.GetNextSibling($child)
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
        $topOffscreen = [bool]$top.Current.IsOffscreen
        if (
          (Rect-IsValid $topRect) -and
          (-not $topOffscreen) -and
          (Rect-OverlapsAny $topRect $authorizedRects)
        ) {
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
      $offscreen = [bool]$element.Current.IsOffscreen
      $recordElement =
        (Rect-IsValid $rect) -and
        (-not $offscreen)
      if (
        $recordElement -and
        $null -ne $authorizedRects
      ) {
        $recordElement =
          Rect-ContainedByAny $rect $authorizedRects
      }
      if (
        $recordElement -and
        $null -ne $windowScopeRects
      ) {
        $recordElement =
          Rect-ContainedByAny $rect $windowScopeRects
      }
    } catch {
      $recordElement = $false
    }

    if ($recordElement) {
      try {
        $policy = Text-PolicyFor (Element-TextFacts $element)
        $name = $null
        if ($policy.nameRecorded) {
          $name = [string]$element.Current.Name
          if ($name.Length -gt 256) {
            $name = $name.Substring(0, 256)
          }
        }
        $secretElement = $policy.inputSecurity -eq "SECRET_OR_PASSWORD"
        $automationId = Safe-Identifier ([string]$element.Current.AutomationId) $secretElement 128
        $className = Safe-Identifier ([string]$element.Current.ClassName) $false 128
        $controlType = [string]$element.Current.ControlType.ProgrammaticName
        $processId = [int]$element.Current.ProcessId

        $record = @{
          name = $name
          nameRedacted = (-not $policy.nameRecorded)
          automationId = $automationId
          automationIdRedacted = ($null -eq $automationId)
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
            inputSecurity = $policy.inputSecurity
          }
        }
      } catch {}
    }

    try {
      $child = $walker.GetFirstChild($element)
      while ($null -ne $child) {
        $queue.Enqueue($child)
        $child = $walker.GetNextSibling($child)
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
  # WA-P1A.2 F3: finish before the adapter's outer wall clock so an absent
  # match can be reported as matched=false; never run past the outer deadline.
  $requestedEnd = [DateTime]::UtcNow.AddMilliseconds([int]$Parameters.timeoutMs)
  $deadline = $requestedEnd
  $budgetBound = $false
  if ($null -ne $WorkerDeadlineUtc -and $WorkerDeadlineUtc -lt $requestedEnd) {
    $deadline = $WorkerDeadlineUtc
    $budgetBound = $true
  }
  if ([DateTime]::UtcNow -ge $deadline) {
    throw "wait deadline exhausted before the first check"
  }
  $matched = $false
  $checks = 0
  $firstCheck = $null
  $lastCheck = $null

  while ($true) {
    if ($null -eq $firstCheck) { $firstCheck = [DateTime]::UtcNow }
    $checks += 1
    $window = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
    if ($null -ne $window) {
      switch ([string]$Parameters.condition) {
        "active_window" {
          $matched = ([ToadAid.User32]::GetForegroundWindow() -eq $hwnd)
        }
        "text_exists" {
          # WA-P1A.2 F1: only name-safe (non-input) text can satisfy the wait,
          # so a wait cannot be used as an oracle for password/input values.
          $condition = [System.Windows.Automation.PropertyCondition]::new(
            [System.Windows.Automation.AutomationElement]::NameProperty,
            [string]$Parameters.text
          )
          $found = $window.FindAll(
            [System.Windows.Automation.TreeScope]::Descendants,
            $condition
          )
          $matched = $false
          foreach ($candidate in $found) {
            if ((Text-PolicyFor (Element-TextFacts $candidate)).nameRecorded) {
              $matched = $true
              break
            }
          }
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

    $lastCheck = [DateTime]::UtcNow
    if ($matched) {
      break
    }

    $remainingMs = ($deadline - [DateTime]::UtcNow).TotalMilliseconds
    if ($remainingMs -le 0) {
      break
    }
    Start-Sleep -Milliseconds ([int][Math]::Max(1, [Math]::Min([double]$Parameters.intervalMs, $remainingMs)))
    if ([DateTime]::UtcNow -ge $deadline) {
      break
    }
  }

  # WA-P1A.2 review: matched=false only means "not observed during the interval
  # actually checked". The evidence states why the wait ended and how long was
  # really observed, so a budget-truncated wait never reads as the full request.
  if ($matched) {
    $reason = "MATCHED"
  } elseif ($budgetBound) {
    $reason = "WORKER_BUDGET_REACHED"
  } else {
    $reason = "REQUEST_TIMEOUT_ELAPSED"
  }
  $id = "wait-result-$token-0"
  $artifact = Write-Utf8JsonArtifact $ArtifactRoot $id @{
    windowId = $Parameters.windowId
    condition = $Parameters.condition
    matched = $matched
    reason = $reason
    requestedTimeoutMs = [int]$Parameters.timeoutMs
    observedIntervalMs = [int][Math]::Round(($lastCheck - $firstCheck).TotalMilliseconds)
    checks = $checks
  } "WAIT_RESULT"

  return @{
    artifacts = @($artifact.artifact)
    files = @($artifact.file)
    matched = $matched
  }
}

function Invoke-ObservationWorker {
$stdin = [Console]::In.ReadToEnd()
$envelope = $stdin | ConvertFrom-Json
$request = $envelope.request
$artifactRoot = [System.IO.Path]::GetFullPath([string]$envelope.artifactRoot)
$script:WorkerDeadlineUtc = $null
if ($envelope.PSObject.Properties.Name -contains "workerDeadlineUtcMs" -and $null -ne $envelope.workerDeadlineUtcMs) {
  $script:WorkerDeadlineUtc = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$envelope.workerDeadlineUtcMs).UtcDateTime
}
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
}

# Dot-sourcing (". worker.ps1") loads the pure functions for unit tests only.
if ($MyInvocation.InvocationName -ne ".") {
  Invoke-ObservationWorker
}
