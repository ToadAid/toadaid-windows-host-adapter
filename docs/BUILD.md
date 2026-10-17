# Build output hygiene (`dist/`)

`dist/` is generated, untracked output (`.gitignore`). Since WA-BUILD-CLEAN-P1
(issue #16) the build and test scripts guarantee that tests from another
branch or an older build can never run:

| Script | What it does |
|---|---|
| `npm run build` | `clean --prepare` → `tsc -p tsconfig.build.json` → `mark` |
| `npm run test:build` | `clean --prepare` → `tsc -p tsconfig.json` → `mark` |
| `npm test` | `test:build`, then `run-tests`: runs **exactly** the compiled tests of the current `test/**/*.test.ts` sources |
| `npm run clean` | removes the generated `dist/` (fails closed, see below) |

All of this lives in `scripts/dist-hygiene.mjs`.

## Ownership marker

`dist/.toadaid-dist-owner.json` records the package, the `status`
(`building` → `complete`), the tsconfig used, the SHA-256 of that tsconfig and
of every config it `extends` (relative paths only), the git `HEAD` commit, and
the SHA-256 of every source file compiled. `mark` refuses when git `HEAD`
cannot be resolved or an `extends` target cannot be verified.

`run-tests` refuses unless the marker is `complete`, came from `tsconfig.json`,
and matches the current source bytes, the current git `HEAD` and the current
compiler configuration bytes, and unless the set of compiled
`dist/test/**/*.test.js` files equals the current sources exactly (an extra
file is reported as a stale compiled test and never executed). `npm test`
always rebuilds first, so these refusals only matter when `run-tests` is
called directly on an older build.

## When the cleanup refuses

`clean` removes `dist/` only when it is provably this package's generated
output. It refuses, deletes nothing and exits 2 when:

- the root's `package.json` is not this package, or the root is not in a git work tree;
- `dist` is a symlink/junction, a file, or resolves outside the repository root;
- the ownership marker is missing, foreign, or has an unknown status;
- anything under `dist` is a symlink/junction, or a file that is not compiler
  output (`.js`, `.d.ts` or their `.map`), apart from the marker;
- any file under `dist` is tracked or staged in git.

There is no globbing, no `git clean`, reset or stash, and nothing outside
`dist/` is touched.

**One-time step for existing checkouts.** A `dist/` built before this change has
no marker, so the first build refuses with `unknown ownership`. Check what is
in that `dist/`, then move or delete it yourself once; every later build
manages it automatically. Fresh clones and CI are unaffected.
