# oh-my-github-runner

Single-VM queue consumer and executor for GitHub-native AI coding tasks.

## Layout

- `definitions/instructions`: reusable task instructions
- `src/cli`: local enqueue entrypoints
- `src/daemon`: long-running queue poller
- `src/domain`: core types and contracts
- `src/services`: orchestration logic
- `src/infra`: storage and external integrations
- `tests`: unit and integration tests
- `docs/superpowers`: design and planning documents

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

- instruction loading from `definitions/instructions`
- local queue storage with same-source supersede behavior
- scheduler rules for `observe` and `mutate`
- daemon orchestration and recovery
- local TTL log storage
- headless agent adapter
- git workspace manager
- GitHub App client

## Runtime Configuration

Use [.env.example](/D:/workspace/oh-my-github-runner/.env.example) as the template for production configuration.

Required variables:

- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY_PATH`
- `AGENT_COMMAND`

Useful files:

- systemd unit: [oh-my-github-runner.service](/D:/workspace/oh-my-github-runner/ops/systemd/oh-my-github-runner.service)
- design spec: [2026-04-24-oracle-vm-github-runner-design.md](/D:/workspace/oh-my-github-runner/docs/superpowers/specs/2026-04-24-oracle-vm-github-runner-design.md)
