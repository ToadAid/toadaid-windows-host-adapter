# CI (GitHub Actions) — scope and limits

Workflow: `.github/workflows/ci.yml`. Runs on pull requests and pushes to `main`.

## What it runs

| Job | Runner | Steps |
|---|---|---|
| `build + tests (ubuntu-24.04)` | GitHub-hosted Linux | install, `npm run build`, `npm test` |
| `build + tests (windows-2022)` | GitHub-hosted Windows | same; native Windows tests that need no interactive desktop run here, live UI tests are skipped |

- Permissions: `contents: read` only; checkout does not persist credentials.
- No secrets, no elevation, no browsers (Playwright's browser download is
  skipped), no live agents, no production paths.
- **Live desktop observation never runs on CI.** Those tests are opt-in with
  `TOADAID_NATIVE_OBSERVATION_TESTS=1` and the operator present; the workflow
  forces it empty. Native C# interop tests need `TOADAID_NATIVE_CSHARP_WORKER`
  (a built skeleton), also forced empty.
- Actions are pinned by commit SHA (`actions/checkout` v7.0.1,
  `actions/setup-node` v7.0.0); Node 22 (`engines: >=22`).

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
  (`bd55a3d8fd45aeabe717e794263e04b4032fa242`); npm prints
  `skipping integrity check for git dependency`, so it is **not**
  integrity-verified, and its `prepare` build runs during install.
- Playwright's browser download is skipped (`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`);
  `playwright-chromium` still declares an install script.
