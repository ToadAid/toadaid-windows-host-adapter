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

## Every locked package (27 lock entries incl. the root; 26 packages)

| Package | Version | Origin | Integrity | Notes |
|---|---|---|---|---|
| `@toadaid/agent-capabilities` | 0.1.0-alpha.0 | `git+ssh://git@github.com/ToadAid/toadaid-agent-capabilities.git#bd55a3d8fd45aeabe717e794263e04b4032fa242` (public repo) | **not verified** (git dependency; npm skips the check) | pinned by commit; runs its own `prepare` (TypeScript build) on install; built `dist/src/desktopObservation.js` SHA-256 `310e30a2…cda`, identical to all earlier proofs |
| `playwright-chromium` | 1.63.0 | registry.npmjs.org | sha512 | transitive (from the capability package); **has an install script** (browser download, skipped via env) |
| `playwright-core` | 1.63.0 | registry.npmjs.org | sha512 | transitive |
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
