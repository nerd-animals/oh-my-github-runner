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

  test("mutate mode allows edits and gh/git but disallows git push", () => {
    const args = buildClaudeToolArgs("mutate");

    const allowedIdx = args.indexOf("--allowed-tools");
    const disallowedIdx = args.indexOf("--disallowed-tools");

    assert.ok(allowedIdx >= 0);
    assert.ok(disallowedIdx >= 0);

    const allowed = args[allowedIdx + 1] ?? "";
    const disallowed = args[disallowedIdx + 1] ?? "";

    assert.match(allowed, /\bEdit\b/);
    assert.match(allowed, /\bWrite\b/);
    assert.match(allowed, /Bash\(gh:\*\)/);
    assert.match(allowed, /Bash\(git:\*\)/);

    assert.match(disallowed, /Bash\(git push:\*\)/);
  });
});
