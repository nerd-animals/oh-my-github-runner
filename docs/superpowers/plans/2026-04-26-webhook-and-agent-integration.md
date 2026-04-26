# Webhook & Agent Integration Plan

Date: 2026-04-26
Status: Approved in chat, ready to implement

## Goal

Replace Actions-based enqueue with a GitHub App webhook flow. Auto-respond to
opened issues, support command-based interactions on issues and PRs, and lay
the groundwork for multiple AI agents (claude first, codex later).

## Scope

Included:

- GitHub App webhook receiver on the runner VM
- Event dispatcher mapping events and commands to instructions
- Multi-agent abstraction with claude as the only registered agent
- Rate-limit-aware queue with per-agent pause
- Stale-result supersede for observe tasks
- Git push token injection for mutate flows
- Installation token caching in `GitHubAppClient`
- Repo allowlist enforcement
- New instruction yamls and renames
- `pr-implement` (push commits to existing PR branch)

Not included (future work):

- Codex agent registration (env-only addition later)
- `include_linked_prs` actual implementation
- Mirror cache eviction policy
- User-level command authorization
- `/claude help` and similar discoverability commands
- Branch protection / force-push handling
- claude login automation

## Mental Model

Issue is the unit of work. Lifecycle:

1. User opens issue → AI auto-reviews (unless `no-ai` label)
2. User and others discuss in comments
3. User invokes AI explicitly with `/claude` for a reply
4. User invokes `/claude implement` to produce a PR
5. PR review uses `/claude` (review) or `/claude implement` (follow-up commits)

## Command Syntax

```
/claude              ← observe (read), source-aware
/claude implement    ← mutate (read + write), source-aware
```

Parsing rules:

- Command must occupy the first non-empty, non-quoted line of the comment
- Verb tokens after `implement` (or after `claude` when no verb) are passed to
  the agent as additional context
- Unknown commands are silently ignored

Source-aware mapping:

| Verb        | Source       | Instruction            |
| ----------- | ------------ | ---------------------- |
| (none)      | issue        | `issue-comment-reply`  |
| (none)      | pull_request | `pr-review-comment`    |
| `implement` | issue        | `issue-implement`      |
| `implement` | pull_request | `pr-implement`         |

`/claude` = read-only, `/claude implement` = read + write. Permission and mode
boundaries align.

## Auto-trigger

```
event=issues, action=opened, no `no-ai` label
  →  enqueue issue-initial-review (observe)
```

`no-ai` label only suppresses the auto-trigger; explicit commands still work.

## Agent Abstraction

- `TaskRecord.agent: string` (always `"claude"` for now)
- `AgentRegistry` (`name → AgentRunner` map)
- Per-agent env: `<NAME>_COMMAND` and optional `<NAME>_ARGS_JSON`
- Active agents from `AGENTS=` env (comma-separated)
- Webhook command prefix selects agent (`/claude` now, `/codex` future)
- Auto-trigger uses the first registered agent (claude)

## Rate-limit Handling

- Agent runner detects rate-limit patterns in stdout/stderr → throws
  `RateLimitedError`
- Daemon catches, reverts task to `queued`, sets per-agent paused-until
- `var/queue/state.json` persists pause state across restarts
- Default cooldown 1 hour, overridable via `RATE_LIMIT_COOLDOWN_MS`
- Tasks for paused agent are skipped in scheduler tick; other agents continue
- Manual override: delete `state.json` or restart daemon

## Stale Supersede (observe only)

Before observe write-back to GitHub, check whether a newer task exists for the
same source. If yes, skip the write-back. The newer task will run after and
post the up-to-date response.

Mutate tasks are not interrupted; queued mutates keep being superseded as today.

## Repo Allowlist

```
ALLOWED_REPOS=owner/repo1,owner/repo2
```

`EnqueueService` rejects sources outside the allowlist. Defense-in-depth
alongside GitHub App installation scope.

## Installation Token Cache

`GitHubAppClient` caches `(installationId → { token, expiresAt })`. JWT and
installation token are reissued only on miss or near-expiry (60-second buffer).
Avoids 4-5 redundant token mints per task and reduces GitHub API rate usage.

## Git Push Auth

Mutate flow injects installation token into push URL:

```
https://x-access-token:${token}@github.com/owner/repo.git
```

Token is fetched at push time, written to the remote URL in the task workspace,
and discarded together with the workspace at task end. Same mechanism for
`pr-implement`.

## pr-implement (PR follow-up commits)

Trigger: `/claude implement` on a PR comment or inline review comment.

Flow:

1. Clone from mirror
2. fetch
3. Check out the PR head ref directly (not a new branch)
4. Run agent
5. Commit + push to the existing head ref
6. PR auto-updates; no new PR is created
7. Post a short status comment on the PR

`v1` constraints:

- PR must be on the same repo (no fork support)
- Branch must accept fast-forward push (no force-push handling)

## Updated Environment Config

```bash
RUNNER_ROOT=/home/ubuntu/oh-my-github-runner

# GitHub App
GITHUB_APP_ID=...
GITHUB_APP_PRIVATE_KEY_PATH=/etc/oh-my-github-runner/github-app.pem
GITHUB_WEBHOOK_SECRET=...

# Webhook server
WEBHOOK_PORT=8080

# Repo allowlist (defense-in-depth)
ALLOWED_REPOS=nerd-animals/oh-my-github-runner

# Agents
AGENTS=claude
CLAUDE_COMMAND=/home/ubuntu/.local/bin/claude
CLAUDE_ARGS_JSON=["-p"]

# Rate limit
RATE_LIMIT_COOLDOWN_MS=3600000
```

Removed: `AGENT_COMMAND`, `AGENT_ARGS_JSON`.

## GitHub App Subscription

Required events:

- Issue comment (already subscribed)
- Pull request review comment (already subscribed)
- **Issues** (to add for auto-trigger)

Permission changes: none. Adding events does not require installation
re-approval.

## Work Order

Each item is a single commit, pushed and pullable on the VM.

| #    | Description                                                                |
| ---- | -------------------------------------------------------------------------- |
| 1    | Instruction yaml restructure (5 files: 1 new, 2 renames, 2 carried)        |
| 2    | Agent abstraction (registry, `TaskRecord.agent`, env split)                |
| 3    | event-dispatcher (source-aware verbs, `no-ai` opt-out, extra context)      |
| 4    | webhook-server (HTTP + HMAC + dispatcher integration)                      |
| 5    | Process integration (daemon + webhook in one process, graceful shutdown)   |
| 6    | Stale supersede for observe tasks                                          |
| 6.5  | `pr-implement` workspace + execution-service branching                     |
| 7    | Rate-limit aware queue + `state.json` persistence                          |
| 8    | Installation token cache                                                   |
| 9    | Git push token injection                                                   |
| 10   | Repo allowlist enforcement                                                 |
| 11   | systemd unit update + deployment notes                                     |
| 12   | End-to-end test (real issue → initial review)                              |

## Instruction Files

Final layout under `definitions/instructions/`:

- `issue-initial-review.yaml` — new, observe, fires on issue.opened
- `issue-comment-reply.yaml` — renamed from `issue-comment-opinion`
- `pr-review-comment.yaml` — unchanged
- `issue-implement.yaml` — renamed from `issue-to-pr`
- `pr-implement.yaml` — new, mutate, push to existing PR branch

## Decision Log

- Issue auto-trigger: all issues; `no-ai` label opts out
- Discussion replies: command-only
- Implement trigger: command-only
- PR auto-review: not enabled; opt-in via command
- Stale handling: observe-only skip; mutate runs to completion
- Cooldown: 1 hour fixed, env-overridable
- Verb minimalism: 2 verbs (default observe, `implement` mutate)
- Agent prefix: `/claude` only (no `/ai`, no default fallback)
- Per-agent rate-limit pause: designed in, only claude registered for now
- Repo allowlist: enabled
- Token cache: enabled
- Workspace per task: clone fresh, mirror-cached for speed, deleted at task end

## Known Risks / Edge Cases

- Webhook redelivery (GitHub retries on 5xx/timeout): respond 200 quickly,
  enqueue handles supersede so duplicates collapse
- Bot loop: filter `sender.type === "Bot"`; our App posts as bot, so its own
  events are ignored
- Daemon crash mid-task: `var/workspaces/*` may leak; recovery marks status
  failed but does not clean directories — accepted minor leak for v1
- Rate-limit false positive: cooldown elapses, scheduler retries automatically
- Token cache eviction: hard-coded TTL via `expires_at`; no LRU needed for the
  small set of installations a single VM serves
