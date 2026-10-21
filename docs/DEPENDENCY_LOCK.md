# Dependency lock review (WA-DEPENDENCY-LOCK-P1)

`package-lock.json` was generated from the **unchanged** `package.json` pins;
no dependency was added, removed or repinned.

- Generator: Node v22.22.0, npm 10.9.4,
  `npm install --package-lock-only --ignore-scripts --include=dev` in a clean
  checkout. lockfileVersion 3. SHA-256 of the generated file:
  `832dd22eb2fa3b4c148a8157c6f40b262db8990741fd02ab5bc4efd1e1f2862e`.
- Clean installs verified with `npm ci --include=dev` and
  `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` on Linux (Node 22) and native Windows
  (Node 25.9.0), followed by build and the full suite.

## Every locked package (27 lock entries incl. the root at review time; 25 after WA-CAP-SYNC-P1)

| Package | Version | Origin | Integrity | Notes |
|---|---|---|---|---|
| `@toadaid/agent-capabilities` | 0.1.0-alpha.0 | `git+ssh://git@github.com/ToadAid/toadaid-agent-capabilities.git#be750075e644be399d0dc92df406074d3bbff9c2` (public repo; was `#bd55a3d8…`, see the update below) | **not verified** (git dependency; npm skips the check) | pinned by commit; runs its own `prepare` (TypeScript build) on install; built `dist/src/desktopObservation.js` SHA-256 `86f0d458…f755` (was `310e30a2…cda` at `bd55a3d8`, which all 2026-10-16/17 proofs are bound to) |
| ~~`playwright-chromium`~~ | — | — | — | **removed** by WA-CAP-SYNC-P1: the capability package now declares it an *optional peer* |
| ~~`playwright-core`~~ | — | — | — | **removed** with it |
| `typescript` | 7.0.2 | registry.npmjs.org | sha512 | dev |
| `@typescript/typescript-<os>-<cpu>` ×20 | 7.0.2 | registry.npmjs.org | sha512 | dev, optional, platform-specific native compilers (aix, darwin, freebsd, linux, netbsd, openbsd, sunos, win32 variants); only the host's one is installed |
| `@types/node` | 22.20.4 | registry.npmjs.org | sha512 | dev |
| `undici-types` | 6.21.0 | registry.npmjs.org | sha512 | dev, transitive from `@types/node` |

- Registry origins: only `https://registry.npmjs.org/`; git origin: only
  `github.com/ToadAid/toadaid-agent-capabilities` at the existing pin.
- No unexpected package, no other git or URL dependency, no new install hook
  beyond `playwright-chromium` (already present before the lock) and the
  capability package's `prepare`.

## Residuals

- The git dependency is commit-pinned but not integrity-verified; a
  compromised GitHub history rewrite at that SHA is out of npm's checks.
  A future option is publishing the capability package as a registry tarball
  with an integrity hash (separate decision).
- `npm ci` still executes install-time scripts (capability `prepare`,
  Playwright's install script with the download disabled).

## Update: WA-CAP-SYNC-P1 (proposed, needs review)

- The capability pin moves `bd55a3d8…` → `be750075…`, the caps main that
  Agent2 vendors. It brings the hardened desktop-observation contract
  (provider identity, display topology epoch, exact-window geometry, wait
  completion reason).
- At `be750075`, `playwright-chromium` is an **optional peer** of the
  capability package. It is no longer installed here, so the lock shrinks
  from 27 to **25** entries, and Playwright's install script no longer runs.
  The capability package root re-exports its browser modules, which import
  Playwright, so this adapter imports only the narrow
  `@toadaid/agent-capabilities/desktop-observation` surface; the tests also
  use `/host-session`, `/policy`, `/contracts`, `/invocation` and `/budget`.
- The only remaining install-time script is the capability `prepare` build.
