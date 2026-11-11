import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  guardWebhookSignature,
  verifyWebhookSignature,
} from "../../src/bridge/verify-signature.js";

const secret = "webhook secret";
const payload = '{"message":"hello"}\n';
const bytes = new TextEncoder().encode(payload).buffer;
const signature = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;

afterEach(() => vi.restoreAllMocks());

describe("verifyWebhookSignature", () => {
  it("fails closed if the crypto provider fails", async () => {
    vi.spyOn(crypto.subtle, "importKey").mockRejectedValueOnce(new Error("unavailable"));
    expect(await verifyWebhookSignature(bytes, signature, secret)).toBe(false);
  });
  it("accepts a valid signature over the exact raw bytes", async () => {
    expect(await verifyWebhookSignature(bytes, signature, secret)).toBe(true);
    expect(
      await verifyWebhookSignature(
        bytes,
        signature.toUpperCase().replace("SHA256=", "sha256="),
        secret,
      ),
    ).toBe(true);
  });

  it("rejects altered bytes, different secrets, and tampered signatures", async () => {
    expect(
      await verifyWebhookSignature(
        new TextEncoder().encode(payload.trim()).buffer,
        signature,
        secret,
      ),
    ).toBe(false);
    expect(await verifyWebhookSignature(bytes, signature, "other secret")).toBe(false);
    expect(await verifyWebhookSignature(bytes, `sha256=${"0".repeat(64)}`, secret)).toBe(false);
  });

  it.each([
    null,
    "",
    "sha1=abc",
    `SHA256=${"a".repeat(64)}`,
    `sha256=${"a".repeat(63)}`,
    `sha256=${"a".repeat(65)}`,
    `sha256=${"g".repeat(64)}`,
    ` ${signature}`,
    `${signature} `,
    `${signature}\n`,
    `${signature},${signature}`,
  ])("rejects malformed header %j", async (header) => {
    expect(await verifyWebhookSignature(bytes, header, secret)).toBe(false);
  });

  it.each([undefined, ""])("fails closed for missing secret %j", async (missingSecret) => {
    expect(await verifyWebhookSignature(bytes, signature, missingSecret)).toBe(false);
  });

  it("verifies binary bytes without decoding or reserializing", async () => {
    const binary = new Uint8Array([0, 255, 128, 13, 10]);
    const header = `sha256=${createHmac("sha256", secret).update(binary).digest("hex")}`;
    expect(await verifyWebhookSignature(binary.buffer, header, secret)).toBe(true);
  });
});

describe("guardWebhookSignature", () => {
  it("rejects an unreadable body with an empty 401", async () => {
    const request = new Request("https://example.test", { method: "POST", body: payload });
    await request.text();
    const response = await guardWebhookSignature(request, secret);
    expect(response?.status).toBe(401);
    expect(await response?.text()).toBe("");
  });
  it("allows valid requests and preserves their body for the handler", async () => {
    const request = new Request("https://example.test", {
      method: "POST",
      body: payload,
      headers: { "X-Hub-Signature-256": signature },
    });
    expect(await guardWebhookSignature(request, secret)).toBeNull();
    expect(await request.text()).toBe(payload);
  });

  it.each([null, "sha256=bad", `sha256=${"0".repeat(64)}`])(
    "returns an empty 401 for rejected signature %j",
    async (header) => {
      const request = new Request("https://example.test", {
        method: "POST",
        body: payload,
        headers: header === null ? {} : { "X-Hub-Signature-256": header },
      });
      const response = await guardWebhookSignature(request, secret);
      expect(response?.status).toBe(401);
      expect(await response?.text()).toBe("");
    },
  );

  it("returns an empty 401 when the secret is absent", async () => {
    const request = new Request("https://example.test", {
      method: "POST",
      body: payload,
      headers: { "X-Hub-Signature-256": signature },
    });
    const response = await guardWebhookSignature(request, undefined);
    expect(response?.status).toBe(401);
    expect(await response?.text()).toBe("");
  });
});
