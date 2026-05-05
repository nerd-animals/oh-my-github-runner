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
  // Sequence of `systemctl is-active` outputs. The stub prints one entry
  // per call, looping on the last entry once the list is exhausted.
  // Defaults to ["active"] which produces the happy path.
  systemctlIsActiveSequence?: readonly string[];
  // Optional `npm` exit-code override keyed by the first positional argument
  // (`ci` or `run`). Lets tests simulate `npm ci` or `npm run compile`
  // failing without touching the rest of the fake bin layout. Defaults to 0.
  npmExitCodes?: { ci?: number; runCompile?: number };
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

  const npmCiExit = opts.npmExitCodes?.ci ?? 0;
  const npmRunCompileExit = opts.npmExitCodes?.runCompile ?? 0;
  await writeFake(
    "npm",
    `echo "npm $*" >> "${callLog}"
if [ "$1" = "ci" ]; then exit ${npmCiExit}; fi
if [ "$1" = "run" ] && [ "$2" = "compile" ]; then exit ${npmRunCompileExit}; fi
exit 0`,
  );
  await writeFake("sudo", `echo "sudo $*" >> "${callLog}"; exit 0`);

  // The deploy script's post-restart verify loop calls `systemctl is-active`
  // (no sudo) and falls back to `journalctl -u <unit>` on failure. Stubs
  // intercept both so the unit test never touches the real systemd.
  const sequence = opts.systemctlIsActiveSequence ?? ["active"];
  const stateFile = join(binDir, "is-active.idx");
  await writeFile(stateFile, "0", "utf8");
  const sequenceLiteral = sequence.map((s) => `"${s}"`).join(" ");
  await writeFake(
    "systemctl",
    `echo "systemctl $*" >> "${callLog}"
if [ "$1" = "is-active" ]; then
  states=(${sequenceLiteral})
  idx=$(cat "${stateFile}")
  last=$(( \${#states[@]} - 1 ))
  if [ "$idx" -gt "$last" ]; then idx=$last; fi
  echo "\${states[$idx]}"
  next=$(( idx + 1 ))
  echo "$next" > "${stateFile}"
  [ "\${states[$idx]}" = "active" ] && exit 0 || exit 3
fi
exit 0`,
  );
  await writeFake(
    "journalctl",
    `echo "journalctl $*" >> "${callLog}"
echo "(stub journal output)"
exit 0`,
  );

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

  test("orders stop -> reset -> npm ci -> compile -> start when no tasks are running", async () => {
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
          RUNNER_DEPLOY_VERIFY_INTERVAL_SEC: "0.05",
          RUNNER_DEPLOY_VERIFY_TIMEOUT_COUNT: "10",
          RUNNER_DEPLOY_VERIFY_STABLE_COUNT: "2",
        },
        binDir,
      );

      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      const calls = await readFile(callLog, "utf8")
        .then((raw) => raw.split("\n").filter((line) => line.length > 0));

      // The race fix is the order itself: daemon must be stopped before
      // node_modules/dist are mutated, and only restarted afterwards.
      const idx = (needle: RegExp) =>
        calls.findIndex((line) => needle.test(line));
      const stopIdx = idx(/^sudo \/bin\/systemctl stop fake\.service$/);
      const resetIdx = idx(/^git reset --hard bbb$/);
      const ciIdx = idx(/^npm ci/);
      const compileIdx = idx(/^npm run compile/);
      const startIdx = idx(/^sudo \/bin\/systemctl start fake\.service$/);

      assert.ok(stopIdx >= 0, `stop missing in ${calls.join(" | ")}`);
      assert.ok(resetIdx > stopIdx, `reset must follow stop`);
      assert.ok(ciIdx > resetIdx, `npm ci must follow reset`);
      assert.ok(compileIdx > ciIdx, `compile must follow npm ci`);
      assert.ok(startIdx > compileIdx, `start must follow compile`);

      // restart is no longer in the path; assert it is gone so a regression
      // back to live `restart` over a mutating tree is caught here.
      assert.ok(
        !calls.some((line) => /systemctl restart/.test(line)),
        "deploy must not call systemctl restart anymore",
      );
      assert.match(result.stdout, /Restarted fake\.service/);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(binDir, { recursive: true, force: true });
    }
  });

  test("waits for running task drain before stopping the service", async () => {
    const root = await setupRepoRoot({ withRunningTask: true });
    const { binDir, callLog } = await setupFakeBin({
      headSha: "aaa",
      remoteSha: "bbb",
    });

    // Drop the running task on a delay so the script's drain loop releases
    // and proceeds. The test asserts that no `systemctl stop` ran while a
    // task file was still present.
    const runningTask = join(root, "var", "queue", "running", "task_test.json");
    setTimeout(() => {
      rm(runningTask, { force: true }).catch(() => {});
    }, 250);

    try {
      const result = await runDeploy(
        {
          REPO_ROOT: root,
          SERVICE: "fake.service",
          RUNNER_DEPLOY_POLL_SEC: "0.1",
          RUNNER_DEPLOY_MAX_WAIT_SEC: "5",
          RUNNER_DEPLOY_VERIFY_INTERVAL_SEC: "0.05",
          RUNNER_DEPLOY_VERIFY_TIMEOUT_COUNT: "10",
          RUNNER_DEPLOY_VERIFY_STABLE_COUNT: "2",
        },
        binDir,
      );

      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      const calls = await readFile(callLog, "utf8");

      // We saw at least one drain-wait log line before stop, proving the
      // stop did not race past a still-running task.
      assert.match(result.stdout, /Waiting: 1 task\(s\) still running/);
      assert.match(calls, /sudo \/bin\/systemctl stop fake\.service/);
      assert.match(calls, /sudo \/bin\/systemctl start fake\.service/);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(binDir, { recursive: true, force: true });
    }
  });

  test("npm ci failure leaves service stopped and skips start", async () => {
    const root = await setupRepoRoot({ withRunningTask: false });
    const { binDir, callLog } = await setupFakeBin({
      headSha: "aaa",
      remoteSha: "bbb",
      npmExitCodes: { ci: 7 },
    });

    try {
      const result = await runDeploy(
        {
          REPO_ROOT: root,
          SERVICE: "fake.service",
          RUNNER_DEPLOY_POLL_SEC: "1",
          RUNNER_DEPLOY_MAX_WAIT_SEC: "5",
          RUNNER_DEPLOY_VERIFY_INTERVAL_SEC: "0.05",
          RUNNER_DEPLOY_VERIFY_TIMEOUT_COUNT: "4",
          RUNNER_DEPLOY_VERIFY_STABLE_COUNT: "2",
        },
        binDir,
      );

      assert.notEqual(result.code, 0);
      const calls = await readFile(callLog, "utf8");
      assert.match(calls, /sudo \/bin\/systemctl stop fake\.service/);
      assert.doesNotMatch(calls, /npm run compile/);
      assert.doesNotMatch(calls, /sudo \/bin\/systemctl start fake\.service/);
      assert.match(result.stderr, /service is currently stopped/);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(binDir, { recursive: true, force: true });
    }
  });

  test("npm run compile failure leaves service stopped and skips start", async () => {
    const root = await setupRepoRoot({ withRunningTask: false });
    const { binDir, callLog } = await setupFakeBin({
      headSha: "aaa",
      remoteSha: "bbb",
      npmExitCodes: { runCompile: 9 },
    });

    try {
      const result = await runDeploy(
        {
          REPO_ROOT: root,
          SERVICE: "fake.service",
          RUNNER_DEPLOY_POLL_SEC: "1",
          RUNNER_DEPLOY_MAX_WAIT_SEC: "5",
          RUNNER_DEPLOY_VERIFY_INTERVAL_SEC: "0.05",
          RUNNER_DEPLOY_VERIFY_TIMEOUT_COUNT: "4",
          RUNNER_DEPLOY_VERIFY_STABLE_COUNT: "2",
        },
        binDir,
      );

      assert.notEqual(result.code, 0);
      const calls = await readFile(callLog, "utf8");
      assert.match(calls, /sudo \/bin\/systemctl stop fake\.service/);
      assert.match(calls, /npm run compile/);
      assert.doesNotMatch(calls, /sudo \/bin\/systemctl start fake\.service/);
      assert.match(result.stderr, /service is currently stopped/);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(binDir, { recursive: true, force: true });
    }
  });

  test("fails when service never reaches stable active state after start", async () => {
    const root = await setupRepoRoot({ withRunningTask: false });
    const { binDir, callLog } = await setupFakeBin({
      headSha: "aaa",
      remoteSha: "bbb",
      // Mimic a Restart=always crashloop: alternating activating/active.
      // Never enough consecutive `active` to reach VERIFY_STABLE_COUNT=3.
      systemctlIsActiveSequence: [
        "activating",
        "active",
        "activating",
        "activating",
        "active",
        "activating",
        "activating",
        "activating",
      ],
    });

    try {
      const result = await runDeploy(
        {
          REPO_ROOT: root,
          SERVICE: "fake.service",
          RUNNER_DEPLOY_POLL_SEC: "1",
          RUNNER_DEPLOY_MAX_WAIT_SEC: "5",
          RUNNER_DEPLOY_VERIFY_INTERVAL_SEC: "0.05",
          RUNNER_DEPLOY_VERIFY_TIMEOUT_COUNT: "8",
          RUNNER_DEPLOY_VERIFY_STABLE_COUNT: "3",
        },
        binDir,
      );

      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /did not stabilize after start/);
      assert.doesNotMatch(result.stdout, /Restarted fake\.service/);

      const calls = await readFile(callLog, "utf8");
      assert.match(calls, /sudo \/bin\/systemctl stop fake\.service/);
      assert.match(calls, /sudo \/bin\/systemctl start fake\.service/);
      assert.match(calls, /journalctl -u fake\.service -n 80 --no-pager/);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(binDir, { recursive: true, force: true });
    }
  });

  test("fails when service stays inactive after start and emits journal tail", async () => {
    const root = await setupRepoRoot({ withRunningTask: false });
    const { binDir, callLog } = await setupFakeBin({
      headSha: "aaa",
      remoteSha: "bbb",
      systemctlIsActiveSequence: ["inactive"],
    });

    try {
      const result = await runDeploy(
        {
          REPO_ROOT: root,
          SERVICE: "fake.service",
          RUNNER_DEPLOY_POLL_SEC: "1",
          RUNNER_DEPLOY_MAX_WAIT_SEC: "5",
          RUNNER_DEPLOY_VERIFY_INTERVAL_SEC: "0.05",
          RUNNER_DEPLOY_VERIFY_TIMEOUT_COUNT: "4",
          RUNNER_DEPLOY_VERIFY_STABLE_COUNT: "2",
        },
        binDir,
      );

      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /state=inactive/);
      assert.match(result.stdout, /\(stub journal output\)/);

      const calls = await readFile(callLog, "utf8");
      assert.match(calls, /journalctl -u fake\.service/);
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
