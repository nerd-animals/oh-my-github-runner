import { readFile } from "node:fs/promises";
import path from "node:path";

export interface PromptAssets {
  commonRules: string;
  persona: string;
}

export interface LoadPromptAssetsInput {
  promptsDir: string;
  personaName: string;
}

export async function loadPromptAssets({
  promptsDir,
  personaName,
}: LoadPromptAssetsInput): Promise<PromptAssets> {
  const [commonRules, persona] = await Promise.all([
    readFile(path.resolve(promptsDir, "_common", "work-rules.md"), "utf8"),
    readFile(
      path.resolve(promptsDir, "personas", `${personaName}.md`),
      "utf8",
    ),
  ]);

  return {
    commonRules: commonRules.trim(),
    persona: persona.trim(),
  };
}
