import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "./db.ts";
import { oauthTokens } from "./schema.ts";

/**
 * AES-256-GCM for ClickUp OAuth tokens and webhook secrets.
 *
 * A stolen database dump is not a stolen ClickUp account: without the key from
 * the environment the ciphertext is inert. The 16-byte GCM auth tag is appended
 * to the ciphertext, so tampering fails the decrypt instead of silently
 * returning garbage.
 */

const ALGORITHM = "aes-256-gcm";
const NONCE_BYTES = 12;

export function loadKey(base64: string | undefined): Buffer {
  if (!base64) throw new Error("TOKEN_ENCRYPTION_KEY is not set");
  const key = Buffer.from(base64, "base64");
  if (key.length !== 32) {
    throw new Error(
      `TOKEN_ENCRYPTION_KEY must decode to 32 bytes, got ${key.length}. Generate with: openssl rand -base64 32`,
    );
  }
  return key;
}

export function encrypt(plaintext: string, key: Buffer): { ciphertext: Buffer; nonce: Buffer } {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext: Buffer.concat([body, cipher.getAuthTag()]), nonce };
}

export function decrypt(ciphertext: Buffer, nonce: Buffer, key: Buffer): string {
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const body = ciphertext.subarray(0, ciphertext.length - 16);
  const decipher = createDecipheriv(ALGORITHM, key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

export async function saveToken(
  db: Db,
  input: { userId: string; teamId: string; token: string; key: Buffer },
): Promise<void> {
  const { ciphertext, nonce } = encrypt(input.token, input.key);
  await db
    .insert(oauthTokens)
    .values({ userId: input.userId, teamId: input.teamId, ciphertext, nonce })
    .onConflictDoUpdate({
      target: oauthTokens.userId,
      set: { ciphertext, nonce, teamId: input.teamId, updatedAt: new Date() },
    });
}

export async function loadToken(
  db: Db,
  userId: string,
  key: Buffer,
): Promise<{ token: string; teamId: string } | null> {
  const [row] = await db.select().from(oauthTokens).where(eq(oauthTokens.userId, userId)).limit(1);
  if (!row) return null;
  return { token: decrypt(row.ciphertext, row.nonce, key), teamId: row.teamId };
}
