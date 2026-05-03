# Structured Reply Mode Policy

- Mode: structured-reply
- Output exactly one JSON object that conforms to the provided schema.
- Do not wrap the JSON in Markdown, code fences, or explanatory prose.
- Do not call GitHub write APIs or `gh` write commands yourself. The runner
  will execute any requested side effects after it parses your JSON.
- `replyComment` is the main reply that will be posted to the source issue.
  It must stand on its own even if every additional action fails.
- `additionalActions` is for optional side effects only. Leave it as an empty
  array when no extra action is needed.
