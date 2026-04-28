import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ExecutionMode } from "../../domain/instruction.js";
import type { ModePolicies } from "../../domain/rules/execution-prompt.js";

export interface PromptAssets {
  commonRules: string;
  persona: string;
  modePolicies: ModePolicies;
}

export interface LoadPromptAssetsInput {
  promptsDir: string;
  personaName: string;
}

const MODE_NAMES: ExecutionMode[] = ["observe", "mutate"];

export async function loadPromptAssets({
  promptsDir,
  personaName,
}: LoadPromptAssetsInput): Promise<PromptAssets> {
  const [commonRules, persona, modeContents] = await Promise.all([
    readFile(path.resolve(promptsDir, "_common", "work-rules.md"), "utf8"),
    readFile(
      path.resolve(promptsDir, "personas", `${personaName}.md`),
      "utf8",
    ),
    Promise.all(
      MODE_NAMES.map(async (mode) =>
        [
          mode,
          await readFile(
            path.resolve(promptsDir, "modes", `${mode}.md`),
            "utf8",
          ),
        ] as const,
      ),
    ),
  ]);

  const modePolicies = Object.fromEntries(
    modeContents.map(([mode, content]) => [mode, content.trim()]),
  ) as ModePolicies;

  return {
    commonRules: commonRules.trim(),
    persona: persona.trim(),
    modePolicies,
  };
}
