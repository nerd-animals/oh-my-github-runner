import { runEnqueueCommand } from "./enqueue-command.js";

function getOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);

  if (index === -1) {
    return undefined;
  }

  return args[index + 1];
}

export async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;

  if (command !== "enqueue") {
    console.error("Only the 'enqueue' command is scaffolded right now.");
    process.exitCode = 1;
    return;
  }

  const repoOwner = getOption(rest, "--repo-owner");
  const repoName = getOption(rest, "--repo-name");
  const sourceKind = getOption(rest, "--source-kind");
  const sourceNumber = getOption(rest, "--source-number");
  const instructionId = getOption(rest, "--instruction-id");
  const agent =
    getOption(rest, "--agent") ?? process.env.DEFAULT_AGENT ?? "claude";

  if (
    repoOwner === undefined ||
    repoName === undefined ||
    sourceKind === undefined ||
    sourceNumber === undefined ||
    instructionId === undefined
  ) {
    console.error("Missing required enqueue arguments.");
    process.exitCode = 1;
    return;
  }

  if (sourceKind !== "issue" && sourceKind !== "pull_request") {
    console.error("source-kind must be 'issue' or 'pull_request'.");
    process.exitCode = 1;
    return;
  }

  const parsedSourceNumber = Number(sourceNumber);

  if (!Number.isInteger(parsedSourceNumber) || parsedSourceNumber <= 0) {
    console.error("source-number must be a positive integer.");
    process.exitCode = 1;
    return;
  }

  const task = await runEnqueueCommand({
    repoOwner,
    repoName,
    sourceKind,
    sourceNumber: parsedSourceNumber,
    instructionId,
    agent,
  });

  console.log(
    JSON.stringify({
      taskId: task.taskId,
      status: task.status,
      instructionId: task.instructionId,
    }),
  );
}

void main(process.argv.slice(2));
