import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { GitHubSourceContext } from "../../src/domain/github.js";
import { PromptRenderer } from "../../src/infra/prompts/prompt-renderer.js";

const issueContext: GitHubSourceContext = {
  kind: "issue",
  title: "T",
  body: "issue body text",
  comments: [{ author: "alice", body: "first comment" }],
  linkedRefs: { closes: [], bodyMentions: [] },
};

function makeRenderer(fragments: Record<string, string>): PromptRenderer {
  return new PromptRenderer({
    fragments: new Map(Object.entries(fragments)),
  });
}

describe("PromptRenderer", () => {
  test("renders literal/user/file/context fragments in order, joined by blank lines", async () => {
    const renderer = makeRenderer({
      "_common/work-rules": "RULES",
      "personas/architect": "ARCH",
    });

    const out = await renderer.render(
      [
        { kind: "file", path: "_common/work-rules" },
        { kind: "file", path: "personas/architect" },
        { kind: "literal", text: "HEADER" },
        { kind: "context", key: "issue-body" },
        { kind: "user", text: "do X" },
      ],
      issueContext,
      "/unused-when-no-omgr-doc",
    );

    assert.equal(
      out,
      [
        "RULES",
        "ARCH",
        "HEADER",
        "Body:\nissue body text",
        "User additional instructions:\ndo X",
      ].join("\n\n"),
    );
  });

  test("file fragment with unknown path throws", async () => {
    const renderer = makeRenderer({});

    await assert.rejects(
      () =>
        renderer.render(
          [{ kind: "file", path: "missing/key" }],
          issueContext,
          "/tmp",
        ),
      /Unknown prompt fragment: 'missing\/key'/,
    );
  });

  test("user fragment with empty text is filtered out", async () => {
    const renderer = makeRenderer({});

    const out = await renderer.render(
      [
        { kind: "literal", text: "A" },
        { kind: "user", text: "" },
        { kind: "literal", text: "B" },
      ],
      issueContext,
      "/tmp",
    );

    assert.equal(out, "A\n\nB");
  });
});

describe("PromptRenderer omgr-doc", () => {
  test("reads file content from workspace path", async () => {
    const ws = await mkdtemp(join(tmpdir(), "renderer-"));
    try {
      await mkdir(join(ws, ".omgr"), { recursive: true });
      await writeFile(
        join(ws, ".omgr", "architecture.md"),
        "# Architecture\n\nLayered.\n",
        "utf8",
      );

      const renderer = makeRenderer({});
      const out = await renderer.render(
        [
          { kind: "literal", text: "HEAD" },
          { kind: "omgr-doc", path: ".omgr/architecture.md" },
          { kind: "literal", text: "TAIL" },
        ],
        issueContext,
        ws,
      );

      assert.equal(out, "HEAD\n\n# Architecture\n\nLayered.\n\nTAIL");
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  test("missing file is silently skipped (filtered out, no error)", async () => {
    const ws = await mkdtemp(join(tmpdir(), "renderer-"));
    try {
      const renderer = makeRenderer({});
      const out = await renderer.render(
        [
          { kind: "literal", text: "HEAD" },
          { kind: "omgr-doc", path: ".omgr/architecture.md" },
          { kind: "literal", text: "TAIL" },
        ],
        issueContext,
        ws,
      );

      assert.equal(out, "HEAD\n\nTAIL");
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  test("non-ENOENT read error propagates", async () => {
    const ws = await mkdtemp(join(tmpdir(), "renderer-"));
    try {
      // A directory at the doc path triggers EISDIR on read.
      await mkdir(join(ws, ".omgr"), { recursive: true });
      await mkdir(join(ws, ".omgr", "architecture.md"), { recursive: true });

      const renderer = makeRenderer({});
      await assert.rejects(
        () =>
          renderer.render(
            [{ kind: "omgr-doc", path: ".omgr/architecture.md" }],
            issueContext,
            ws,
          ),
        // Don't pin to a specific code; fs may surface EISDIR or similar.
        /EISDIR|illegal operation/i,
      );
    } finally {
      await chmod(ws, 0o755).catch(() => {});
      await rm(ws, { recursive: true, force: true });
    }
  });
});
