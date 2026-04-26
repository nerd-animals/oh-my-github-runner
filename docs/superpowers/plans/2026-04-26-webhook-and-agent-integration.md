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
- Git push auth via per-invocation `extraheader` for mutate flows
- Installation token caching in `GitHubAppClient`
- Repo allowlist enforcement
- New instruction yamls and renames
- `pr-implement` (push commits to existing PR branch)

Not included (future work):

- Codex agent registration (env-only addition later)
- `include_linked_prs` actual implementation (logged as warning at instruction load)
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

- Command must occupy the first non-empty line of the comment after `trim()`
- Lines starting with `>` (markdown blockquote) are skipped
- Lines inside a fenced code block (```` ``` ````) are skipped
- After the verb (`implement` or none), all remaining text on that line and
  the following lines is passed to the agent as
  `User additional instructions`, appended to the prompt context
- Unknown verbs (e.g. `/claude help`, `/claude refactor`) are silently
  ignored in v1; reserved for future explicit verbs

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

- Only `issues.opened` triggers; `reopened` / `edited` are ignored in v1.
- `no-ai` label suppresses the auto-trigger; explicit commands still work.
- Race protection: just before execution, the executor re-fetches issue
  labels via the GitHub API. If `no-ai` is now present, the task is marked
  `superseded` without running. Closes the window where a user adds the
  label seconds after issue creation.

## Agent Abstraction

- `TaskRecord.agent: string` (always `"claude"` for now)
- `AgentRegistry` (`name → AgentRunner` map)
- Active agents from `AGENTS=` env (comma-separated)
- Per-agent env prefix: `name.toUpperCase().replace(/-/g, "_")`. Examples:
  `claude` → `CLAUDE_COMMAND`, `codex-cli` → `CODEX_CLI_COMMAND`
- Per-agent env: `<PREFIX>_COMMAND` (required) and `<PREFIX>_ARGS_JSON`
  (optional)
- Webhook command prefix selects agent (`/claude` now, `/codex` future)
- Auto-trigger uses `DEFAULT_AGENT` env (explicit), not implicit list order
- The legacy `execution.agent` field in instruction yamls is removed; agent
  is decided at dispatch time, not authored in the instruction
- Migration: `FileQueueStore.readTasks` injects `agent = "claude"` for any
  pre-existing record that lacks the field
- Bot loop filter: at startup the webhook server calls `GET /app` to obtain
  the bot user id, and ignores incoming events whose `sender.id` matches.
  Other bots (Dependabot, Renovate, etc.) can still issue commands

## Rate-limit Handling

- Detection: agent runner consults `definitions/agents/<name>.yaml` for the
  agent's rate-limit signature: an `exit_codes:` list (matched first) and a
  `stderr_patterns:` list (regex, matched as fallback). Either match raises
  `RateLimitedError`
- TODO H2: actual exit codes / regex patterns are pending verification
  against real Claude Code CLI rate-limit responses; ship with an empty
  signature file and update once observed in production
- Daemon catches `RateLimitedError`, reverts task to `queued`, sets per-agent
  `pausedUntil` in `var/queue/state.json`
- Default cooldown 1 hour, overridable via `RATE_LIMIT_COOLDOWN_MS`
- Tasks for paused agent are skipped in scheduler tick; other agents continue
- Natural expiry: when reading `state.json`, entries with `pausedUntil < now`
  are dropped and the file rewritten. Restart does not implicitly clear
  pause for entries still in the future
- Manual override: delete `state.json`
- Observability: when all registered agents are paused, log a warning each
  scheduler tick (rate-limited to once per minute) so prolonged outages are
  visible

## Stale Supersede (observe only)

Before observe write-back to GitHub, check whether a newer task exists with
the same `(repo, source, instructionId)` and `mode === "observe"`. If yes,
skip the write-back. The newer task will run after and post the up-to-date
response.

Predicate is intentionally narrow:

- different `instructionId` → both run (e.g. `issue-initial-review` and
  `issue-comment-reply` produce distinct responses; neither should swallow
  the other)
- mutate tasks → never skipped (a queued mutate eclipsing a running observe
  must not erase the observe's comment)

Mutate tasks are not interrupted; queued mutates keep being superseded as
today (any newer queued mutate on the same source supersedes older queued
mutates).

## Repo Allowlist

```
ALLOWED_REPOS=owner/repo1,owner/repo2
```

`EnqueueService` rejects sources outside the allowlist. Defense-in-depth
alongside GitHub App installation scope.

## Installation Token Cache

`GitHubAppClient` caches two layers:

- `(repo → installationId)` from `GET /repos/{owner}/{repo}/installation`
- `(installationId → { token, expiresAt })` from
  `POST /app/installations/{id}/access_tokens`

`expires_at` is parsed from the access-token response (the current
`GitHubInstallationTokenResponse` interface only declares `token` — extend
it). JWT is regenerated on each token mint (cheap). A 60-second expiry
buffer triggers re-mint before the token actually expires.

Cache is in-memory only; on daemon restart everything is re-minted. Eviction
relies on TTL via `expires_at`; no LRU needed for the small set of
installations a single VM serves.

## Git Push Auth

Mutate and `pr-implement` flows authenticate via per-invocation `extraheader`
rather than embedding the token in the remote URL:

```
git -c http.https://github.com/.extraheader='AUTHORIZATION: Basic <b64>' \
    push origin <branch>
```

where `<b64>` is `base64("x-access-token:" + installationToken)`. The header
lives only in the single `git` process's argv, so it never lands in
`.git/config`, remote URLs, or `reflog`.

Defense-in-depth log masking: `runGit` masks any string matching
`AUTHORIZATION:\s*Basic\s+\S+` and `x-access-token:[^@\s]+` to `***` before
logging or throwing. Applies to `args`, `stderr`, and `stdout` whenever they
appear in error paths.

## pr-implement (PR follow-up commits)

Trigger: `/claude implement` on a PR comment or inline review comment.

Flow:

1. Clone from mirror
2. `git fetch origin --prune`
3. Check out the PR head ref directly
   (`checkout -B <headRef> origin/<headRef>`)
4. Run agent
5. Commit on `<headRef>` + push (fast-forward only)
6. PR auto-updates; no new PR is created
7. Post a short status comment on the PR

Pre-flight rejections (handled in dispatcher, before enqueue, with an
explanatory PR comment):

- PR is from a fork (`head.repo.full_name !== base.repo.full_name`)
- PR is already merged or closed
- PR head branch has been deleted

Runtime rejections (handled in execution, with PR comment):

- `git push` fails (non-fast-forward, branch protection, signed-commit
  requirement) → fail with the masked git error message

Merge conflicts in the working tree are not pre-rejected; the agent receives
the conflict state in the prompt and decides how to handle it.

## Updated Environment Config

```bash
RUNNER_ROOT=/home/ubuntu/oh-my-github-runner

# GitHub App
GITHUB_APP_ID=...
GITHUB_APP_PRIVATE_KEY_PATH=/etc/oh-my-github-runner/github-app.pem
GITHUB_WEBHOOK_SECRET=...

# Webhook server (bound to 127.0.0.1; Cloudflare tunnel terminates TLS upstream)
WEBHOOK_PORT=8080

# Repo allowlist (defense-in-depth)
ALLOWED_REPOS=nerd-animals/oh-my-github-runner

# Agents
AGENTS=claude
DEFAULT_AGENT=claude
CLAUDE_COMMAND=/home/ubuntu/.local/bin/claude
CLAUDE_ARGS_JSON=["-p"]

# Rate limit
RATE_LIMIT_COOLDOWN_MS=3600000
```

Removed: `AGENT_COMMAND`, `AGENT_ARGS_JSON`.

## Webhook Server

- HTTP listener bound to `127.0.0.1:${WEBHOOK_PORT}`. Public exposure is
  handled by the Cloudflare tunnel running on the same VM; no TLS in the
  Node.js process
- Public URL: `https://oh-my-github-runner.darakbox.com/webhook` (registered
  as the GitHub App's webhook URL). Path is the only routed endpoint; other
  paths return 404
- `cloudflared` ingress maps `oh-my-github-runner.darakbox.com` →
  `http://127.0.0.1:${WEBHOOK_PORT}`. Tunnel runs as a separate systemd unit
  (not bundled with the Node.js daemon)
- HMAC verification:
  - Header: `X-Hub-Signature-256`
  - Compute `hmac-sha256(GITHUB_WEBHOOK_SECRET, raw_body)` over the **raw**
    request bytes, not the parsed JSON
  - Compare via `crypto.timingSafeEqual`
  - On failure: respond `401`, do not enqueue
- Delivery dedup: in-memory LRU keyed by `X-GitHub-Delivery`
  (10-minute TTL, ~1024 entries). Repeated deliveries return `200` without
  re-enqueuing, so GitHub retry loops collapse cleanly
- Response budget: respond `200` within ~1s. Enqueue is fast (file write);
  any slower work (label re-fetch, fork checks) happens at execution time
- Bot id filter: see Agent Abstraction
- Repo allowlist: see Repo Allowlist

## GitHub App Subscription

Required events:

- Issue comment (already subscribed)
- Pull request review comment (already subscribed)
- **Issues** (to add for auto-trigger)

Permission changes: none. Adding events does not require installation
re-approval.

## Work Order

Each item is a single commit, pushed and pullable on the VM. Each item also
ships its own unit tests; the commit is not done until tests pass. Item 12
is the final cross-cutting E2E.

| #    | Description                                                                | Unit tests in scope                                          |
| ---- | -------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 1    | Instruction yaml restructure (5 files: 1 new, 2 renames, 2 carried)        | loader still parses each yaml; `execution.agent` removed     |
| 2    | Agent abstraction (registry, `TaskRecord.agent`, env split, migration)     | registry resolution, env var normalization, schema migration |
| 3    | event-dispatcher (source-aware verbs, `no-ai` opt-out, extra context)      | command parser, verb mapping, fork rejection                 |
| 4    | webhook-server (HTTP + HMAC + delivery dedup + bot filter)                 | HMAC pos/neg, dedup, sender filter                           |
| 5    | Process integration (daemon + webhook in one process, graceful shutdown)   | shutdown ordering                                            |
| 6    | Stale supersede for observe tasks                                          | predicate (same source × same instruction × observe)         |
| 6.5  | `pr-implement` workspace + execution-service branching                     | branching logic, push failure surfaces                       |
| 7    | Rate-limit aware queue + `state.json` natural expiry                       | pause/resume, expiry, scheduler skip                         |
| 8    | Installation token cache (with `expires_at`)                               | hit, miss, near-expiry re-mint                               |
| 9    | Git push auth via `extraheader` + log masking                              | masking regex, no token in `.git/config`                     |
| 10   | Repo allowlist enforcement                                                 | allow/deny matrix                                            |
| 11   | systemd unit update + Cloudflare tunnel deployment notes                   | —                                                            |
| 12   | End-to-end test (real issue → initial review)                              | full live run                                                |

## Instruction Files

Final layout under `definitions/instructions/`:

- `issue-initial-review.yaml` — new, observe, fires on issue.opened
- `issue-comment-reply.yaml` — renamed from `issue-comment-opinion`
- `pr-review-comment.yaml` — unchanged
- `issue-implement.yaml` — renamed from `issue-to-pr`
- `pr-implement.yaml` — new, mutate, push to existing PR branch

All five drop the `execution.agent` field (see Agent Abstraction). The
renames break any in-flight task whose `instructionId` references the old
name. Acceptable in v1 (no live deployments yet); the file-queue store will
fail to load such tasks and they should be removed manually.

## Decision Log

- Issue auto-trigger: all issues; `no-ai` label opts out; recheck label at
  execute time to close the race
- Auto-trigger event scope: `issues.opened` only
- Discussion replies: command-only
- Implement trigger: command-only
- PR auto-review: not enabled; opt-in via command
- Stale handling: observe-only skip; predicate is `(source, instructionId,
  mode=observe)`; mutate runs to completion
- Cooldown: 1 hour fixed, env-overridable; pause has natural expiry on read
- Rate-limit detection: exit code first, regex fallback; patterns
  externalized to `definitions/agents/<name>.yaml`
- Verb minimalism: 2 verbs (default observe, `implement` mutate); other
  verbs reserved (silently ignored in v1)
- Agent prefix: `/claude` only (no `/ai`); auto-trigger uses `DEFAULT_AGENT`
- Instruction yaml: `execution.agent` field removed (agent decided at
  dispatch time)
- Per-agent rate-limit pause: designed in, only claude registered for now
- Repo allowlist: enabled
- Token cache: enabled (in-memory, two-layer: repo→installationId,
  installationId→token)
- Workspace per task: clone fresh, mirror-cached for speed, deleted at task
  end; orphaned workspaces swept at daemon startup
- Bot filter: bot id whitelist (our App's bot id only); other bots can
  issue commands
- Push auth: `extraheader` per invocation, never URL-embedded; output
  masked
- Webhook transport: Cloudflare tunnel terminates TLS, Node.js binds to
  `127.0.0.1`
- Webhook idempotency: in-memory `X-GitHub-Delivery` LRU dedup, 10-minute
  TTL
- HMAC: `X-Hub-Signature-256`, raw body, `timingSafeEqual`, fail = 401
- pr-implement v1: same-repo only, fast-forward only; pre-flight rejections
  in dispatcher (fork, merged, closed, deleted head)
- Test policy: every work-order item ships with unit tests; #12 is E2E

## Known Risks / Edge Cases

- Webhook redelivery (GitHub retries on 5xx/timeout): respond 200 quickly +
  in-memory delivery-id LRU dedup so duplicates collapse even after the
  original task completed
- Bot loop: filter on `sender.id === <our App's bot user id>` (looked up
  once at startup via `GET /app`); other bots can still issue commands
- Daemon crash mid-task: `var/workspaces/*` may leak; the daemon now sweeps
  any workspace not associated with a `running` task at startup
- Rate-limit false positive: cooldown elapses, scheduler retries
  automatically; pause file's natural-expiry-on-read prevents stuck pauses
- Rate-limit detection drift: regex patterns may break when the agent CLI
  changes its messages — patterns are externalized to
  `definitions/agents/<name>.yaml` so they can be updated without code
  changes
- Token cache eviction: hard-coded TTL via `expires_at`; no LRU needed
- Branch protection on PR head (`pr-implement`): signed-commit requirements
  or required-reviews-bypass policies cause `git push` to fail; surfaced
  back to the user as a PR comment with the masked git error
- Idle pause visibility: when all registered agents are paused, scheduler
  logs a rate-limited warning so prolonged outages are detectable
- Token leakage: push uses `git -c http.<base>.extraheader=...` per
  invocation, never URL-embedded; runGit masks `AUTHORIZATION: Basic ...`
  and `x-access-token:...` from any logged output
