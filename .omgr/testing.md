# Testing

## Framework

- `node:test` with `assert/strict`. No external test runner, no mocking library.
- TypeScript is compiled to JS first (`tsconfig.test.json` → `.test-dist/`); `tools/run-tests.mjs` then imports every `*.test.js` under `.test-dist/tests/` and runs them.
- Run everything: `npm test`. Run a subset: `npm test -- .test-dist/tests/unit/<file>.test.js`.

## Layout

- `tests/unit/*.test.ts` — pure unit tests. Mock at the **port** boundary (`src/domain/ports/*`), not internal helpers. Most files mirror a single source file (e.g. `toolkit.test.ts` covers `src/services/toolkit.ts`).
- `tests/integration/*.test.ts` — multi-layer tests that don't touch real GitHub (HTTP contract → file queue → dispatcher → enqueue, etc.). Use these only when a unit test can't capture the cross-component invariant. The README inside lists the manual end-to-end smoke procedure (real webhook against a real repo).

## Conventions

- One reason to fail per test. A failing assertion should point at one root cause.
- For new behaviors: minimum one happy path + one failure path. For bug fixes: a regression test that fails before the fix, passes after.
- Use `mkdtemp(join(tmpdir(), "<prefix>-"))` + `await rm(root, { recursive: true, force: true })` in a `try/finally` for any test that touches the filesystem. `tests/unit/file-log-store.test.ts` is the reference pattern.
- Don't mock internal helpers or assert on private shapes — those tests rot the next time the implementation moves. Stick to the port seam.
- For strategies, tests typically build a stub `Toolkit` and assert on the fragments passed into `tk.ai.run` (which persona file is used, which `omgr-doc` path, which `allowedTools` preset). See `tests/unit/issue-initial-review-strategy.test.ts` for the multi-persona pattern.

## Running

```sh
npm run build       # tsc --noEmit (type check only)
npm test            # compile tests then execute
npm run compile     # full runtime build to dist/ (needed for `npm run daemon`)
```

`npm test` reports TAP. CI runs `npm test` on the VM at deploy time only — there is no PR-level CI in v1, so test failures should be caught locally before push.
