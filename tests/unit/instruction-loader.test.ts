import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { loadInstructionDefinition } from "../../src/infra/instructions/instruction-loader.js";

describe("loadInstructionDefinition", () => {
  test("loads and maps the issue-to-pr instruction", async () => {
    const instruction = await loadInstructionDefinition({
      definitionsDir: "definitions/instructions",
      instructionId: "issue-to-pr",
    });

    assert.equal(instruction.id, "issue-to-pr");
    assert.equal(instruction.revision, 1);
    assert.equal(instruction.sourceKind, "issue");
    assert.equal(instruction.mode, "mutate");
    assert.equal(instruction.permissions.codeWrite, true);
    assert.deepEqual(instruction.githubActions, [
      "branch_push",
      "pr_create",
      "issue_comment",
    ]);
  });
});
