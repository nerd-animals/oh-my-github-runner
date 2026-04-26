import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, test } from "node:test";
import {
  computeHubSignature,
  verifyHubSignature,
} from "../../src/infra/webhook/hmac-verifier.js";

const secret = "test-secret";

describe("verifyHubSignature", () => {
  test("accepts a valid signature", () => {
    const body = Buffer.from('{"hello":"world"}');
    const signature = computeHubSignature(secret, body);

    assert.equal(verifyHubSignature(secret, body, signature), true);
  });

  test("rejects a signature computed with the wrong secret", () => {
    const body = Buffer.from("payload");
    const signature = computeHubSignature("other-secret", body);

    assert.equal(verifyHubSignature(secret, body, signature), false);
  });

  test("rejects when the signature header is missing", () => {
    const body = Buffer.from("payload");

    assert.equal(verifyHubSignature(secret, body, undefined), false);
  });

  test("rejects when the prefix is missing", () => {
    const body = Buffer.from("payload");
    const digest = createHmac("sha256", secret).update(body).digest("hex");

    assert.equal(verifyHubSignature(secret, body, digest), false);
  });

  test("rejects a signature of the wrong length", () => {
    const body = Buffer.from("payload");

    assert.equal(verifyHubSignature(secret, body, "sha256=deadbeef"), false);
  });

  test("rejects when raw body is tampered with after signing", () => {
    const original = Buffer.from('{"hello":"world"}');
    const signature = computeHubSignature(secret, original);
    const tampered = Buffer.from('{"hello":"woRld"}');

    assert.equal(verifyHubSignature(secret, tampered, signature), false);
  });
});
