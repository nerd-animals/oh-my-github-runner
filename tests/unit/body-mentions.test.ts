import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseBodyMentions } from "../../src/domain/rules/body-mentions.js";

describe("parseBodyMentions", () => {
  test("returns an empty array for an empty body", () => {
    assert.deepEqual(parseBodyMentions("", 1), []);
  });

  test("extracts plain '#N' mentions", () => {
    const body = "Refs #36 and #47 — see also #100.";
    assert.deepEqual(parseBodyMentions(body, 41), [36, 47, 100]);
  });

  test("ignores '#N' inside fenced code blocks", () => {
    const body = "Body refs #36.\n```\nignored #99 inside fence\n```\nMore #47.";
    assert.deepEqual(parseBodyMentions(body, 41), [36, 47]);
  });

  test("ignores '#N' inside inline code", () => {
    const body = "Body refs #36 and `inline #99` and #47.";
    assert.deepEqual(parseBodyMentions(body, 41), [36, 47]);
  });

  test("does not match '#N' when preceded by word characters (anchor noise)", () => {
    const body = "page#36 abc#47 ascii\nplain ref #50.";
    assert.deepEqual(parseBodyMentions(body, 41), [50]);
  });

  test("removes self-reference and duplicates, preserves first-occurrence order", () => {
    const body = "see #41 (self) and #36, again #36, then #47.";
    assert.deepEqual(parseBodyMentions(body, 41), [36, 47]);
  });

  test("caps results at 30 mentions", () => {
    const numbers = Array.from({ length: 40 }, (_, i) => i + 100);
    const body = numbers.map((n) => `#${n}`).join(" ");
    const result = parseBodyMentions(body, 1);
    assert.equal(result.length, 30);
    assert.deepEqual(result.slice(0, 5), numbers.slice(0, 5));
  });
});
