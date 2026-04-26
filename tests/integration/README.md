# Integration tests

Each `*.test.ts` here exercises the runner across multiple layers (HTTP
contracts, file queue, instruction loader, dispatcher, enqueue service)
without touching real GitHub. They run alongside the unit suite via
`npm test`.

## Manual end-to-end smoke (against real GitHub)

`issue-opened-flow.test.ts` covers the synthetic webhook path. To verify
the full live wiring against a real repository, follow the steps in
`docs/deployment.md` to install the runner, then:

1. Create a fresh issue in a repository that is on the GitHub App's
   installation list and in `ALLOWED_REPOS`.
2. Watch `journalctl -u oh-my-github-runner.service -f` and the issue
   thread on github.com.
3. Within ~5 seconds the daemon should:
   - Receive the `issues.opened` webhook on
     `https://oh-my-github-runner.darakbox.com/webhook`
   - Enqueue an `issue-initial-review` task
   - Run the `claude` agent in a fresh workspace
   - Post the agent's stdout as an issue comment ending with
     `_Instruction: issue-initial-review r1_`

If anything fails, inspect:

- `var/queue/tasks.json` for queued/running task state
- `var/queue/state.json` for any active rate-limit pauses
- `var/logs/<task-id>.log` for the per-task log
- `journalctl -u cloudflared.service` for tunnel issues
