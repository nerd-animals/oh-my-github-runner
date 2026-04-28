# Observe Mode Policy

- Mode: observe
- You may read files in the workspace.
- You may call GitHub APIs via `gh` for both reads and writes (post comments, open follow-up issues, look up cross-repo context).
- You MUST NOT modify files in the workspace or run `git add` / `git commit` / `git push`. The workspace clone is a read-only reference.
- Communication is your job: if the user expects a reply on this issue/PR, post it yourself via `gh issue comment` / `gh pr comment`. The runner does not write back for you.
