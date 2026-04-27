import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildClaudeToolArgs } from "../../src/infra/agent/agent-tool-policies.js";

describe("buildClaudeToolArgs", () => {
  test("observe mode allows read/grep/gh and disallows file-mutating tools", () => {
    const args = buildClaudeToolArgs("observe");

    const allowedIdx = args.indexOf("--allowed-tools");
    const disallowedIdx = args.indexOf("--disallowed-tools");

    assert.ok(allowedIdx >= 0);
    assert.ok(disallowedIdx >= 0);

    const allowed = args[allowedIdx + 1] ?? "";
    const disallowed = args[disallowedIdx + 1] ?? "";

    assert.match(allowed, /Read/);
    assert.match(allowed, /Grep/);
    assert.match(allowed, /Bash\(gh:\*\)/);
    assert.match(allowed, /Bash\(git log:\*\)/);

    assert.match(disallowed, /\bEdit\b/);
    assert.match(disallowed, /\bWrite\b/);
    assert.match(disallowed, /Bash\(git push:\*\)/);
    assert.match(disallowed, /Bash\(git commit:\*\)/);
    assert.match(disallowed, /Bash\(git add:\*\)/);
  });

  test("mutate mode allows edits, gh, and full git (push enforcement is server-side)", () => {
    const args = buildClaudeToolArgs("mutate");

    const allowedIdx = args.indexOf("--allowed-tools");
    assert.ok(allowedIdx >= 0);

    const allowed = args[allowedIdx + 1] ?? "";

    assert.match(allowed, /\bEdit\b/);
    assert.match(allowed, /\bWrite\b/);
    assert.match(allowed, /Bash\(gh:\*\)/);
    assert.match(allowed, /Bash\(git:\*\)/);

    // No --disallowed-tools in mutate: pushes to main are blocked by the
    // GitHub branch protection ruleset, not by client-side tool filtering.
    assert.equal(args.indexOf("--disallowed-tools"), -1);
  });
});
