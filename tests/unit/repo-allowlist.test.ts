import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { RepoAllowlist } from "../../src/services/repo-allowlist.js";

describe("RepoAllowlist", () => {
  test("isAllowed returns true for an entry that matches owner/name", () => {
    const allowlist = new RepoAllowlist(["octo/repo", "other/proj"]);

    assert.equal(allowlist.isAllowed({ owner: "octo", name: "repo" }), true);
  });

  test("isAllowed returns false for a repo not on the list", () => {
    const allowlist = new RepoAllowlist(["octo/repo"]);

    assert.equal(allowlist.isAllowed({ owner: "rogue", name: "repo" }), false);
  });

  test("matches case-insensitively", () => {
    const allowlist = new RepoAllowlist(["Octo/Repo"]);

    assert.equal(allowlist.isAllowed({ owner: "octo", name: "repo" }), true);
    assert.equal(allowlist.isAllowed({ owner: "OCTO", name: "REPO" }), true);
  });

  test("isEmpty returns true for the empty list", () => {
    assert.equal(new RepoAllowlist([]).isEmpty(), true);
    assert.equal(new RepoAllowlist(["octo/repo"]).isEmpty(), false);
  });

  test("fromEnv parses comma-separated entries and trims whitespace", () => {
    const allowlist = RepoAllowlist.fromEnv("  octo/repo , other/proj ");

    assert.equal(allowlist.isAllowed({ owner: "octo", name: "repo" }), true);
    assert.equal(allowlist.isAllowed({ owner: "other", name: "proj" }), true);
  });

  test("fromEnv with undefined or empty string yields an empty allowlist", () => {
    assert.equal(RepoAllowlist.fromEnv(undefined).isEmpty(), true);
    assert.equal(RepoAllowlist.fromEnv("").isEmpty(), true);
  });
});
