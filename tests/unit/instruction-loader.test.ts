import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { loadInstructionDefinition } from "../../src/infra/instructions/instruction-loader.js";

const definitionsDir = "definitions/instructions";

describe("loadInstructionDefinition", () => {
  test("loads issue-initial-review (observe, fires on issue.opened)", async () => {
    const instruction = await loadInstructionDefinition({
      definitionsDir,
      instructionId: "issue-initial-review",
    });

    assert.equal(instruction.id, "issue-initial-review");
    assert.equal(instruction.sourceKind, "issue");
    assert.equal(instruction.mode, "observe");
    assert.equal(instruction.permissions.codeWrite, false);
    assert.equal(instruction.permissions.commentWrite, true);
    assert.equal(instruction.context.includeIssueBody, true);
    assert.equal(instruction.context.includeIssueComments, false);
  });

  test("loads issue-comment-reply (renamed from issue-comment-opinion)", async () => {
    const instruction = await loadInstructionDefinition({
      definitionsDir,
      instructionId: "issue-comment-reply",
    });

    assert.equal(instruction.id, "issue-comment-reply");
    assert.equal(instruction.mode, "observe");
    assert.equal(instruction.context.includeIssueComments, true);
  });

  test("loads pr-review-comment", async () => {
    const instruction = await loadInstructionDefinition({
      definitionsDir,
      instructionId: "pr-review-comment",
    });

    assert.equal(instruction.id, "pr-review-comment");
    assert.equal(instruction.sourceKind, "pull_request");
    assert.equal(instruction.mode, "observe");
    assert.equal(instruction.context.includePrDiff, true);
  });

  test("loads issue-implement (renamed from issue-to-pr)", async () => {
    const instruction = await loadInstructionDefinition({
      definitionsDir,
      instructionId: "issue-implement",
    });

    assert.equal(instruction.id, "issue-implement");
    assert.equal(instruction.mode, "mutate");
    assert.equal(instruction.permissions.codeWrite, true);
    assert.equal(instruction.permissions.gitPush, true);
    assert.deepEqual(instruction.githubActions, [
      "branch_push",
      "pr_create",
      "issue_comment",
    ]);
  });

  test("loads pr-implement (push to existing PR head)", async () => {
    const instruction = await loadInstructionDefinition({
      definitionsDir,
      instructionId: "pr-implement",
    });

    assert.equal(instruction.id, "pr-implement");
    assert.equal(instruction.sourceKind, "pull_request");
    assert.equal(instruction.mode, "mutate");
    assert.equal(instruction.permissions.gitPush, true);
    assert.equal(instruction.permissions.prCreate, false);
  });

  test("execution block carries timeoutSec and no agent field", async () => {
    const instruction = await loadInstructionDefinition({
      definitionsDir,
      instructionId: "issue-implement",
    });

    assert.equal(instruction.execution.timeoutSec, 3600);
    assert.equal(
      Object.prototype.hasOwnProperty.call(instruction.execution, "agent"),
      false,
    );
  });
});
