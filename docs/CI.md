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

## Dependency installation (and why it is not reproducible yet)

- The repository has **no committed lockfile**, so `npm ci` cannot run (it
  exits `EUSAGE`). CI uses `npm install --include=dev --no-package-lock`, which
  resolves the exact pins in `package.json` and writes no lockfile.
- `package.json` pins exact versions (`@types/node 22.20.4`,
  `typescript 7.0.2`, `@toadaid/agent-capabilities` at commit
  `bd55a3d8fd45aeabe717e794263e04b4032fa242`), but **transitive** versions are
  resolved at install time and npm cannot verify an integrity hash for the git
  dependency. A run is therefore reproducible only up to those pins; the
  `npm ls --all` step records what was actually installed.
- The git dependency runs its own `prepare` (TypeScript build) during install.
- `--include=dev` is explicit because some developer hosts (including the
  operator's Windows host) set `NODE_ENV=production` / `omit=dev`, which would
  otherwise silently skip `typescript` and `@types/node`.
- This cut does **not** repin anything and does **not** add a lockfile.
  Proposal for a separate review: commit a `package-lock.json` generated from
  the current pins, switch CI to `npm ci`, and review the lock's resolved
  tarball/commit integrity entries.
