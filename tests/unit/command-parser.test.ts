import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseCommand } from "../../src/domain/rules/command-parser.js";

describe("parseCommand", () => {
  test("returns null for an empty body", () => {
    assert.equal(parseCommand(""), null);
  });

  test("returns null for non-command text", () => {
    assert.equal(parseCommand("just a comment"), null);
  });

  test("parses a bare /omgr as observe with no extra context", () => {
    assert.deepEqual(parseCommand("/omgr"), {
      verb: null,
      additionalInstructions: "",
    });
  });

  test("parses /omgr implement as implement with no extra context", () => {
    assert.deepEqual(parseCommand("/omgr implement"), {
      verb: "implement",
      additionalInstructions: "",
    });
  });

  test("collects rest of line as additional instructions for implement", () => {
    assert.deepEqual(
      parseCommand("/omgr implement add a logging hook to the runner"),
      {
        verb: "implement",
        additionalInstructions: "add a logging hook to the runner",
      },
    );
  });

  test("treats free text after /omgr as additional context for observe", () => {
    assert.deepEqual(parseCommand("/omgr please review my latest change"), {
      verb: null,
      additionalInstructions: "please review my latest change",
    });
  });

  test("appends following lines as additional instructions", () => {
    const body = ["/omgr implement", "use kebab-case for filenames", ""].join(
      "\n",
    );

    assert.deepEqual(parseCommand(body), {
      verb: "implement",
      additionalInstructions: "use kebab-case for filenames",
    });
  });

  test("skips leading blockquote lines and code fences", () => {
    const body = [
      "> quoted preamble that mentions /omgr",
      "```",
      "/omgr implement noop",
      "```",
      "/omgr implement actually do this",
    ].join("\n");

    assert.deepEqual(parseCommand(body), {
      verb: "implement",
      additionalInstructions: "actually do this",
    });
  });

  test("ignores commands buried after non-command first line", () => {
    const body = ["hi there", "/omgr implement"].join("\n");
    assert.equal(parseCommand(body), null);
  });

  test("returns null for any trigger keyword other than /omgr", () => {
    assert.equal(parseCommand("/codex"), null);
    assert.equal(parseCommand("/claude implement"), null);
    assert.equal(parseCommand("/runner"), null);
  });

  test("matches the trigger keyword case-insensitively", () => {
    assert.deepEqual(parseCommand("/OMGR implement"), {
      verb: "implement",
      additionalInstructions: "",
    });
  });

  test("matches the verb case-insensitively (capitalized)", () => {
    assert.deepEqual(parseCommand("/omgr Implement"), {
      verb: "implement",
      additionalInstructions: "",
    });
  });

  test("matches the verb case-insensitively with trailing instructions", () => {
    assert.deepEqual(parseCommand("/omgr IMPLEMENT add tests"), {
      verb: "implement",
      additionalInstructions: "add tests",
    });
  });

  test("matches the verb case-insensitively (mixed case)", () => {
    assert.deepEqual(parseCommand("/omgr ImPlEmEnT"), {
      verb: "implement",
      additionalInstructions: "",
    });
  });

  test("does not match a verb that only starts with a known verb", () => {
    assert.deepEqual(parseCommand("/omgr implementation foo"), {
      verb: null,
      additionalInstructions: "implementation foo",
    });
  });
});
