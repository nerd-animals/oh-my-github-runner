# Testing

## Stack

- `node:test` + `assert/strict`. No external runners or mocking libs.
- Compile then run: `tsconfig.test.json` → `.test-dist/`, `tools/run-tests.mjs` imports every `.test.js`.

## Run

- All: `npm test`
- Subset: `npm test -- .test-dist/tests/unit/<file>.test.js`
- Type check only: `npm run build`
- Runtime build (for `npm run daemon`): `npm run compile`

## Layout

- `tests/unit/*.test.ts` — mock at port boundary (`src/domain/ports/*`). One file ≈ one source file.
- `tests/integration/*.test.ts` — multi-layer, no real GitHub. Use only when a unit test can't capture the invariant.

## Conventions

- One reason to fail per test.
- New behavior: ≥1 happy path + ≥1 failure path. Bug fix: regression test that fails before / passes after.
- Filesystem tests: `mkdtemp` + `try/finally` + `rm(root, { recursive: true, force: true })`. Reference: `tests/unit/file-log-store.test.ts`.
- Don't mock internal helpers or assert on private shapes — they rot. Stick to the port seam.
- Strategy tests: stub `Toolkit`, assert on `tk.ai.run` fragments (persona file, omgr-doc path, allowedTools preset). Reference: `tests/unit/issue-initial-review-strategy.test.ts`.

## CI

No PR-level CI in v1. `npm test` runs on the VM at deploy time only — catch failures locally before push.
