# CI (GitHub Actions) — scope and limits

Workflow: `.github/workflows/ci.yml`. Runs on pull requests and pushes to `main`.

## What it runs

| Job | Runner | Steps |
|---|---|---|
| `build + tests (ubuntu-24.04)` | GitHub-hosted Linux | install, `npm run build`, `npm test` |
| `build + tests (windows-2022)` | GitHub-hosted Windows | same; native Windows tests that need no interactive desktop run here, live UI tests are skipped |
| `native C# skeleton (.NET 10, windows-2022)` | GitHub-hosted Windows | .NET SDK 10.0.402 via pinned `actions/setup-dotnet`; fails unless the SDK in use is 10.x; builds `native/ToadAid.WindowsWorker` (warnings as errors) and checks the built `runtimeconfig` targets `net10.0`; runs the strict Node/C# interop + source tests against the built executable and **fails on any skip** (exactly 4 tests, 4 pass) |

- Permissions: `contents: read` only; checkout does not persist credentials.
- No secrets, no elevation, no browsers (Playwright's browser download is
  skipped), no live agents, no production paths.
- **Live desktop observation never runs on CI.** Those tests are opt-in with
  `TOADAID_NATIVE_OBSERVATION_TESTS=1` and the operator present; the workflow
  forces it empty. Native C# interop tests need `TOADAID_NATIVE_CSHARP_WORKER`
  (a built skeleton): it is forced empty in the `build + tests` jobs and set
  only in the .NET 10 skeleton job, to the executable that job just built. The
  skeleton handles one-shot HANDSHAKE/HEALTH frames; OBSERVE is
  `UNIMPLEMENTED_KIND`.
- Actions are pinned by commit SHA (`actions/checkout` v7.0.1,
  `actions/setup-node` v7.0.0, `actions/setup-dotnet` v6.0.0
  `a98b56852c35b8e3190ac28c8c2271da59106c68`); Node 22 (`engines: >=22`).

## Dependency installation

- Dependencies are installed with **`npm ci --include=dev`** from the committed
  `package-lock.json` (lockfileVersion 3), and the job fails if the install
  changes the lockfile. See `docs/DEPENDENCY_LOCK.md` for the reviewed
  contents of the lock.
- `--include=dev` is explicit because some developer hosts (including the
  operator's Windows host) set `NODE_ENV=production` / `omit=dev`, which would
  otherwise silently skip `typescript` and `@types/node`.
- Registry packages are verified by their `integrity` (sha512) hashes. The
  git-sourced `@toadaid/agent-capabilities` is pinned by **commit**
  (`be750075e644be399d0dc92df406074d3bbff9c2`); npm prints
  `skipping integrity check for git dependency`, so it is **not**
  integrity-verified, and its `prepare` build runs during install.
- Playwright is no longer installed: at this pin it is an optional peer of
  the capability package (WA-CAP-SYNC-P1). `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`
  stays set as a harmless guard.

## Test temp-directory leak gate

Both `build + tests` jobs snapshot the test-owned entries (`toadaid-*`,
`wa-p1a2-*`) directly inside the OS temp directory before `npm test` and fail
if new ones remain afterwards (`scripts/test-temp-leaks.mjs`). The verify step
runs even when `npm test` failed (`if: always()`), but only when the snapshot
step succeeded; the job still fails on the original test failure, so a clean
leak check can never mask it. The gate only
reports each leftover's name, file count and size; it never deletes, moves or
reads anything. Tests own their temp roots through
`test/support/tempRoot.ts` (`withTempRoot`), which removes exactly the root it
created after success or failure and refuses a root that was replaced by a
symlink/junction or no longer resolves to itself.
