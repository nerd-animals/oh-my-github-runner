import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createClaudeProjectsCleaner,
  encodeProjectsDirName,
  type ClaudeProjectsCleanerFs,
} from "../../src/infra/agent/claude-projects-cleaner.js";

interface FsCall {
  op: "rm" | "stat";
  target: string;
}

function makeFs(options: {
  statThrows?: boolean;
}): { fs: ClaudeProjectsCleanerFs; calls: FsCall[] } {
  const calls: FsCall[] = [];
  const fs: ClaudeProjectsCleanerFs = {
    rm: async (target, _opts) => {
      calls.push({ op: "rm", target });
    },
    stat: async (target) => {
      calls.push({ op: "stat", target });
      if (options.statThrows === true) {
        throw new Error("ENOENT");
      }
      return {};
    },
  };
  return { fs, calls };
}

describe("encodeProjectsDirName", () => {
  test("matches the observed claude CLI encoding for runner workspace paths", () => {
    assert.equal(
      encodeProjectsDirName(
        "/home/ubuntu/runner-deploy/var/workspaces/task_1777391732491_qc7ixeyy",
      ),
      "-home-ubuntu-runner-deploy-var-workspaces-task-1777391732491-qc7ixeyy",
    );
    assert.equal(
      encodeProjectsDirName(
        "/home/ubuntu/oh-my-github-runner/var/workspaces/task_1777303496321_tm9oh6zv",
      ),
      "-home-ubuntu-oh-my-github-runner-var-workspaces-task-1777303496321-tm9oh6zv",
    );
  });

  test("replaces every non-alphanumeric character including dots and underscores", () => {
    assert.equal(
      encodeProjectsDirName("/a.b_c/d-e/f"),
      "-a-b-c-d-e-f",
    );
  });
});

describe("createClaudeProjectsCleaner", () => {
  const baseOptions = {
    workspacesDir: "/home/ubuntu/runner-deploy/var/workspaces",
    claudeHome: "/home/ubuntu/.claude",
  };

  test("removes the encoded projects dir for a workspace inside workspacesDir", async () => {
    const { fs, calls } = makeFs({});
    const cleanup = createClaudeProjectsCleaner({ ...baseOptions, fs });

    await cleanup(
      "/home/ubuntu/runner-deploy/var/workspaces/task_1777391732491_qc7ixeyy",
    );

    assert.deepEqual(calls, [
      {
        op: "stat",
        target:
          "/home/ubuntu/.claude/projects/-home-ubuntu-runner-deploy-var-workspaces-task-1777391732491-qc7ixeyy",
      },
      {
        op: "rm",
        target:
          "/home/ubuntu/.claude/projects/-home-ubuntu-runner-deploy-var-workspaces-task-1777391732491-qc7ixeyy",
      },
    ]);
  });

  test("is a no-op (no rm) when the encoded dir does not exist", async () => {
    const { fs, calls } = makeFs({ statThrows: true });
    const cleanup = createClaudeProjectsCleaner({ ...baseOptions, fs });

    await cleanup(
      "/home/ubuntu/runner-deploy/var/workspaces/task_does_not_exist",
    );

    assert.equal(calls.filter((c) => c.op === "rm").length, 0);
    assert.equal(calls.filter((c) => c.op === "stat").length, 1);
  });

  test("refuses paths outside workspacesDir (no stat, no rm)", async () => {
    const { fs, calls } = makeFs({});
    const cleanup = createClaudeProjectsCleaner({ ...baseOptions, fs });

    await cleanup("/home/ubuntu");
    await cleanup("/etc/passwd");
    await cleanup("/home/ubuntu/runner-deploy");
    await cleanup("/home/ubuntu/oh-my-github-runner/var/workspaces/task_1");

    assert.deepEqual(calls, []);
  });

  test("refuses the workspacesDir itself", async () => {
    const { fs, calls } = makeFs({});
    const cleanup = createClaudeProjectsCleaner({ ...baseOptions, fs });

    await cleanup("/home/ubuntu/runner-deploy/var/workspaces");
    await cleanup("/home/ubuntu/runner-deploy/var/workspaces/");

    assert.deepEqual(calls, []);
  });

  test("refuses paths that look like a sibling but are outside the workspaces prefix", async () => {
    const { fs, calls } = makeFs({});
    const cleanup = createClaudeProjectsCleaner({ ...baseOptions, fs });

    await cleanup(
      "/home/ubuntu/runner-deploy/var/workspaces-evil/task_1",
    );

    assert.deepEqual(calls, []);
  });

  test("normalises traversal segments before guarding", async () => {
    const { fs, calls } = makeFs({});
    const cleanup = createClaudeProjectsCleaner({ ...baseOptions, fs });

    await cleanup(
      "/home/ubuntu/runner-deploy/var/workspaces/task_1/../../../../etc",
    );

    assert.deepEqual(calls, []);
  });

  test("respects a custom claudeHome (used for test isolation)", async () => {
    const { fs, calls } = makeFs({});
    const cleanup = createClaudeProjectsCleaner({
      workspacesDir: "/srv/workspaces",
      claudeHome: "/var/cache/claude",
      fs,
    });

    await cleanup("/srv/workspaces/task_abc");

    assert.deepEqual(calls, [
      { op: "stat", target: "/var/cache/claude/projects/-srv-workspaces-task-abc" },
      { op: "rm", target: "/var/cache/claude/projects/-srv-workspaces-task-abc" },
    ]);
  });
});
