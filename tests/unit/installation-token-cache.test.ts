import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { InstallationTokenCache } from "../../src/infra/github/installation-token-cache.js";

describe("InstallationTokenCache", () => {
  test("returns undefined when nothing has been cached", () => {
    const cache = new InstallationTokenCache({ now: () => 0 });

    assert.equal(cache.getInstallationId("octo/repo"), undefined);
    assert.equal(cache.getToken("123"), undefined);
  });

  test("returns the cached installation id and token until near expiry", () => {
    let now = 0;
    const cache = new InstallationTokenCache({
      bufferMs: 60_000,
      now: () => now,
    });

    cache.setInstallationId("octo/repo", "123");
    cache.setToken("123", "tok-abc", 1_000_000);

    now = 100_000;
    assert.equal(cache.getInstallationId("octo/repo"), "123");
    assert.equal(cache.getToken("123"), "tok-abc");
  });

  test("treats a token as expired once now is within the buffer window", () => {
    let now = 0;
    const cache = new InstallationTokenCache({
      bufferMs: 60_000,
      now: () => now,
    });

    cache.setToken("123", "tok-abc", 1_000_000);

    now = 940_000;
    assert.equal(cache.getToken("123"), undefined);
  });

  test("evicts the entry on near-expiry hit so subsequent gets return undefined", () => {
    let now = 0;
    const cache = new InstallationTokenCache({
      bufferMs: 60_000,
      now: () => now,
    });

    cache.setToken("123", "tok-abc", 1_000_000);

    now = 950_000;
    assert.equal(cache.getToken("123"), undefined);
    assert.equal(cache.getToken("123"), undefined);
  });

  test("setToken overwrites an existing entry", () => {
    const cache = new InstallationTokenCache({ now: () => 0 });

    cache.setToken("123", "tok-old", 100_000);
    cache.setToken("123", "tok-new", 500_000);

    assert.equal(cache.getToken("123"), "tok-new");
  });
});
