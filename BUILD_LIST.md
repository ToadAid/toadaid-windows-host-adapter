# ToadAid Windows Host Adapter — BUILD LIST

Provider implementation for the governed host contracts defined by `@toadaid/agent-capabilities`.

## Windows adapter lane

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

- [ ] **WA-P1B — Live Windows observation dogfood proof**
  - enumerate actual Windows displays
  - capture one explicitly selected display/region
  - capture one exact-window UI Automation snapshot
  - exercise local `text_exists` or `active_window` wait
  - verify every artifact SHA and artifact-root containment
  - record Windows version, PowerShell version, worker SHA, package commit, and upstream capability commit

## Future lanes

- [ ] **WA-P2 — Governed Windows desktop interaction adapter**
  - implement P17 click/move/scroll/text/shortcut only after WA-P1B live proof
  - consume fresh P16 evidence; never synthesize authority

- [ ] **WA-P3 — Governed Windows host-service adapter**
  - implement P18 app/clipboard/process/file/notification/registry/command services
  - preserve P18 read/write/destructive separation and X1 mutation law

## Standing law

Windows implementation is mechanism, never authority. P15/P3/C1/H1/Q1/X1 remain in `toadaid-agent-capabilities`.
