# Strategy Development

A Strategy turns one instruction into one user-visible outcome.

This document is intentionally high-level. It should help agents decide what a Strategy is responsible for, without freezing implementation details that belong in code.

## Purpose

A Strategy decides:

- what context is needed
- what workspace permission is required
- which AI role or tool should handle the task
- what constraints the AI must follow
- how to interpret AI output
- what result the user should see
- when a multi-step flow should stop

A Strategy should not own runner infrastructure, queue state, tool process details, or GitHub adapter behavior.

## Boundary

Strategies use the Toolkit as their only execution surface.

Keep in the Strategy:

- task-specific judgment
- prompt composition
- AI role selection
- success, retry, fallback, and failure policy
- orchestration across multiple AI calls

Keep outside the Strategy:

- queue lifecycle
- workspace lifecycle details
- tool command execution
- GitHub API implementation
- rate-limit storage
- daemon scheduling

If a pattern is useful in one Strategy, keep it local. If it appears in multiple Strategies, consider a shared Strategy helper. Expand Toolkit only when Strategies need a new external capability, not just a new policy.

## Inputs

Strategies usually combine:

- the task instruction and source
- GitHub context
- repository `.omgr` notes
- shared prompts, personas, and modes
- user-provided instructions

Prefer pointing agents to stable source locations over copying code structure into documentation.

## Outputs

A Strategy should produce an observable result, such as:

- an issue comment
- a PR review comment
- a branch and PR
- a retryable failure
- a final failure
- a fallback response explaining why the task cannot be completed

Intermediate reasoning, transcripts, and tool chatter should be exposed only when they help the user act.

## AI Usage

AI tools are single-turn executors: input in, output out.

A Strategy can create a conversation-like workflow by carrying state between calls:

- store selected output from one AI call
- pass that context into the next AI call
- ask another AI call to judge or synthesize
- parse an explicit decision signal
- stop when the Strategy policy says the result is good enough

Do not model this as tool-to-tool communication. Model it as Strategy-led orchestration.

## Collaboration

Use multi-AI collaboration only when it has a clear purpose.

Before adding collaboration, decide:

- why one AI call is not enough
- what distinct role each participant has
- what context each participant receives
- who judges readiness
- what "ready" means
- what happens when the result is not ready
- what the user should see from the discussion

Every collaborative loop needs a hard bound. Quality judgment may come from AI, but cost, time, and stopping limits must come from code.

## Failure Policy

Treat failure policy as part of the user experience.

A Strategy should distinguish:

- technical failure: tool failure, rate limit, timeout, workspace error
- task failure: missing information, conflicting requirements, insufficient confidence, unsafe request

Different Strategies may choose different outcomes: retry, fallback comment, final failure, or partial publication.

## Testing

Test Strategy behavior at the Toolkit boundary.

Prefer assertions about observable policy:

- required context is requested
- the right permission level is used
- important prompt fragments are included
- tool access is constrained
- success produces the intended external effect
- failures and rate limits follow the Strategy policy
- loops stop under the documented condition

Avoid tests that depend on private helper shapes unless that shape is the policy itself.

## Where To Look

Use this document first, then inspect current code for exact contracts.

- Strategy and Toolkit contracts: `src/strategies/types.ts`
- Strategy registration: `src/strategies/index.ts`
- Existing Strategies: `src/strategies/`
- Shared Strategy helpers: `src/strategies/_shared/`
- Prompts and personas: `definitions/prompts/`
- Architecture notes: `.omgr/architecture.md`
- Testing notes: `.omgr/testing.md`
