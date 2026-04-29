# oh-my-github-runner

Single-VM queue consumer and executor for GitHub-native AI coding tasks.

## Layout

- `definitions/prompts`: prompt fragments composed by strategies
- `definitions/tools`: per-tool yaml descriptors (argv, rate-limit signatures)
- `src/cli`: local enqueue entrypoints
- `src/daemon`: long-running queue poller
- `src/domain`: core types and contracts
- `src/strategies`: per-instruction runtime behavior (id-keyed registry)
- `src/services`: orchestration logic
- `src/infra`: storage and external integrations
- `tests`: unit and integration tests

## Initial Commands

```bash
npm install
npm run build
npm run test
npm run compile
```

## Windows Development

This workspace may run under a Windows user/session that cannot access the original Node/npm profile directory. In that case, use the repo-local wrappers instead of calling `npm.cmd` or `git` directly.

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\npm.ps1 install
powershell -ExecutionPolicy Bypass -File .\tools\npm.ps1 run build
powershell -ExecutionPolicy Bypass -File .\tools\npm.ps1 run test
powershell -ExecutionPolicy Bypass -File .\tools\git.ps1 status --short
```

The npm wrapper sets repo-local `APPDATA`, `LOCALAPPDATA`, `USERPROFILE`, cache, and prefix paths under `tmp/` before invoking `npm.cmd`. The git wrapper adds a repo-local `safe.directory` override.

## Current Scope

This repository contains a working v1 local runner skeleton:

- strategy registry that maps each instruction id to runtime behavior
- local queue storage with same-source supersede behavior
- scheduler with concurrency budget and per-tool pause
- daemon orchestration and recovery
- local TTL log storage
- headless tool adapter (forwards SIGTERM via AbortController)
- git workspace manager
- GitHub App client

## Runtime Configuration

Use [.env.example](.env.example) as the template for production configuration.

Required variables:

- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY_PATH`
- `GITHUB_WEBHOOK_SECRET`
- `<TOOL>_COMMAND` (binary path) for each tool you want to enable.
  Known tools are listed in `KNOWN_TOOLS` in `src/services/tool-registry.ts`;
  at least one must be set or the runner refuses to start.
- `ALLOWED_SENDER_IDS`

Trigger syntax: comments use `/omgr` (optionally `/omgr implement ...`).
The strategy decides which tool runs each task — there is no
per-comment tool selection.

Useful files:

- systemd unit: [oh-my-github-runner.service](ops/systemd/oh-my-github-runner.service)

## Forking / self-hosting

The runner does not embed any owner/repo identity in `src/`, so a fork
is mostly an external-resources exercise (new GitHub App, Cloudflare
tunnel, tailnet). See the
[Forking checklist](docs/deployment.md#forking-checklist) in the
deployment doc for the short list of values you must replace.
