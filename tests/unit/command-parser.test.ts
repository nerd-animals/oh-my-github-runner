import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseCommand } from "../../src/services/command-parser.js";

describe("parseCommand", () => {
  test("returns null for an empty body", () => {
    assert.equal(parseCommand(""), null);
  });

  test("returns null for non-command text", () => {
    assert.equal(parseCommand("just a comment"), null);
  });

  test("parses a bare /claude as observe with no extra context", () => {
    assert.deepEqual(parseCommand("/claude"), {
      agent: "claude",
      verb: null,
      additionalInstructions: "",
    });
  });

  test("parses /claude implement as implement with no extra context", () => {
    assert.deepEqual(parseCommand("/claude implement"), {
      agent: "claude",
      verb: "implement",
      additionalInstructions: "",
    });
  });

  test("collects rest of line as additional instructions for implement", () => {
    assert.deepEqual(
      parseCommand("/claude implement add a logging hook to the runner"),
      {
        agent: "claude",
        verb: "implement",
        additionalInstructions: "add a logging hook to the runner",
      },
    );
  });

  test("treats free text after /claude as additional context for observe", () => {
    assert.deepEqual(parseCommand("/claude please review my latest change"), {
      agent: "claude",
      verb: null,
      additionalInstructions: "please review my latest change",
    });
  });

  test("appends following lines as additional instructions", () => {
    const body = ["/claude implement", "use kebab-case for filenames", ""].join(
      "\n",
    );

    assert.deepEqual(parseCommand(body), {
      agent: "claude",
      verb: "implement",
      additionalInstructions: "use kebab-case for filenames",
    });
  });

  test("skips leading blockquote lines and code fences", () => {
    const body = [
      "> quoted preamble that mentions /codex",
      "```",
      "/codex implement noop",
      "```",
      "/claude implement actually do this",
    ].join("\n");

    assert.deepEqual(parseCommand(body), {
      agent: "claude",
      verb: "implement",
      additionalInstructions: "actually do this",
    });
  });

  test("ignores commands buried after non-command first line", () => {
    const body = ["hi there", "/claude implement"].join("\n");
    assert.equal(parseCommand(body), null);
  });

  test("preserves the agent token and exposes it for the dispatcher", () => {
    assert.deepEqual(parseCommand("/codex"), {
      agent: "codex",
      verb: null,
      additionalInstructions: "",
    });
  });

  test("matches the verb case-insensitively (capitalized)", () => {
    assert.deepEqual(parseCommand("/claude Implement"), {
      agent: "claude",
      verb: "implement",
      additionalInstructions: "",
    });
  });

  test("matches the verb case-insensitively with trailing instructions", () => {
    assert.deepEqual(parseCommand("/claude IMPLEMENT add tests"), {
      agent: "claude",
      verb: "implement",
      additionalInstructions: "add tests",
    });
  });

  test("matches the verb case-insensitively (mixed case)", () => {
    assert.deepEqual(parseCommand("/claude ImPlEmEnT"), {
      agent: "claude",
      verb: "implement",
      additionalInstructions: "",
    });
  });

  test("does not match a verb that only starts with a known verb", () => {
    assert.deepEqual(parseCommand("/claude implementation foo"), {
      agent: "claude",
      verb: null,
      additionalInstructions: "implementation foo",
    });
  });
});
