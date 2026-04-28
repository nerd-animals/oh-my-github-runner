import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { loadPromptAssets } from "../../src/infra/prompts/prompt-asset-loader.js";

const promptsDir = "definitions/prompts";

describe("loadPromptAssets", () => {
  test("loads common work-rules, trimmed", async () => {
    const assets = await loadPromptAssets({ promptsDir });

    assert.ok(assets.commonRules.length > 0);
    assert.match(assets.commonRules, /Common Work Rules/);
    assert.equal(assets.commonRules, assets.commonRules.trim());
  });

  test("loads every persona file from personas/ as a name → trimmed-content map", async () => {
    const assets = await loadPromptAssets({ promptsDir });

    assert.ok("architecture" in assets.personas);
    assert.ok("implementation" in assets.personas);

    for (const [name, content] of Object.entries(assets.personas)) {
      assert.ok(content.length > 0, `persona ${name} should be non-empty`);
      assert.equal(content, content.trim(), `persona ${name} should be trimmed`);
    }

    assert.match(assets.personas.architecture!, /Architecture Persona/);
    assert.match(assets.personas.implementation!, /Implementation Persona/);
  });

  test("loads observe and mutate mode policies, trimmed", async () => {
    const assets = await loadPromptAssets({ promptsDir });

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
});
