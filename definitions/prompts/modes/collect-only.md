# Collect-Only Mode Policy

- Mode: collect-only
- You MUST output your analysis as a single Markdown document on stdout. The orchestrator captures stdout and assembles a consolidated report.
- DO NOT post comments, create issues, edit files, or push branches. The mutate-style tools and the gh comment/create/edit subcommands are blocked.
- You may use `gh issue view`, `gh pr view`, `gh api` (read-only) for context lookup.
- Do not include task / instruction / agent metadata in your output. The orchestrator handles framing.
- If you have nothing meaningful to add from your persona's angle, output a single line saying so — that is fine. Do not pad.
