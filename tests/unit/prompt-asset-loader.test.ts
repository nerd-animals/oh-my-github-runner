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

  test("loads observe and mutate mode policies, trimmed", async () => {
    const assets = await loadPromptAssets({
      promptsDir,
      personaName: "architecture",
    });

    assert.ok(assets.modePolicies.observe.length > 0);
    assert.ok(assets.modePolicies.mutate.length > 0);
    assert.equal(
      assets.modePolicies.observe,
      assets.modePolicies.observe.trim(),
    );
    assert.equal(
      assets.modePolicies.mutate,
      assets.modePolicies.mutate.trim(),
    );

    assert.match(assets.modePolicies.observe, /- Mode: observe/);
    assert.match(assets.modePolicies.observe, /MUST NOT modify files/);
    assert.match(assets.modePolicies.observe, /gh issue comment/);

    assert.match(assets.modePolicies.mutate, /- Mode: mutate/);
    assert.match(assets.modePolicies.mutate, /git push/);
    assert.match(assets.modePolicies.mutate, /gh pr create/);
    assert.match(assets.modePolicies.mutate, /MUST NOT merge/);
    assert.match(assets.modePolicies.mutate, /non-fast-forward/);
    assert.match(assets.modePolicies.mutate, /protected branch/);
    assert.match(assets.modePolicies.mutate, /auth/);
  });

  test("rejects when the persona file does not exist", async () => {
    await assert.rejects(
      loadPromptAssets({ promptsDir, personaName: "no-such-persona" }),
      /ENOENT/,
    );
  });
});
