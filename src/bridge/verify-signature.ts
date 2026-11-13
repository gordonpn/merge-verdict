/** Verify GitHub's signature over the original, unparsed request bytes. */
export async function verifyWebhookSignature(
  rawBody: ArrayBuffer,
  signature: string | null,
  secret: string | undefined,
): Promise<boolean> {
  if (!secret || !signature || !/^sha256=[a-fA-F0-9]{64}$/.test(signature)) {
    return false;
  }

  const digest = new Uint8Array(32);
  for (let index = 0; index < digest.length; index++) {
    digest[index] = Number.parseInt(signature.slice(7 + index * 2, 9 + index * 2), 16);
  }

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    // Delegate cryptographic comparison to Web Crypto, not JavaScript equality.
    return await crypto.subtle.verify("HMAC", key, digest, rawBody);
  } catch {
    return false;
  }
}

/** Return an empty 401 on rejection, or null to continue handling the request. */
export async function guardWebhookSignature(
  request: Request,
  secret: string | undefined,
): Promise<Response | null> {
  try {
    const valid = await verifyWebhookSignature(
      await request.clone().arrayBuffer(),
      request.headers.get("X-Hub-Signature-256"),
      secret,
    );
    if (valid) return null;
  } catch {
    // Unreadable bodies must not bypass authentication.
  }
  return new Response(null, { status: 401 });
}
