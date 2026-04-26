import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { maskSecrets } from "../../src/infra/workspaces/secret-mask.js";

describe("maskSecrets", () => {
  test("masks AUTHORIZATION: Basic <b64> headers", () => {
    const input = "git -c http....extraheader=AUTHORIZATION: Basic dXNlcjpwYXNz push";

    assert.equal(
      maskSecrets(input),
      "git -c http....extraheader=AUTHORIZATION: Basic *** push",
    );
  });

  test("masks x-access-token URL embeddings", () => {
    const input =
      "fatal: unable to access 'https://x-access-token:ghs_REDACTED@github.com/owner/repo.git/'";

    assert.match(maskSecrets(input), /x-access-token:\*\*\*@github\.com/);
    assert.doesNotMatch(maskSecrets(input), /ghs_REDACTED/);
  });

  test("masks both patterns in a single string", () => {
    const input = [
      "args: -c http.https://github.com/.extraheader=AUTHORIZATION: Basic abc==",
      "url: https://x-access-token:ghs_TOKEN@github.com/foo.git",
    ].join("\n");

    const masked = maskSecrets(input);

    assert.doesNotMatch(masked, /abc==/);
    assert.doesNotMatch(masked, /ghs_TOKEN/);
    assert.match(masked, /Basic \*\*\*/);
    assert.match(masked, /x-access-token:\*\*\*/);
  });

  test("leaves untokenized content alone", () => {
    const input = "git push origin feature/x";
    assert.equal(maskSecrets(input), input);
  });
});
