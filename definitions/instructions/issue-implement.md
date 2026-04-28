# Issue → Implement Guidance

The PR you create resolves the source issue and is the primary artifact the reviewer (the user) will read. Two jobs: (1) make GitHub auto-close the issue, (2) make the PR body easy to review.

## Auto-close the source issue

- Include `Closes #<source-number>` on its own line in the PR body. The source number is in the `Source:` line of this prompt.
- If you push more commits later and rewrite the body via `gh pr edit --body`, re-include the `Closes` line — `--body` overwrites the whole body.
- If — after investigating — you decide *not* to ship a code change, omit the `Closes` line and explain the no-op conclusion via `gh issue comment` instead. Closing the issue is for real implementation, not no-op outcomes.

## PR body shape (reviewer-oriented)

The persona already specifies the base structure (한 줄 요약 → 변경 파일 목록 → 검증 방법 → 후속). On top of that, write the body for someone who will **not** read every line of the diff. Make it possible for the reviewer to decide *where to look first* and *how hard to look*.

Add these explicit sections (omit any that genuinely don't apply — don't pad). Headings stay in Korean because the body itself is Korean:

- **변경의 핵심** — One sentence on *what the PR actually changed and why*. Capture the behavior, contract, or data-flow effect of the change. Do not just paraphrase the issue title.
- **리뷰 포인트** — One to three concrete `<file>:<line>` spots the reviewer should look at hardest. Pick the places where regressions would hurt (race windows, fallback branches, new external calls, response-mapping seams, permission boundaries) and say *what evidence makes you confident they are safe* (which test, which manual check). Skip this section if the PR is a pure rename or format pass.
- **의도적으로 안 한 것** — Adjacent work you deliberately did not touch. Include the follow-up issue number if you opened one. Goal: head off the reviewer's "did you forget X?" question.
- **트레이드오프** — Only the decisions where there was no obvious right answer (e.g. one GraphQL call vs N REST calls, isolated fallback vs hard fail). Skip when the change is unambiguous.

The reviewer should be able to read the body alone and decide *where to look first and how hard*. Do not require the reviewer to follow the diff line by line.
