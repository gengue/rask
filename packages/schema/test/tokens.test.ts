import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { decrypt, encrypt, loadKey } from "../src/tokens.ts";

describe("token encryption", () => {
  const key = randomBytes(32);

  test("round-trips a token", () => {
    const { ciphertext, nonce } = encrypt("pk_12345_ABCDEF", key);
    expect(decrypt(ciphertext, nonce, key)).toBe("pk_12345_ABCDEF");
  });

  test("uses a fresh nonce, so the same token never encrypts to the same bytes", () => {
    const a = encrypt("same", key);
    const b = encrypt("same", key);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  test("rejects tampered ciphertext instead of returning garbage", () => {
    const { ciphertext, nonce } = encrypt("pk_secret", key);
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 0xff;
    expect(() => decrypt(ciphertext, nonce, key)).toThrow();
  });

  test("rejects the wrong key", () => {
    const { ciphertext, nonce } = encrypt("pk_secret", key);
    expect(() => decrypt(ciphertext, nonce, randomBytes(32))).toThrow();
  });

  test("rejects a key that is not 32 bytes", () => {
    expect(() => loadKey(Buffer.from("short").toString("base64"))).toThrow(/32 bytes/);
    expect(() => loadKey(undefined)).toThrow(/not set/);
  });
});
