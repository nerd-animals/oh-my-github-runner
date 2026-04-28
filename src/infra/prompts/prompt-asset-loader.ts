import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { ExecutionMode } from "../../domain/instruction.js";
import type { ModePolicies } from "../../domain/rules/execution-prompt.js";

export interface PromptAssets {
  commonRules: string;
  personas: Record<string, string>;
  modePolicies: ModePolicies;
}

export interface LoadPromptAssetsInput {
  promptsDir: string;
}

const MODE_NAMES: ExecutionMode[] = ["observe", "mutate"];

async function loadPersonas(
  personasDir: string,
): Promise<Record<string, string>> {
  const entries = await readdir(personasDir);
  const mdFiles = entries.filter((name) => name.endsWith(".md"));

  if (mdFiles.length === 0) {
    throw new Error(`No persona files found in ${personasDir}`);
  }

  const loaded = await Promise.all(
    mdFiles.map(async (file) => {
      const name = file.replace(/\.md$/, "");
      const content = await readFile(path.resolve(personasDir, file), "utf8");
      return [name, content.trim()] as const;
    }),
  );

  return Object.fromEntries(loaded);
}

export async function loadPromptAssets({
  promptsDir,
}: LoadPromptAssetsInput): Promise<PromptAssets> {
  const [commonRules, personas, modeContents] = await Promise.all([
    readFile(path.resolve(promptsDir, "_common", "work-rules.md"), "utf8"),
    loadPersonas(path.resolve(promptsDir, "personas")),
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
    personas,
    modePolicies,
  };
}
