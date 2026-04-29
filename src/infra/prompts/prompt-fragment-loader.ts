import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export type PromptFragmentCache = ReadonlyMap<string, string>;

export interface LoadPromptFragmentsInput {
  promptsDir: string;
}

const FRAGMENT_SUBDIRS = ["_common", "personas", "modes"] as const;

// Loads every md file under definitions/prompts/{_common,personas,modes}
// into a flat map keyed by "<subdir>/<basename-without-ext>", e.g.
//   _common/work-rules.md      -> "_common/work-rules"
//   personas/architecture.md   -> "personas/architecture"
//   modes/observe.md           -> "modes/observe"
// Strategies reference fragments via these keys; the cache is loaded once
// at startup and shared across runs.
export async function loadPromptFragments({
  promptsDir,
}: LoadPromptFragmentsInput): Promise<PromptFragmentCache> {
  const cache = new Map<string, string>();

  for (const sub of FRAGMENT_SUBDIRS) {
    const dir = path.resolve(promptsDir, sub);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }

    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const name = entry.slice(0, -".md".length);
      const content = await readFile(path.resolve(dir, entry), "utf8");
      cache.set(`${sub}/${name}`, content.trim());
    }
  }

  return cache;
}
