import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

const DEPLOY_SCRIPT = join(process.cwd(), "ops", "scripts", "deploy.sh");

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  sudoCalls: string[];
}

async function runDeploy(opts: { emitEntrypoint: boolean }): Promise<RunResult> {
  const root = await mkdtemp(join(tmpdir(), "deploy-script-"));

  try {
    const binDir = join(root, "bin");
    await mkdir(binDir, { recursive: true });
    const sudoLog = join(root, "sudo.log");

    // npm stub: `ci --silent` is a no-op; `run compile --silent` optionally
    // creates the entrypoint. Anything else is a test-author bug -> exit 1.
    const compileBody = opts.emitEntrypoint
      ? `mkdir -p "$REPO_ROOT/dist/src" && : > "$REPO_ROOT/dist/src/index.js"`
      : `:`;

    const gitStub = `#!/bin/bash
set -e
case "$1" in
  fetch) exit 0 ;;
  rev-parse)
    case "$2" in
      HEAD) echo "0000000000000000000000000000000000000000" ;;
      origin/main) echo "1111111111111111111111111111111111111111" ;;
      *) exit 1 ;;
    esac
    ;;
  reset) exit 0 ;;
  *) exit 1 ;;
esac
`;

    const npmStub = `#!/bin/bash
set -e
if [ "$1" = "ci" ]; then exit 0; fi
if [ "$1" = "run" ] && [ "$2" = "compile" ]; then
  ${compileBody}
  exit 0
fi
exit 1
`;

    const sudoStub = `#!/bin/bash
echo "$@" >> "${sudoLog}"
`;

    // Stub the post-restart verify probe; the restart-success path needs
    // `systemctl is-active` to report `active` so the script reaches the
    // final success message instead of failing into journalctl.
    const systemctlStub = `#!/bin/bash
if [ "$1" = "is-active" ]; then
  echo "active"
  exit 0
fi
exit 0
`;

    const journalctlStub = `#!/bin/bash
exit 0
`;

    for (const [name, body] of [
      ["git", gitStub],
      ["npm", npmStub],
      ["sudo", sudoStub],
      ["systemctl", systemctlStub],
      ["journalctl", journalctlStub],
    ] as const) {
      const path = join(binDir, name);
      await writeFile(path, body, "utf8");
      await chmod(path, 0o755);
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      REPO_ROOT: root,
      SERVICE: "test.service",
      RUNNER_DEPLOY_POLL_SEC: "1",
      RUNNER_DEPLOY_VERIFY_INTERVAL_SEC: "0.05",
      RUNNER_DEPLOY_VERIFY_TIMEOUT_COUNT: "4",
      RUNNER_DEPLOY_VERIFY_STABLE_COUNT: "2",
    };

    const child = spawn("bash", [DEPLOY_SCRIPT], { env });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const code = await new Promise<number | null>((resolveExit) => {
      child.on("close", (c) => resolveExit(c));
    });

    let sudoCalls: string[] = [];
    try {
      const log = await readFile(sudoLog, "utf8");
      sudoCalls = log.split("\n").filter((line) => line.length > 0);
    } catch {
      sudoCalls = [];
    }

    return { code, stdout, stderr, sudoCalls };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("integration: ops/scripts/deploy.sh entrypoint guard", () => {
  test("starts service when compile produces dist/src/index.js", async () => {
    const result = await runDeploy({ emitEntrypoint: true });

    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    // The deploy now stops the daemon before mutating node_modules/dist and
    // starts it again after a successful build. The exact sequence matters:
    // any reordering reintroduces the live-daemon race this script exists to
    // close.
    assert.deepEqual(result.sudoCalls, [
      "/bin/systemctl stop test.service",
      "/bin/systemctl start test.service",
    ]);
  });

  test("aborts before start when compile leaves dist/src/index.js missing", async () => {
    const result = await runDeploy({ emitEntrypoint: false });

    assert.notEqual(result.code, 0);
    // Stop runs before the build (so the daemon is not racing the rebuild),
    // but start must NOT run when the entrypoint guard fails. The service is
    // intentionally left stopped so the operator notices and re-runs.
    assert.deepEqual(result.sudoCalls, ["/bin/systemctl stop test.service"]);
    assert.match(result.stderr, /compile produced no entrypoint/);
    assert.match(result.stderr, /service is currently stopped/);
  });
});
