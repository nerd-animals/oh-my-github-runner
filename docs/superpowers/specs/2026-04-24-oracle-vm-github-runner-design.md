# Oracle VM GitHub Runner Assistant Design

Date: 2026-04-24
Status: Draft approved in chat, pending file review

## Goal

Build a lightweight assistant system that runs on a single Oracle VM.

GitHub Actions should only enqueue work. A local runner program on the VM should poll the queue, schedule tasks with simple concurrency rules, execute a headless AI coding agent, and write the requested GitHub results back to the source issue or pull request.

The design intentionally avoids external services for v1. Queueing, execution, and short-lived logs all run on the same VM.

## Non-Goals

- No external public API in v1
- No container-per-task isolation in v1
- No GitHub-native long-running execution in Actions jobs
- No detailed long-term execution log retention
- No generic arbitrary prompt execution interface

## High-Level Architecture

The VM runs three local components:

1. A self-hosted GitHub Actions runner
2. A local enqueue CLI
3. A long-running runner daemon

Responsibilities are split as follows:

- GitHub Actions receives issue or pull request events and invokes the local enqueue CLI on the VM
- The enqueue CLI validates and stores a task in the local queue
- The runner daemon polls the local queue, applies scheduling rules, executes the headless agent, and performs the requested GitHub write operations
- Short-lived system logs are stored locally on the VM and expired after 3 days

This keeps GitHub and the execution engine loosely coupled while avoiding extra infrastructure.

## Core Design Principles

- GitHub Actions only enqueue tasks
- The runner daemon owns scheduling, concurrency, and execution policy
- Task purpose is selected by `instruction_id`
- The latest instruction definition is always used at execution time
- Instruction definitions include both behavior and permissions
- `observe` and `mutate` work must be separated by policy
- GitHub should contain user-facing results, not system lifecycle noise
- System logs should be lightweight and automatically expired

## Task Model

Tasks are GitHub-native requests. The source object is always an issue or pull request.

Examples:

- "Read issue #100 and leave an opinion comment"
- "Read issue #100 and its comments, implement the change, push a branch, and open a PR"
- "Review PR #52 and leave review findings"

Tasks do not carry raw reusable prompt text. Instead, they reference a named instruction.

### Enqueue CLI Interface

Recommended v1 interface:

```bash
runner enqueue \
  --repo-owner example-org \
  --repo-name example-repo \
  --source-kind issue \
  --source-number 100 \
  --instruction-id issue-to-pr
```

Required arguments:

- `--repo-owner`
- `--repo-name`
- `--source-kind` with values `issue` or `pull_request`
- `--source-number`
- `--instruction-id`

Optional arguments:

- `--base-branch`
- `--priority`
- `--requested-by`

### Stored Task Shape

Illustrative queue record:

```json
{
  "task_id": "task_2026_04_24_001",
  "repo": {
    "owner": "example-org",
    "name": "example-repo"
  },
  "source": {
    "kind": "issue",
    "number": 100
  },
  "instruction_id": "issue-to-pr",
  "status": "queued",
  "priority": "normal",
  "requested_by": "github-actions",
  "created_at": "2026-04-24T12:00:00Z"
}
```

The task payload stays intentionally small. The runner daemon loads the latest instruction definition when execution begins.

## Instruction Definitions

Instruction definitions live as files in the code repository. They are the source of truth for behavior and permissions.

Recommended layout:

```text
definitions/
  instructions/
    issue-comment-opinion.yaml
    issue-to-pr.yaml
    pr-review-comment.yaml
```

Each instruction definition includes:

- Stable `id`
- Human-readable `revision`
- Supported `source_kind`
- Execution `mode`: `observe` or `mutate`
- GitHub context collection rules
- Agent prompt template
- Permission set
- Allowed GitHub write actions
- Default execution settings such as timeout

Illustrative example:

```yaml
id: issue-to-pr
revision: 7
source_kind: issue
mode: mutate

context:
  include_issue_body: true
  include_issue_comments: true
  include_linked_prs: true

permissions:
  code_read: true
  code_write: true
  git_push: true
  pr_create: true
  pr_update: true
  comment_write: true

github_actions:
  - branch_push
  - pr_create
  - issue_comment

execution:
  agent: codex-cli
  timeout_sec: 3600
```

Important policy:

- Task payloads do not declare permissions directly
- The instruction definition decides the effective mode and permissions
- The runner may expose the instruction revision in result comments or PR content so the used instruction is visible to humans

## Execution Modes

Two execution modes are supported.

### Observe

Read-only analysis tasks.

Allowed behavior:

- Read repository contents
- Read issue or PR metadata
- Run analysis commands
- Post comments or checks when the instruction allows it

Forbidden behavior:

- Modify files
- Create commits
- Push branches

### Mutate

Code-changing tasks.

Allowed behavior:

- Create a task-specific workspace
- Check out the base branch
- Create a new branch
- Modify code
- Run tests
- Commit and push
- Create or update a pull request

Required policy:

- Always use an isolated workspace
- Always work on a task-created branch

## Queue Replacement Policy

The system should keep only the newest queued request for the same source object.

Replacement key:

- `repo owner`
- `repo name`
- `source kind`
- `source number`

Behavior when a new task is enqueued:

1. Find existing tasks with the same replacement key and status `queued`
2. Mark those tasks as `superseded`
3. Insert the new task as `queued`

Important exception:

- Already running tasks are not cancelled
- Only queued tasks are replaced

This means a source object can have:

- Older tasks already running
- At most one newest queued task waiting to run

## Queue and Task States

Minimal task states:

- `queued`
- `running`
- `succeeded`
- `failed`
- `superseded`

Optional internal state:

- `leasing`

The daemon must never execute a task marked `superseded`.

## Scheduling Rules

Global concurrency target:

- Up to 2 running tasks at once

Scheduling policy:

- `observe` tasks may run in parallel
- `mutate` tasks for the same repository may not run at the same time
- `observe` tasks may run while a `mutate` task for the same repository is running

Allowed examples:

- `repo A observe` + `repo A observe`
- `repo A mutate` + `repo A observe`
- `repo A mutate` + `repo B mutate`

Disallowed example:

- `repo A mutate` + `repo A mutate`

The stronger `mutate` restriction is intentional. Even when branches differ, repository-local clone and workspace growth should stay bounded per repository.

## Workspace Strategy

### Observe

May use:

- Shared checkout
- Read-only workspace
- Cached local repository copy

### Mutate

Must use:

- Dedicated task workspace
- Fresh branch created from the selected base branch

Recommended branch naming:

- `ai/issue-100`
- `ai/pr-52-followup`
- `ai/task-<task_id>`

The exact branch naming convention can be instruction-specific.

## Runtime Flow

1. GitHub Actions receives an issue or PR event
2. The workflow selects an `instruction_id`
3. The workflow calls the local enqueue CLI on the VM
4. The CLI supersedes older queued tasks for the same source and inserts the new task
5. The runner daemon polls the queue and picks an executable task
6. The runner loads the latest instruction definition
7. The runner derives the effective mode, permissions, timeout, and allowed GitHub actions
8. The runner acquires a GitHub token
9. The runner collects the required GitHub context
10. The runner executes the headless AI coding agent
11. The runner performs the instruction-allowed GitHub write actions
12. The runner stores short-lived local logs and marks the task complete

## GitHub Context Collection

Context collection depends on the instruction definition. Supported inputs include:

- Issue body
- Issue comments
- Pull request body
- Pull request comments
- Pull request diff
- Base and head refs
- Linked issue or PR metadata when needed

The instruction decides which context is required.

## GitHub Write-Back Behavior

GitHub should contain user-facing results, not raw system state.

Possible write-back actions include:

- Issue comment
- Pull request comment
- Branch push
- Pull request creation
- Pull request update
- Labels
- Status or checks

All GitHub writes must be explicitly allowed by the selected instruction.

Examples:

- `issue-comment-opinion` posts an issue comment
- `pr-review-comment` posts PR findings
- `issue-to-pr` pushes a branch and creates or updates a PR

When useful, result comments or PR bodies may include the instruction identity, for example `issue-to-pr r7`.

## Authentication and Authorization

Recommended model:

- Use a GitHub App
- Mint short-lived installation tokens when the daemon needs GitHub access

Policy enforcement:

- Runner checks repository allowlist before execution
- Instruction definitions control behavior and permissions
- GitHub writes are restricted to the instruction-approved action set

The VM should not depend on long-lived broad PATs for normal operation.

## Logging and Retention

System logs are stored locally on the VM.

Retention policy:

- Keep logs for 3 days
- Automatically delete expired records

Suggested stored fields:

- `task_id`
- `instruction_id`
- `repo`
- `source`
- `status`
- `created_at`
- `started_at`
- `finished_at`
- `error_summary`
- Recent execution output excerpt

GitHub should not be used for queue lifecycle noise such as `queued`, `running`, or raw stderr output.

## Failure Handling

Failure policy for v1:

- Mark task `failed`
- Preserve a short local error summary
- Do not retry automatically unless an explicit retry policy is added later

This keeps the first version predictable and easy to reason about.

## Testing Strategy

The implementation should cover at least these cases:

- Enqueue inserts a valid task
- Enqueue supersedes older queued tasks for the same source
- `superseded` tasks are never executed
- `observe` tasks can run in parallel
- Two `mutate` tasks for the same repository cannot run together
- `observe` can run while same-repo `mutate` is running
- Instruction loading determines mode and permissions correctly
- `observe` instructions cannot write code or push
- `mutate` instructions always create isolated workspaces
- GitHub write actions are rejected when not allowed by the instruction
- Logs expire after 3 days

## Open Implementation Decisions

These are intentionally left for the implementation plan, not the design:

- Exact local queue storage engine, such as SQLite
- Exact daemon polling interval
- Exact log file or table format
- Exact GitHub App token minting flow on the VM
- Exact agent wrapper command-line contract

## Recommended V1 Scope

Support these initial instructions:

1. `issue-comment-opinion`
2. `issue-to-pr`
3. `pr-review-comment`

This is enough to validate the full loop:

- issue or PR trigger
- local enqueue
- queue replacement
- parallel scheduling
- observe versus mutate policy
- GitHub comment or PR write-back

## Summary

The recommended v1 system is a single-VM assistant platform with:

- GitHub Actions for enqueue only
- A local queue and local daemon for execution
- Instruction-driven behavior and permissions
- Two execution modes: `observe` and `mutate`
- Up to 2 concurrent tasks
- Repository-level serialization for `mutate`
- Queue replacement by source object
- Short-lived local system logs
- GitHub used for user-visible outputs only
