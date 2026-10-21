# ToadAid Windows Host Adapter

Windows-specific provider implementation for the governed desktop and host contracts defined by `@toadaid/agent-capabilities`.

This repository does **not** own authority. It implements bounded Windows mechanisms behind the shared ToadAid governance spine:

```text
P15 host session
  + P3 current authority
  + C1 exact contract
  + H1 invocation identity
  + Q1 budget
  + X1 when mutation applies
        ↓
Windows adapter
        ↓
Windows OS APIs
```

## WA-P1 scope

WA-P1 implements **observation only**:

- display inventory through `System.Windows.Forms.Screen`
- bounded screenshot capture through `System.Drawing.Graphics.CopyFromScreen`
- display/region-scoped or exact-window UI snapshot through Windows UI Automation
- local bounded wait-for through one worker process
- explicit absolute local Windows PowerShell launch; no ambient `PATH` executable lookup

No click, text entry, process mutation, filesystem mutation, registry mutation, command execution, or shell-string authority exists in WA-P1.

### Contract evidence (WA-CAP-SYNC-P1)

Every result reports a **display topology epoch**. This is a SHA-256 over display order, bounds, the primary flag, hashed device names and the worker's DPI awareness. A request that selects displays by number must be bound to that epoch, and the worker refuses a stale binding before capturing anything (`DISPLAY_TOPOLOGY_STALE`).

The worker asks for per-monitor DPI awareness for its own process only. An exact-window UI snapshot reports the window's bounds as `DESKTOP_PHYSICAL` geometry only when that awareness was granted; otherwise it refuses with `GEOMETRY_COORDINATE_SPACE_UNPROVEN`.

Wait-for results report `completionReason` (`MATCHED` / `TIMED_OUT`). The precise reason, such as a budget-truncated wait, stays in the `WAIT_RESULT` artifact.

The adapter has no cancellation channel and reports `cancellationStatus: NOT_REQUESTED`. Scaled and multi-display DPI behaviour is not yet natively proven (U04).

### Window identity

An exact Windows window is represented as:

```text
hwnd-<decimal native window handle>
```

Reusable UI element evidence is emitted only when the request carries an explicit `windowId`. Display/region snapshots project only UI elements fully contained in the authorized visual scope, and mixed `windowId` + display/region snapshot scope is refused in WA-P1 v1.

### Unsupported in WA-P1

- `useDom=true`
- annotation overlays
- selectorless `element_exists`
- selectorless `element_enabled`

Those requests fail closed rather than guessing semantics.

## Runtime artifacts

The worker writes screenshots and JSON evidence under the configured artifact root. P16 receives bounded artifact IDs + SHA-256 only. The extended Windows adapter can resolve an artifact ID back to its verified local path for the consuming host runtime; the path never enters the P16 authority receipt.

## Development

The local cut uses the exact adjacent `~/toadaid-agent-capabilities` checkout for proof while `package.json` pins the same canonical GitHub commit.

## WA-P1A.1 provider membrane

The next Linux-verifiable layer introduces a bounded provider/worker protocol, generation-bound opaque Windows evidence references, provider-owned artifact lifecycle rules, and a mutation-free C# native-worker skeleton.

This does not replace WA-P1B. Native Windows UI Automation, DPI, session, RDP, UIPI, screenshot, and object-lifetime behavior remain unproven until a real Windows host is available.

The provider membrane answers whether the exact Windows object previously observed still exists in the same generation and OS identity boundary. The shared capability spine remains the only authority deciding whether an action may occur.
