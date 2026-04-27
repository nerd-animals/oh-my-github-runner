import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { GitWorkspaceManager } from "../../src/infra/workspaces/git-workspace-manager.js";
import type { ProcessRunner } from "../../src/domain/ports/process-runner.js";

interface RecordedCall {
  args: string[];
}

function makeRunner(behaviour: {
  exitCode?: number;
  stderr?: string;
  stdout?: string;
}): { runner: ProcessRunner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];

  const runner: ProcessRunner = {
    run: async (input) => {
      calls.push({ args: [...(input.args ?? [])] });
      return {
        exitCode: behaviour.exitCode ?? 0,
        stdout: behaviour.stdout ?? "",
        stderr: behaviour.stderr ?? "",
      };
    },
  };

  return { runner, calls };
}

describe("GitWorkspaceManager.pushBranch", () => {
  test("invokes git push without auth when no token is provided", async () => {
    const { runner, calls } = makeRunner({});
    const manager = new GitWorkspaceManager({
      reposDir: "/tmp/repos",
      workspacesDir: "/tmp/workspaces",
      processRunner: runner,
    });

    await manager.pushBranch({
      workspacePath: "/tmp/workspaces/task_1",
      branchName: "feature/x",
    });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.args, [
      "-C",
      "/tmp/workspaces/task_1",
      "push",
      "-u",
      "origin",
      "feature/x",
    ]);
  });

  test("injects an extraheader -c flag when an installation token is supplied", async () => {
    const { runner, calls } = makeRunner({});
    const manager = new GitWorkspaceManager({
      reposDir: "/tmp/repos",
      workspacesDir: "/tmp/workspaces",
      processRunner: runner,
    });

    await manager.pushBranch(
      {
        workspacePath: "/tmp/workspaces/task_1",
        branchName: "feature/x",
      },
      { installationToken: "ghs_token" },
    );

    const args = calls[0]?.args ?? [];
    const flagIndex = args.indexOf("-c");
    assert.notEqual(flagIndex, -1);

    const flagValue = args[flagIndex + 1] ?? "";
    assert.match(
      flagValue,
      /^http\.https:\/\/github\.com\/\.extraheader=AUTHORIZATION: Basic [A-Za-z0-9+/=]+$/,
    );

    const expectedB64 = Buffer.from("x-access-token:ghs_token").toString("base64");
    assert.ok(flagValue.endsWith(expectedB64));

    assert.deepEqual(args.slice(-4), ["push", "-u", "origin", "feature/x"]);
  });

  test("masks tokens from error messages on push failure", async () => {
    const { runner } = makeRunner({
      exitCode: 1,
      stderr: "fatal: AUTHORIZATION: Basic eW91Y2FudHNlZW1lCg== rejected",
    });
    const manager = new GitWorkspaceManager({
      reposDir: "/tmp/repos",
      workspacesDir: "/tmp/workspaces",
      processRunner: runner,
    });

    await assert.rejects(
      manager.pushBranch(
        {
          workspacePath: "/tmp/workspaces/task_1",
          branchName: "feature/x",
        },
        { installationToken: "ghs_token" },
      ),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /AUTHORIZATION: Basic \*\*\*/);
        assert.doesNotMatch(error.message, /eW91Y2FudHNlZW1lCg==/);
        return true;
      },
    );
  });
});
