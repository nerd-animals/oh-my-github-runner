import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "ops",
  "scripts",
  "deploy.sh",
);

interface FakeBinOptions {
  headSha: string;
  remoteSha: string;
}

async function setupRepoRoot(opts: {
  withRunningTask: boolean;
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "deploy-script-"));
  await mkdir(join(root, "var", "queue", "running"), { recursive: true });
  if (opts.withRunningTask) {
    await writeFile(
      join(root, "var", "queue", "running", "task_test.json"),
      "{}",
      "utf8",
    );
  }
  // The deploy script asserts dist/src/index.js exists after compile; pre-create
  // it because the fake `npm` is a no-op.
  await mkdir(join(root, "dist", "src"), { recursive: true });
  await writeFile(join(root, "dist", "src", "index.js"), "// stub", "utf8");
  return root;
}

async function setupFakeBin(opts: FakeBinOptions): Promise<{
  binDir: string;
  callLog: string;
}> {
  const binDir = await mkdtemp(join(tmpdir(), "deploy-script-bin-"));
  const callLog = join(binDir, "calls.log");
  await writeFile(callLog, "", "utf8");

  const writeFake = async (name: string, body: string) => {
    const path = join(binDir, name);
    await writeFile(path, `#!/bin/bash\n${body}\n`, "utf8");
    await chmod(path, 0o755);
  };

  await writeFake(
    "git",
    `echo "git $*" >> "${callLog}"
case "$1" in
  fetch) exit 0 ;;
  rev-parse)
    case "$2" in
      HEAD) echo "${opts.headSha}" ;;
      origin/main) echo "${opts.remoteSha}" ;;
      *) exit 1 ;;
    esac
    ;;
  reset) exit 0 ;;
  *) exit 0 ;;
esac`,
  );

  await writeFake("npm", `echo "npm $*" >> "${callLog}"; exit 0`);
  await writeFake("sudo", `echo "sudo $*" >> "${callLog}"; exit 0`);

  return { binDir, callLog };
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runDeploy(
  env: Record<string, string>,
  binDir: string,
): Promise<RunResult> {
  return new Promise((resolveResult) => {
    const child = spawn("bash", [SCRIPT], {
      env: {
        ...process.env,
        ...env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      resolveResult({ code: code ?? -1, stdout, stderr });
    });
  });
}

describe("ops/scripts/deploy.sh", () => {
  test("fails fast when running tasks exceed RUNNER_DEPLOY_MAX_WAIT_SEC", async () => {
    const root = await setupRepoRoot({ withRunningTask: true });
    const { binDir, callLog } = await setupFakeBin({
      headSha: "aaa",
      remoteSha: "bbb",
    });

    try {
      const result = await runDeploy(
        {
          REPO_ROOT: root,
          RUNNER_DEPLOY_POLL_SEC: "1",
          RUNNER_DEPLOY_MAX_WAIT_SEC: "1",
        },
        binDir,
      );

      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /Drain timeout after \d+s; 1 task\(s\)/);

      const calls = await readFile(callLog, "utf8");
      // git fetch + rev-parse should have run, but reset/build/restart must NOT.
      assert.match(calls, /git fetch/);
      assert.doesNotMatch(calls, /git reset/);
      assert.doesNotMatch(calls, /npm ci/);
      assert.doesNotMatch(calls, /sudo /);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(binDir, { recursive: true, force: true });
    }
  });

  test("proceeds with reset/build/restart when no tasks are running", async () => {
    const root = await setupRepoRoot({ withRunningTask: false });
    const { binDir, callLog } = await setupFakeBin({
      headSha: "aaa",
      remoteSha: "bbb",
    });

    try {
      const result = await runDeploy(
        {
          REPO_ROOT: root,
          SERVICE: "fake.service",
          RUNNER_DEPLOY_POLL_SEC: "1",
          RUNNER_DEPLOY_MAX_WAIT_SEC: "5",
        },
        binDir,
      );

      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      const calls = await readFile(callLog, "utf8");
      assert.match(calls, /git reset --hard bbb/);
      assert.match(calls, /npm ci/);
      assert.match(calls, /npm run compile/);
      assert.match(calls, /sudo \/bin\/systemctl restart fake\.service/);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(binDir, { recursive: true, force: true });
    }
  });

  test("no-ops when HEAD already matches origin/main", async () => {
    const root = await setupRepoRoot({ withRunningTask: true });
    const { binDir, callLog } = await setupFakeBin({
      headSha: "same",
      remoteSha: "same",
    });

    try {
      const result = await runDeploy(
        {
          REPO_ROOT: root,
          RUNNER_DEPLOY_POLL_SEC: "1",
          RUNNER_DEPLOY_MAX_WAIT_SEC: "1",
        },
        binDir,
      );

      assert.equal(result.code, 0);
      assert.match(result.stdout, /Already at same/);

      const calls = await readFile(callLog, "utf8");
      assert.doesNotMatch(calls, /git reset/);
      assert.doesNotMatch(calls, /npm ci/);
      assert.doesNotMatch(calls, /sudo /);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(binDir, { recursive: true, force: true });
    }
  });
});
