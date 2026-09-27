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

- [ ] **WA-P1A.1 — Provider evidence identity + worker protocol hardening — NEXT LINUX CUT**
  - Linux-verifiable foundation; completing this lane does **not** count as native Windows proof
  - define one versioned bounded provider/worker request-response-health protocol with strict schema/unknown-field refusal and byte limits
  - introduce a provider/worker generation identity; crash, restart, upgrade, logoff, session change, or protocol reset invalidates live window/element/process evidence
  - keep public window/element references opaque; provider-side window evidence binds session/desktop identity, HWND locator, PID, process creation-time identity, and generation
  - define provider-side element evidence storage keyed by observation epoch + exact window reference + element ID + element evidence SHA-256; retain UIA runtime identity/fingerprint, ancestry, bounds/clickable-point evidence, process identity, and observation timestamp where available
  - define TTL/invalidation semantics; a reference is evidence only and never grants authority
  - define P17 pre-dispatch identity requirements before any Windows interaction implementation exists
  - define cancellation, timeout, crash, oversized-output, malformed-response, protocol-mismatch, and uncertain-mutation semantics; no mutation retry after transport loss
  - move artifacts to unpredictable per-operation directories with create-new writes, duplicate-ID refusal, bounded retention, crash cleanup, root containment, and log redaction
  - add fake-worker tests for stale evidence, generation restart, protocol mismatch, cancellation, malformed/oversized output, artifact escape, and mutation transport uncertainty
  - add a C#/.NET native-worker skeleton that implements handshake, health, protocol framing, and non-Windows refusal only; no P17/P18 mutation yet
  - fix source-detectable P16 Windows observation defects while here, including full sibling-subtree traversal for display/region UIA snapshots and invalid/offscreen rectangle filtering

- [ ] **WA-P1B — Native Windows observation dogfood proof — BLOCKED: native Windows host required**
  - may run as soon as a native host exists; WA-P1A.1 source work does not replace or block this proof
  - do not substitute Linux, Wine, mocked UI Automation, or source-only proof for native Windows evidence
  - run against the exact landed adapter commit and exact pinned `@toadaid/agent-capabilities` commit
  - enumerate actual Windows displays and record bounds/work-area truth
  - capture one explicitly selected display and one bounded region
  - capture one exact-window UI Automation snapshot using the current HWND locator and provider window identity
  - prove display/region UI traversal covers sibling subtrees rather than only first-child chains
  - prove reusable element evidence appears only for exact-window scope
  - exercise one bounded local `text_exists` or `active_window` wait
  - verify every emitted artifact SHA from disk and prove artifact-root containment
  - prove `useDom=true`, annotation overlays, mixed window + display/region scope, and selectorless element waits fail closed
  - distinguish exact-window UI semantic evidence from an on-screen screenshot crop; `CopyFromScreen` does not prove hidden/occluded window pixels
  - record Windows version/build, Windows session ID, user/logon identity hash, desktop/window-station identity, integrity level, architecture, DPI-awareness mode, PowerShell version, Node version, worker SHA-256, package commit, and upstream capability commit
  - produce a deterministic live-proof report schema and deterministic pass/fail classifications before marking WA-P1B complete

- [ ] **WA-P1C — Native Windows observation environment matrix + proof harness**
  - cut only after the first native WA-P1B run exposes the real Windows environment shape
  - convert the successful dogfood sequence into a repeatable operator proof command and versioned report schema
  - classify unsupported Windows versions / UI Automation failures instead of silently falling back
  - test console vs RDP sessions, active/disconnected/locked state, multi-user session separation, and logoff/reconnect invalidation
  - test same/lower-integrity targets first; refuse secure desktop, unsupported elevation, and UIAccess in v1
  - test multi-monitor + negative virtual-screen coordinates, mixed DPI, display topology changes, minimized/occluded/cloaked windows, and disappearing-window failure semantics
  - test x64 worker behavior against native x64 and WOW64 target applications where supported
  - classify accessibility-poor/custom-rendered applications without inventing UIA evidence
  - keep the proof harness outside authority; it validates the provider implementation only

- [ ] **WA-P1D — Native C# observation parity + PowerShell retirement path**
  - begin after WA-P1B gives real Windows evidence; PowerShell remains acceptable for WA-P1 observation/bootstrap but is not the long-term mutation engine
  - use a per-user, per-interactive-session C#/.NET worker with explicit generation identity and narrow versioned RPC
  - declare Per-Monitor V2 DPI awareness before creating UI-related state
  - establish observation parity for display inventory, screenshot, UIA snapshot, wait-for, artifact hashing, and evidence identity
  - repeat WA-P1B against the native worker before making it canonical
  - retain PowerShell only as temporary observation/bootstrap fallback if still materially useful

## Governed desktop interaction lane

- [ ] **WA-P2A — Pointer interaction adapter**
  - contract/protocol/fake-worker work may proceed on Linux after WA-P1A.1; native Windows dispatch/proven claims wait for WA-P1B and the native-worker path
  - implement P17 `host:pointer-move`, `host:pointer-click`, and `host:scroll`
  - consume fresh P16 observation evidence; never synthesize or refresh authority inside the adapter
  - resolve target through provider-owned generation-bound window/element evidence; `hwnd-<decimal>` alone is a locator, not sufficient identity
  - immediately before dispatch revalidate generation, session/desktop, HWND ownership, PID + process creation time, foreground/top-level window, current bounds, clickable point, and hit-test result where supported
  - exact-window element actions must bind the current P16 element evidence
  - raw coordinates must remain inside explicitly authorized display/region geometry
  - use UIA for element resolution/validation and Windows input APIs for pointer semantics; do not silently replace pointer-click with UIA `InvokePattern`
  - no silent monitor/window retargeting after navigation, focus change, window replacement, popup/dialog appearance, or stale observation
  - changed identity, focus theft, occlusion ambiguity, or partial dispatch returns refusal/reconciliation evidence; never retargets
  - P17/X1 remains replay authority; Windows implementation performs one bounded dispatch only

- [ ] **WA-P2B — Text input + shortcut adapter**
  - implement P17 `host:text-input` and `host:shortcut` separately from pointer actions
  - refuse `SECRET_OR_PASSWORD` and `UNKNOWN` text targets in v1 unless a future shared contract explicitly governs them
  - ordinary text is runtime payload, not durable authority state
  - require intended exact window/element focus immediately before text or shortcut dispatch
  - define keyboard-layout and IME policy; v1 refuses active composition or unsupported layout-dependent semantics
  - shortcuts are bounded allowlisted key chords; refuse secure-attention, workstation, task-switching, shell-global, and open-ended macro sequences
  - release synthesized modifiers on every success/failure path
  - uncertain post-entry outcomes return evidence for P17/X1 reconciliation; never blind replay

- [ ] **WA-P2C — Native Windows interaction dogfood proof**
  - blocked until WA-P1B is green and WA-P2A/P2B source review is complete
  - use a disposable local test window/application, not the operator's production desktop state
  - prove move/click/scroll/text/shortcut against exact fresh observation evidence
  - prove stale generation/evidence, wrong window, out-of-region coordinates, changed process identity, password targets, popup retargeting, focus theft, and changed focus fail closed
  - record before/after observation evidence for every interaction
  - test UIPI/integrity failures honestly; no automatic elevation or UIAccess workaround

## Governed host-service lane

- [ ] **WA-P3A — Read-only Windows host services**
  - implement P18 `host:clipboard-read`, `host:process-read`, `host:file-read`, and `host:registry-read`
  - preserve P18 read/write separation even when Windows APIs expose omnibus mechanisms
  - clipboard reads bind the current interactive session/worker and treat clipboard content as sensitive runtime payload
  - file reads enforce canonical root/path plus handle/final-path containment and refuse traversal, symlink/reparse-point escape, UNC/device widening, and unbounded content
  - registry reads remain inside exact hive/root/key scope and require explicit 32-bit or 64-bit registry view rather than worker-architecture default
  - process reads emit bounded identity evidence binding PID, creation time, session, owner/integrity, executable path, and file identity where available
  - raw clipboard/file/registry/process payloads stay outside authority receipts/logs

- [ ] **WA-P3B — Bounded Windows host mutations**
  - implement P18 `host:clipboard-write`, `host:file-write`, `host:registry-write`; defer `host:notification` if the same outcome is better owned by `toadaid-app` UX
  - P18 v1 mutations remain `NON_REPLAYABLE` and use X1 reconciliation on uncertain post-entry outcomes
  - content/value references resolve only through the governed runtime handoff; adapter does not gain generic content-store authority
  - file writes use handle-based parent/target verification, refuse reparse points, use create-new or atomic replacement, and re-check final containment at commit
  - registry writes use exact hive/key/value/type plus explicit 32-bit/64-bit view
  - no raw sensitive payloads in receipts/logs/error messages

- [ ] **WA-P3C — App launch, process stop, and structured command execution — BLOCKED ON UPSTREAM COMMAND-AUTHORITY HARDENING**
  - do not implement unrestricted Windows command dispatch merely because P18 currently accepts an absolute executable + argv
  - before `host:command-exec`, upstream authority must constrain executable identity (exact file identity/hash or trusted allowlisted publisher), capability-specific argv schema, child-process policy, and any applicable network/environment policy
  - app-launch and command-exec may share a process library but remain separate operations/policies/results
  - no ambient `PATH`, shell string, UNC/device executable, implicit elevation, `runas`, shell association, cmd/PowerShell wrapping, or inherited environment
  - cwd is explicit and bounded; environment is explicit/non-inherited unless a future shared contract says otherwise
  - command-exec starts under bounded process-tree containment before meaningful execution where supported, with process-count/wall-time/stdout/stderr/stdin limits and no child breakaway
  - timeout means terminate the bounded process tree and confirm quiescence; surviving/uncertain state is `RECONCILIATION_REQUIRED`
  - process-stop reopens the target and compares PID + creation time + session + image identity immediately before terminating through the validated handle
  - uncertain launch/stop/exec outcome enters X1 reconciliation; never automatic retry

- [ ] **WA-P3D — Native Windows host-service dogfood proof**
  - run read-only proofs first, then bounded mutations in disposable test directories/keys/processes
  - prove filesystem reparse-point escape refusal, registry view/root containment, stale/PID-reuse process-stop refusal, explicit executable/cwd/env behavior, process-tree containment, timeout kill confirmation, and bounded output handling
  - record exact provider/upstream commits and artifact/result hashes

## Module lifecycle, worker lifecycle, installation, and desktop integration

- [ ] **WA-P4A — P14 capability-module manifest + provider discovery**
  - source-level manifest/discovery/health contract work may proceed on Linux; it does not enable any Windows capability
  - package provider declarations without moving authority into this repo and preserve `INSTALLED ≠ ENABLED ≠ AUTHORIZED`
  - discovery reads installer/app-controlled signed-or-hashed manifests; do not execute arbitrary discovered code
  - advertise `IMPLEMENTED` and `CURRENTLY_AVAILABLE` separately from installed/enabled/authorized state
  - declarations include module/version, contract versions, adapter IDs, implementation fingerprints, binary hashes/signing identity, supported architectures/Windows versions, dependencies, and minimum privileges
  - provider discovery/registration must not silently enable capabilities

- [ ] **WA-P4B — Per-session worker lifecycle + health**
  - lazy-start one unelevated worker per interactive logon session; no desktop automation in Windows Session 0
  - worker binds one user/logon identity, Windows session, window station, desktop, integrity level, DPI-awareness mode, architecture, and generation
  - use one narrow local transport; preferred target is a named pipe with explicit logon-SID DACL, per-launch nonce, bounded framing, request IDs, protocol negotiation, and one terminal response
  - health reports worker generation, Windows build/architecture, session/desktop identity, integrity/DPI modes, feature probes, degraded reasons, and supported contract versions
  - health never advertises authority/policy allowance/action authorization
  - crash/restart invalidates live evidence and never retries an uncertain mutation
  - avoid Windows service / Session-0 desktop automation unless a concrete future capability requires a separately reviewed broker

- [ ] **WA-P5 — Windows install/bootstrap path**
  - prefer a signed MSI as the initial canonical installer; use winget as distribution metadata once release flow exists; keep portable zip development-only
  - Tauri/toadaid-app may bundle provider binaries, but installation still creates an installed/disabled module state rather than silently enabling capabilities
  - sign installer and executable/sidecar binaries with one stable publisher identity and verify signatures/hashes during upgrade
  - install only declared runtime dependencies and verify hashes/versions
  - avoid global `PATH` mutation, global PowerShell execution-policy changes, or automatic elevation
  - preserve clean upgrade/uninstall/rollback/downgrade-refusal boundaries and user-owned configuration/artifacts
  - test Defender/SmartScreen/quarantine/partial-upgrade behavior before public release
  - PowerShell bootstrap, if retained, only downloads/verifies/launches the installer

- [ ] **WA-P6 — ToadAid desktop/provider integration**
  - connect `toadaid-app` to this provider through shared capability/module contracts rather than provider-specific shortcuts
  - surface provider installed/enabled/healthy/currently-available state separately from per-action authorization
  - expose bounded observation artifacts to the desktop without leaking local filesystem authority
  - define degraded/offline/provider-version-mismatch UX and receipts
  - prefer the same narrow provider transport used by the native worker; do not add MCP + loopback HTTP + custom RPC in parallel

- [ ] **WA-P7 — Security + release readiness**
  - native Windows threat-model review for UI Automation, screenshots, input synthesis, named-pipe impersonation/cross-session access, worker replacement/downgrade, reparse races, registry views, stale handle/PID reuse, command execution, process-tree escape, DLL/path hijacking, and privilege boundaries
  - define artifact quotas, retention, secure cleanup, crash recovery, and operator-visible purge
  - verify no clipboard/text/file/registry/stdout/stderr/environment/command payload leaks through logs, paths, errors, crash dumps, or health reports
  - verify worker/package integrity and signing strategy before public distribution
  - run clean-machine install/uninstall/upgrade proofs on supported Windows versions
  - document unsupported behavior and fail-closed classifications
  - public release only after WA-P1B/WA-P1D/WA-P2C/WA-P3D live proofs and security review are green

## Deferred until evidence justifies them

- OCR as a separate derived-observation capability only; OCR output is not reusable P17 target evidence by default
- UIAccess / elevated UI automation
- Windows service / cross-session automation broker
- full virtual-desktop automation; v1 may refuse non-current-desktop windows
- broad claims of compatibility with accessibility-poor/custom-rendered apps; publish explicit degraded/unsupported classifications instead
- PowerShell 7 support; do not maintain two PowerShell runtimes unless native-Windows evidence creates a concrete need

## Standing law

Windows implementation is mechanism, never authority. P15/P3/C1/H1/Q1/X1 remain in `toadaid-agent-capabilities`.

Native Windows proof is evidence, not ceremony. Linux development may prove source contracts, provider protocol behavior, deterministic logic, packaging structure, and fake-worker failure semantics, but it cannot substitute for Windows OS evidence.

Provider evidence is not authority. The shared spine answers **may this governed action occur?** The Windows provider answers **does the exact Windows object previously observed still exist, in the same session and generation, with the same identity, right now?** Only then may one bounded OS operation be attempted.