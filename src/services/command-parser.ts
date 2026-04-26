export type CommandVerb = "implement" | null;

export interface ParsedCommand {
  agent: string;
  verb: CommandVerb;
  additionalInstructions: string;
}

const KNOWN_VERBS = new Set<string>(["implement"]);
const COMMAND_LINE_PATTERN = /^\/(\S+)(?:\s+(.*))?$/;
const FIRST_TOKEN_PATTERN = /^(\S+)(?:\s+(.*))?$/;

export function parseCommand(body: unknown): ParsedCommand | null {
  if (typeof body !== "string" || body.length === 0) {
    return null;
  }

  const lines = body.split(/\r?\n/);
  let inFence = false;
  let commandIndex = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = (lines[i] ?? "").trim();

    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      continue;
    }

    if (inFence) {
      continue;
    }

    if (trimmed.length === 0) {
      continue;
    }

    if (trimmed.startsWith(">")) {
      continue;
    }

    commandIndex = i;
    break;
  }

  if (commandIndex === -1) {
    return null;
  }

  const commandLine = (lines[commandIndex] ?? "").trim();
  const match = COMMAND_LINE_PATTERN.exec(commandLine);

  if (match === null) {
    return null;
  }

  const agent = match[1] ?? "";

  if (agent.length === 0) {
    return null;
  }

  const remainder = (match[2] ?? "").trim();
  let verb: CommandVerb = null;
  let firstLineExtra = remainder;

  if (remainder.length > 0) {
    const tokenMatch = FIRST_TOKEN_PATTERN.exec(remainder);
    const firstToken = tokenMatch?.[1] ?? "";

    if (KNOWN_VERBS.has(firstToken)) {
      verb = firstToken as CommandVerb;
      firstLineExtra = (tokenMatch?.[2] ?? "").trim();
    }
  }

  const followingLines = lines.slice(commandIndex + 1).join("\n");
  const additionalInstructions = [firstLineExtra, followingLines]
    .filter((segment) => segment.length > 0)
    .join("\n")
    .trim();

  return { agent, verb, additionalInstructions };
}
