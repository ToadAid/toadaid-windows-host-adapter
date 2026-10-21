# WA-P1B — Native Windows observation proof (first dogfood run)

> **Evidence, not authority.** Provider evidence grants nothing. This run proves or disproves observation behaviour of the landed adapter on one real Windows host. It does **not** make interaction (P17) or host services (P18) ready. **WA-P1B is NOT complete:** four cases FAIL (see §4).

## 1. What was run

| Item | Value |
|---|---|
| Adapter under test | `main` @ `2743255caf39840fd19654a2a1b6fbc50058dbbf`. The harness branch changes no file under `src/`, `worker/`, `native/` or `package.json` |
| Capability pin | `@toadaid/agent-capabilities` `bd55a3d8fd45aeabe717e794263e04b4032fa242`, pinned and installed from the same commit. `dist/src/desktopObservation.js` SHA-256 `310e30a2…cda` |
| Worker | `worker/windows-observation.ps1`. Git blob (LF) SHA-256 `547e00b3…cc9f`. On-disk bytes as executed: CRLF via `core.autocrlf=true`, SHA-256 `7c2b5e41…72a6` |
| Host | Windows 10 Pro 22H2, build 19045.6466, x64 |
| Session and desktop | Interactive console session 3 (not remote), `WinSta0\Default` |
| Process context | Medium integrity (from the standalone probe; see §5) |
| DPI | 96 (100 %), one 1600×900 display |
| Runtimes | Windows PowerShell 5.1.19041.6456, Node v25.9.0 |
| Operator | Present, and consented to each observation step before the run. Identity is recorded only as a SHA-256 of the user SID |
| Report | `docs/proofs/wa-p1b-native-proof-2026-10-16.json`, schema `toadaid.windows-observation-native-proof.v1-proposed`, file SHA-256 `dd2a3b5b…a6ee` |

### Command

```
npm run build
node scripts/windows-observation-native-proof.mjs --consent OPERATOR_PRESENT_AND_CONSENTS --out <report.json>
```

The harness uses the **real** adapter and the **real** PowerShell worker. Requests come from the upstream `normalizeDesktopObservationRequest`. Refusal cases override single normalized fields so that the adapter-level guard itself is exercised.

### Scope controls

- The harness refuses to run off Windows, and refuses to run without the consent token.
- It starts one disposable synthetic fixture process (`scripts/wa-p1b/fixture-window.ps1`). That process shows:
  - a green cover over the primary display;
  - a grey test window with two sibling panels, an ordinary text box and a password box;
  - a label placed beneath a magenta occluder;
  - a child placed far outside the window;
  - a minimized window.
- The display screenshot therefore shows only synthetic pixels.
- Artifacts are written only under a fresh `%TEMP%\toadaid-wa-p1b-*` directory and deleted at the end. None was left behind.
- The report carries no paths, account names or screenshot bytes. Foreign UI elements are **counted**, never named. A redaction check refuses to emit a report containing a path or an operator string.
- Observation only. There is no click, keyboard, clipboard, file or registry mutation, elevation, UIAccess, persistence or service. The fixture closes itself through a close-file, with a bounded lifetime as fallback.

## 2. Results — `17 PASS · 4 FAIL · 2 BLOCKED · 2 UNSUPPORTED`

Two consecutive runs with the identical harness produced **identical classification vectors**. Some facts that depend on live desktop state differ between runs and are expected to. These are the foreign-element counts beneath the fixture, the WinForms runtime AutomationIds, and the artifact hashes.

| Case | Result | Native evidence |
|---|---|---|
| C01 display inventory | PASS | 1 display, bounds 1600×900, work area 1600×860. No negative coordinates. Device name reported as SHA-256 only |
| C02 one display screenshot | PASS | PNG 1600×900 equals the display bounds. Disk SHA matches; contained under the artifact root |
| C03 one bounded region | PASS | PNG 640×400 equals the region. Disk SHA matches; contained |
| C04 exact-window UI snapshot | PASS | 8 elements, all owned by the fixture PID. Both sibling panels traversed. Reusable element evidence for all 8. An independent probe bound HWND → PID → session → process start to the fixture. **The adapter result itself carries only the `hwnd-<n>` locator** |
| C04B password handling | **FAIL** | See finding F1 |
| C04C exact-window geometry | **FAIL** | See finding F2 |
| C05 pixels vs UIA | PASS | The region screenshot pixel at the hidden label is the magenta occluder, while UIA still reports the hidden label. `CopyFromScreen` is on-screen pixels; UIA is semantics |
| C06 region UI snapshot | PASS | No reusable element evidence. Both fixture sibling subtrees present. All elements inside the region. Foreign elements present: see F5 |
| C07 display UI snapshot | PASS | No reusable evidence. The minimized window and the far-outside child are filtered. Output truncated at 256 elements |
| C08 `text_exists` wait | PASS | `matched=true` within the bound |
| C09 absent-text wait | **FAIL** | See finding F3 |
| C10 wall-clock bound | PASS | A worker exceeding `maxWallClockMs` is killed and the call rejects in well under 15 s |
| R01 `useDom=true` | PASS | Refused before the worker |
| R02 annotation overlay | PASS | Refused before the worker |
| R03 mixed window + display scope | PASS | Refused before the worker |
| R04 selectorless element wait | PASS | Refused before the worker |
| R05 region outside all displays | **FAIL** | See finding F4 |
| R05B display + region together | PASS | Refused by the upstream contract normalizer |
| R06 unknown display id | PASS | Refused by the worker |
| R07 stale (closed) window UI snapshot | PASS | Refused |
| R08 stale window wait | PASS | Refused; never matched |
| U01 other session, secure desktop, RDP | UNSUPPORTED | Only the console session and Default desktop exist here (WA-P1C) |
| U02 oversized or malformed real-worker output | BLOCKED | The real worker cannot be forced without modifying it. The adapter bounds exist in source but have **no** fake-worker tests (§3) |
| U03 native C# skeleton handshake/health | BLOCKED | No .NET SDK on this host; installing one needs an explicit human OK. The skeleton is not observation parity in any case |
| U04 mixed DPI, negative virtual coordinates | UNSUPPORTED | Single display at 100 % |

## 3. WA-P1A.1 reconciliation (code on `main` vs the checklist)

Statuses:
- **PROVEN** — tested in source;
- **PROVEN-NATIVE** — proven by this run;
- **PARTIAL** — exists but is not complete or not on the live path;
- **MISSING**;
- **BLOCKED** — needs native or tooling work.

| WA-P1A.1 item | Status | Evidence |
|---|---|---|
| Versioned bounded protocol, strict schema, unknown-field refusal, byte limits | **PARTIAL** | Version, exact keys, 256 KiB frames and single-line framing are in `src/providerProtocol.ts`, tested at `test/providerProtocol.test.ts:33`. Three gaps remain on `main`: duplicate keys are accepted last-wins, invalid UTF-8 is replaced, and `__proto__` becomes the prototype. All three are fixed in the separate WA-P1A.1 strictness draft PR. **The live PowerShell worker does not speak this protocol**: the adapter sends `{request, artifactRoot}` on stdin and parses free-form stdout JSON |
| Provider/worker generation identity; restart invalidates evidence | **PARTIAL** | `ProviderEvidenceStore.restart()`, tested at `test/providerEvidenceStore.test.ts:119`. No generation exists in the adapter or worker live path |
| Opaque refs; window evidence binds session, desktop, HWND, PID, creation time, generation | **PARTIAL** | The store and opaque refs are tested at `test/providerEvidenceStore.test.ts:32`. The adapter result exposes only `hwnd-<n>`. C04 shows natively that the binding tuple is obtainable, but nothing wires it |
| Element evidence keyed by epoch + window + element + SHA, with runtime ID, ancestry, bounds and clickable point | **PARTIAL** | The store fields exist (`issueElement`). The worker emits no runtime ID, ancestry or clickable point |
| TTL and invalidation; a reference is not authority | **PROVEN** | Store TTL bounds and expiry are tested at `test/providerEvidenceStore.test.ts` |
| P17 pre-dispatch identity requirements defined | **PROVEN** (definition) | `assertPreDispatchWindowIdentity`, tested at `test/providerEvidenceStore.test.ts:69`. Window-level only; there is no element-level revalidation yet |
| Cancellation, timeout, crash, oversize, malformed, protocol-mismatch and uncertain-mutation semantics | **PARTIAL** | Timeout: the adapter kills the worker (**PROVEN-NATIVE**, C10). Protocol mismatch and transport disposition are tested. Oversize (2 MiB stdout) and malformed JSON are handled in source but **untested**. Cancellation (AbortSignal) is **MISSING**. Crash → generation is **MISSING** |
| Artifacts: per-operation unpredictable directories, create-new, duplicate refusal, bounded retention, crash cleanup, containment, redaction | **PARTIAL** | `ProviderArtifactStore` covers per-op `mkdtemp`, `wx`, containment and byte bounds, tested at `test/providerArtifacts.test.ts`. Bounded retention and crash cleanup are **MISSING**. **The worker does not use it**: it writes epoch-derived names directly into the root with overwrite semantics. The adapter's SHA and containment check is **PROVEN-NATIVE** (C01–C08) |
| Fake-worker tests: stale evidence, generation restart, protocol mismatch, cancellation, malformed/oversized output, artifact escape, mutation transport uncertainty | **PARTIAL** | Stale evidence, restart, protocol mismatch and transport uncertainty are tested. Cancellation, malformed/oversized output, artifact escape, SHA mismatch and identity mismatch have **no** adapter tests |
| C# native skeleton: handshake, health, framing, non-Windows refusal | **BLOCKED** | The source is present, but the only test is source-text matching (`test/nativeWorkerSkeletonSource.test.ts`). No .NET SDK on the host |
| Fix P16 defects: full sibling-subtree traversal | **PROVEN-NATIVE** | C04, C06, C07 |
| Fix P16 defects: invalid/offscreen rectangle filtering | **PARTIAL** | Display and region scope are **PROVEN-NATIVE** (C07). Exact-window scope does **not** filter (C04C, F2) |

## 4. Native findings (not fixed in this cut)

| # | Finding | Evidence | Proposed fix |
|---|---|---|---|
| F1 | **A password field's value can enter the UI-tree artifact.** WinForms child controls reached through the raw-view walker surface as `ControlType.Pane`; their UIA `Name` is the window text. The password box reported its value as `name`, `IsPassword` was false and it was classified `UNKNOWN`. P17 text input would still be refused, because v1 refuses `UNKNOWN`. But observation can **write secrets into artifacts** for poorly exposed apps | C04B, plus `elementTable` in the report (synthetic value) | Never record `Name` for edit-like or unknown-input elements, or record only a hash and length. Classify by both control pattern and Win32 style (`ES_PASSWORD`) where available. Add a native regression case with the synthetic fixture |
| F2 | Exact-window scope does not filter geometry outside the window | C04C: 1 element outside the window bounds | Intersect element rectangles with the window rectangle; report clipped elements as non-reusable |
| F3 | `WAIT_FOR` can never complete as `matched=false`. The contract sets `maxWallClockMs = timeoutMs`; the adapter kills the worker at that instant, before its loop ends (and PowerShell startup is not counted) | C09: the adapter timed out instead | Give the worker an inner deadline below the adapter's wall clock, or have the adapter add a bounded startup and teardown allowance. Report `matched=false` as a normal bounded outcome |
| F4 | A region-only screenshot is not checked against the displays; a region past the edge of every display was captured | R05 | In the worker (and ideally the adapter), require the region to be contained by the virtual screen or by one display |
| F5 | UIA has no occlusion model. Region and display UI snapshots include elements of **other processes beneath** the requested area (run 6: 32, run 7: 39 foreign elements under the fixture). Their names enter the local artifact | C06, C07 foreign counts | Document it as inherent. Minimize retention of foreign names (hash or omit), and keep exact-window scope the only reusable evidence (already true) |
| F6 | The PowerShell observation process is DPI-unaware (awareness 0). This was not exercised at 100 %; mixed DPI will need the native-worker Per-Monitor V2 path | U04, `probeDpiAwareness: 0` | WA-P1C / WA-P1D |

## 5. Notes on this run

- In the committed report, `integrityLevel` reads `UNKNOWN`: `WindowsIdentity.Groups` omits the mandatory label. The committed `env-probe.ps1` now reads the label from the token group list. Run standalone on the same host, it reports `"integrityLevel":"MEDIUM"`. The probe change touches no observation path.
- Earlier attempts in this session aborted on harness input-validation errors before completing (displayIds and region together after C02; `maxElements > 256` after C05). The first complete report came from the next attempt. The harness was then extended with the C04B/C04C cases and the final two identical runs were made. No artifact or temp directory from any attempt remains.

## 6. Proposed next cut

**WA-P1C should begin only after F1–F4 are fixed and WA-P1B is re-run green on this host.** F1 is the priority, because it is a confidentiality defect in observation.

The environment matrix belongs to WA-P1C: multi-monitor, negative virtual coordinates, mixed DPI, RDP/locked/disconnected sessions, secure desktop, WOW64 targets and accessibility-poor applications.

---

# Re-run 2026-10-17 — after WA-P1A.2 repairs and review hardening

> Everything above this line is the **first proof (2026-10-16) and is kept unchanged**; its report `docs/proofs/wa-p1b-native-proof-2026-10-16.json` is not modified. This section adds a separate, dated proof.

## Exact inputs (local combined branch, not pushed)

The harness ran on a local branch `wa-p1b-combined-20261017` = `main` `2743255` + normal merges of:

| PR | Branch | Head |
|---|---|---|
| #1 WA-P1A.1 strict frames | `wa-p1a1-strict-provider-frames` | `36a639a758704604acd4dff34208752fce0a096e` |
| #3 WA-P1A.2 repairs + review hardening | `wa-p1a2-native-observation-safety` | `31a6a92f6f5c2cda52f3b9c29ccfb51e5c0b7b84` |
| #2 this harness incl. follow-up | `wa-p1b-native-observation-proof` | `c844f45564d811726c685ec0d05507804743594b` |
| #5 C# skeleton strict protocol | `wa-native-skeleton-strict-protocol` | `f0a01fe182e56fd67a29262d4fdbde452073091b` |

- Combined commit `01ef591f…` (tree `e84239f0…`); capability pin unchanged (`bd55a3d…`).
- Worker SHA-256 (on-disk, CRLF): `8ff623b3…d10f`.
- `TOADAID_NATIVE_CSHARP_WORKER` pointed at the #5 skeleton built with .NET SDK 8.0.426 (`ToadAid.WindowsWorker.dll` SHA-256 `14d43bde…fc73`).
- On this combined branch: 40 tests, 35 pass, 5 live skipped. The live safety suite was run separately on #3: 29/29.
- Host, session and DPI are as in the first run: Windows 10 22H2, console session, medium integrity, 96 DPI, one 1600×900 display. The operator was present and consented.

**This is not a #2-only result on old `main`.** #2 alone on `main` still reproduces the first run's product failures.

Report: `docs/proofs/wa-p1b-native-proof-2026-10-17.json` (SHA-256 `db0eb64e…6b06`).

## Result: `23 PASS · 0 FAIL · 1 BLOCKED · 2 UNSUPPORTED`

| Case | 2026-10-16 | 2026-10-17 | Source of change |
|---|---|---|---|
| C04B password handling | FAIL | **PASS** | **Product** (#3 F1 + review). **Harness** too: the password box is now bound by fixture geometry + edit class (1 candidate), not by `automationId` |
| C04C exact-window geometry | FAIL | **PASS** | Product (#3 F2) |
| C09 absent-text wait | FAIL | **PASS** | Product (#3 F3). Evidence reason `WORKER_BUDGET_REACHED`: a contract-shaped wait (timeout = wall clock) is always ended by the inner budget |
| C10 wait longer than its wall clock | PASS (watchdog kill) | **PASS** (typed refusal `WAIT_TIMEOUT_EXCEEDS_WALL_CLOCK`) | Product (#3 review). **Harness:** the expectation now accepts the typed refusal or the watchdog, never `matched=false` |
| R05 region outside the displays | FAIL | **PASS** | Product (#3 F4) |
| W01 stalled synthetic worker | — (new) | **PASS** | Harness (new case). Killed at its wall clock, child process gone, no observation involved |
| U03 native C# skeleton | BLOCKED | **PASS** | Product (#5) + harness. A HANDSHAKE from the built skeleton decodes under the strict v1 decoder (no CRLF) |
| U02 oversized or malformed real-worker output | BLOCKED | BLOCKED | Unproven: cannot be forced without modifying the real worker (fake-worker tests only) |
| U01 other sessions, secure desktop | UNSUPPORTED | UNSUPPORTED | Unproven on this host (WA-P1C) |
| U04 mixed DPI, negative coordinates | UNSUPPORTED | UNSUPPORTED | Single display at 100 % (WA-P1C) |
| All other cases | PASS | PASS | unchanged |

**Intermediate run, kept for honesty.** Unmodified #2 harness on #3 before the review hardening gave 19 PASS · 2 FAIL (C04B harness binding, C10 premise). Both are explained above.

**Harness defect observed and fixed.** One earlier attempt crashed parsing an incomplete ready chunk, before any observation. The follow-up parses only complete, exact-prefixed records.

## Still open (not claimed)

- **Foreign elements in display/region UI snapshots.** Their names are now redacted unless positively safe (#3 policy), but UIA still has no occlusion model.
- **WinForms ordinary text boxes are `UNKNOWN`.** They surface as `Pane`, which fails closed.
- **The adapter result still carries only the `hwnd-<n>` locator.** Provider-evidence wiring (generation, PID, creation time) is WA-P1A.1 follow-up work.
- **WA-P1C (environment matrix) has not been started.**

## Harness portability and preflight (WA-PROOF-PORTABILITY-P1, issue #17)

Source and capability identity are now resolved by `scripts/wa-p1b/sourceIdentity.mjs` **before** any temp directory, fixture window or observation exists, so a refusal leaves nothing behind:

- **Source identity** uses supported git commands (`rev-parse --show-toplevel`, `rev-parse --verify HEAD^{commit}`, `symbolic-ref`, `--git-dir`/`--git-common-dir`, `status --porcelain`) instead of reading `.git/HEAD`. A clean clone and a linked `git worktree` resolve to the same commit (`worktree: MAIN | LINKED`). Missing git, a repository root that is not the harness root, a HEAD that is not a single commit, and a dirty work tree (modified or untracked entries) are refused.
- **Capability identity** trusts a lockfile only when git tracks it unmodified in HEAD; an untracked lockfile is refused even if it matches. The pinned (`package.json`), locked and actually installed (`node_modules/.package-lock.json`) commits must all be the approved `bd55a3d8fd45aeabe717e794263e04b4032fa242`, and the built `desktopObservation.js` must hash to `310e30a2058f56e1310475bd20752d8883573028f836fd946fcaedb400172cda`. Without a committed lockfile the manifest-pin fallback is used only with `--accept-manifest-pin-without-lockfile`, and the report then says `ABSENT_MANIFEST_PIN_FALLBACK`.
- `--expect-head <sha>` (optional) requires HEAD to be exactly that commit. The value must be one complete 40-character lowercase hex SHA (`WA_P1B_EXPECTED_HEAD_INVALID` otherwise, checked before any git call); a different HEAD is refused with `WA_P1B_HEAD_MISMATCH`. The report records `headExpectation: MATCHED | NOT_REQUESTED`.
- Refusals print `WA_P1B_PREFLIGHT_REFUSED code=<WA_P1B_…>` and exit 4. `--preflight-only` runs just these checks on any OS, never observes and never creates a temp directory.

The 2026-10-16 and 2026-10-17 proof reports above were produced by the earlier harness and are unchanged; any later native re-proof still requires the operator to be present and consenting.
