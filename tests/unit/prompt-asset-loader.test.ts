import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { loadPromptAssets } from "../../src/infra/prompts/prompt-asset-loader.js";

const promptsDir = "definitions/prompts";

describe("loadPromptAssets", () => {
  test("loads common work-rules and the named persona, trimmed", async () => {
    const assets = await loadPromptAssets({
      promptsDir,
      personaName: "architecture",
    });

    assert.ok(assets.commonRules.length > 0);
    assert.ok(assets.persona.length > 0);
    assert.match(assets.commonRules, /Common Work Rules/);
    assert.match(assets.persona, /Architecture Persona/);
    assert.equal(assets.commonRules, assets.commonRules.trim());
    assert.equal(assets.persona, assets.persona.trim());
  });

  test("rejects when the persona file does not exist", async () => {
    await assert.rejects(
      loadPromptAssets({ promptsDir, personaName: "no-such-persona" }),
      /ENOENT/,
    );
  });
});
