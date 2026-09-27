# ToadAid Windows Host Adapter — BUILD LIST

Provider implementation for the governed host contracts defined by `@toadaid/agent-capabilities`.

## Current truth

- [x] **WA-P1A — Governed Windows desktop observation adapter core**
  - consume P16 types/contracts from `@toadaid/agent-capabilities`; do not fork authority logic
  - actual Windows PowerShell/.NET worker for display inventory, scoped screenshot, UI Automation snapshot, and bounded local wait
  - Node bridge uses an explicit absolute local Windows PowerShell executable + structured argv with `shell=false`; no ambient `PATH` resolution
  - adapter registration is injected from P14/C1; implementation never self-authorizes
  - screenshots/UI-tree/wait artifacts live outside authority receipts behind bounded artifact IDs and SHA-256
  - UI element evidence classifies text targets as `ORDINARY_TEXT`, `SECRET_OR_PASSWORD`, or `UNKNOWN`
  - reusable element evidence is emitted only for explicit `windowId` scope; display/region UI snapshots are projected to the authorized visual bounds and mixed window + visual scope is refused
  - `useDom=true` refused in Windows desktop v1
  - selectorless `element_exists` / `element_enabled` wait conditions refused until the shared contract carries an exact selector
  - worker contains observation operations only; no click/type/process/file/registry/command mutation

- [ ] **WA-P1B — Native Windows observation dogfood proof — BLOCKED: native Windows host required**
  - do not substitute Linux, Wine, mocked UI Automation, or source-only proof for native Windows evidence
  - run against the exact landed adapter commit and exact pinned `@toadaid/agent-capabilities` commit
  - enumerate actual Windows displays and record bounds/work-area truth
  - capture one explicitly selected display and one bounded region
  - capture one exact-window UI Automation snapshot using an `hwnd-<decimal>` identity
  - prove reusable element evidence appears only for exact-window scope
  - exercise one bounded local `text_exists` or `active_window` wait
  - verify every emitted artifact SHA from disk and prove artifact-root containment
  - prove `useDom=true`, annotation overlays, mixed window + display/region scope, and selectorless element waits fail closed
  - record Windows version, PowerShell version, Node version, worker SHA-256, package commit, and upstream capability commit
  - produce a deterministic live-proof report before marking WA-P1B complete

- [ ] **WA-P1C — Windows proof harness hardening**
  - cut only after the first native WA-P1B run exposes the real Windows environment shape
  - convert the successful dogfood sequence into a repeatable operator proof command/report
  - classify unsupported Windows versions / PowerShell availability / UI Automation failures instead of silently falling back
  - verify multi-monitor coordinates, negative virtual-screen coordinates, DPI/scaling behavior, minimized/occluded windows, and disappearing-window failure semantics
  - keep the proof harness outside authority; it validates the provider implementation only

## Governed desktop interaction lane

- [ ] **WA-P2A — Pointer interaction adapter**
  - implement P17 `host:pointer-move`, `host:pointer-click`, and `host:scroll`
  - consume fresh P16 observation evidence; never synthesize or refresh authority inside the adapter
  - exact-window element actions must bind the current P16 element evidence
  - raw coordinates must remain inside the explicitly authorized display/region geometry
  - no silent monitor/window retargeting after navigation, focus change, window replacement, or stale observation
  - P17/X1 remains the replay authority; Windows implementation performs one bounded dispatch only

- [ ] **WA-P2B — Text input + shortcut adapter**
  - implement P17 `host:text-input` and `host:shortcut` separately from pointer actions
  - refuse `SECRET_OR_PASSWORD` and `UNKNOWN` text targets in v1 unless a future shared contract explicitly governs them
  - ordinary text is runtime payload, not durable authority state
  - shortcuts are bounded explicit key chords; no free-form macro language or ambient shell escape
  - uncertain post-entry outcomes return evidence for P17/X1 reconciliation; never blind replay

- [ ] **WA-P2C — Native Windows interaction dogfood proof**
  - blocked until WA-P1B is green and WA-P2A/P2B source review is complete
  - use a disposable local test window/application, not the operator's production desktop state
  - prove move/click/scroll/text/shortcut against exact fresh observation evidence
  - prove stale evidence, wrong window, out-of-region coordinates, password targets, and changed focus fail closed
  - record before/after observation evidence for every interaction

## Governed host-service lane

- [ ] **WA-P3A — Read-only Windows host services**
  - implement P18 `host:clipboard-read`, `host:process-read`, `host:file-read`, and `host:registry-read`
  - preserve P18 read/write separation even when Windows APIs expose omnibus mechanisms
  - file reads enforce canonical root/path + realpath containment and refuse traversal, symlink/reparse-point escape, UNC/device widening, and unbounded content
  - registry reads remain inside exact hive/root/key scope
  - process reads emit bounded identity evidence suitable for a later fresh `process-stop` decision
  - raw clipboard/file/registry/process payloads stay outside authority receipts

- [ ] **WA-P3B — Bounded Windows host mutations**
  - implement P18 `host:clipboard-write`, `host:file-write`, `host:registry-write`, and `host:notification`
  - P18 v1 mutations remain `NON_REPLAYABLE` and use X1 reconciliation on uncertain post-entry outcomes
  - content/value references must resolve only through the governed runtime handoff; adapter does not gain generic content-store authority
  - file/registry writes remain exact-scope and refuse path/key widening
  - no raw sensitive payloads in receipts/logs/error messages

- [ ] **WA-P3C — App launch, process stop, and structured command execution**
  - implement P18 `host:app-launch`, `host:process-stop`, and `host:command-exec`
  - app/command executable must be an explicit local absolute path; no ambient `PATH`, shell string, UNC/device executable, or implicit elevation
  - cwd is explicit and bounded; environment is explicit/non-inherited unless a future shared contract says otherwise
  - process-stop requires fresh process identity evidence and exact PID binding immediately before dispatch
  - stdout/stderr are bounded runtime results/artifacts, not authority state
  - uncertain launch/stop/exec outcome enters X1 reconciliation; never automatic retry

- [ ] **WA-P3D — Native Windows host-service dogfood proof**
  - run read-only proofs first, then bounded mutations in disposable test directories/keys/processes
  - prove filesystem reparse-point escape refusal, registry root containment, stale process-stop evidence refusal, explicit executable/cwd/env behavior, and bounded output handling
  - record exact provider/upstream commits and artifact/result hashes

## Module lifecycle, installation, and desktop integration

- [ ] **WA-P4 — P14 capability-module manifest + provider lifecycle**
  - package Windows observation/interaction/host-service implementations as provider modules without moving authority into this repo
  - preserve `INSTALLED ≠ ENABLED ≠ AUTHORIZED`
  - define adapter IDs, contract IDs, implementation fingerprints, supported Windows versions, dependencies, and required OS privileges
  - provider discovery/registration must not silently enable capabilities
  - choose the minimum viable process model; do not introduce a privileged Windows service unless a concrete capability requires it

- [ ] **WA-P5 — Windows install/bootstrap path**
  - decide supported installation path for native Windows users and ToadAid desktop packaging
  - install only declared runtime dependencies and verify their hashes/versions
  - avoid global `PATH` mutation and ambient PowerShell policy changes
  - preserve uninstall/upgrade boundaries and user-owned configuration/artifacts
  - keep installation separate from capability authorization

- [ ] **WA-P6 — ToadAid desktop/provider integration**
  - connect `toadaid-app` to this provider through the shared capability/module contracts rather than provider-specific shortcuts
  - surface provider installed/enabled/healthy state separately from per-action authorization
  - expose bounded observation artifacts to the desktop without leaking local filesystem authority
  - define degraded/offline/provider-version-mismatch UX and receipts

- [ ] **WA-P7 — Security + release readiness**
  - native Windows threat-model review for UI Automation, screenshots, PowerShell/.NET loading, reparse points, registry, process identity, command execution, and privilege boundaries
  - verify worker/package integrity and define signing strategy before public distribution
  - run clean-machine install/uninstall/upgrade proofs on supported Windows versions
  - document unsupported behavior and fail-closed classifications
  - public release only after WA-P1B/WA-P2C/WA-P3D live proofs and security review are green

## Standing law

Windows implementation is mechanism, never authority. P15/P3/C1/H1/Q1/X1 remain in `toadaid-agent-capabilities`.

Native Windows proof is evidence, not ceremony. Linux development may prove source contracts and deterministic logic, but it cannot substitute for Windows OS evidence.
