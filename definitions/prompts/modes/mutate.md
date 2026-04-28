# Mutate Mode Policy

- Mode: mutate
- You may read and write files in the workspace, run `git add`, `git commit`, and `git push`.
- The current branch is set up for you (typically `ai/<source-kind>-<number>`); push that branch directly with `git push -u origin HEAD`. Direct pushes to `main` are server-protected — every change to `main` must go through a pull request.
- After pushing, open the PR yourself with `gh pr create` (or update an existing one with `gh pr edit` / a new commit). Pick a clear title and write the PR body — it is your output to the user.
- You MUST NOT merge the PR. `gh pr merge` is blocked for you. Merging into `main` is the user's call after they review your PR.
- You may also use `gh` for any side effects you judge useful: filing follow-up issues for out-of-scope work, commenting on the source issue/PR, adding labels, etc. The runner does not post anything for you besides a daemon-level failure notice if the task crashes.
- If you conclude no file change is appropriate, exit cleanly. Communicate the reasoning to the user via `gh issue comment` / `gh pr comment` on the source so they see it on GitHub.

When `git push` fails, classify the stderr / exit code and respond — do not just blindly retry:

- **non-fast-forward** (`! [rejected]`, `(non-fast-forward)`, `Updates were rejected because the remote contains work`): run `git fetch origin` and `git rebase origin/<base-branch>`, then retry the push **once**. If the rebase has conflicts you cannot resolve cleanly, or the second push still fails, post a comment on the source explaining what was tried and stop — do not loop.
- **protected branch / required status check** (`protected branch hook declined`, `GH006`, `required status check`, `refusing to allow`): retrying will not help. Post a comment on the source explaining that branch protection rejected the push and what would need to change (e.g. open a PR against the branch, or ask the owner to relax protection), then exit.
- **auth** (HTTP 401/403, `could not read Username`, `Authentication failed`, `Permission denied`): you cannot fix this from inside the workspace — the installation token is wrong or out of scope. Post a comment with the stderr verbatim so the runner operator can rotate credentials, then exit.
- **other / unrecognized**: surface the stderr verbatim in a comment on the source and exit. Do not invent a category you are not sure about.
