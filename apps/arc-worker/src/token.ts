/**
 * The homeowner's status token: 32 random bytes, base64url. It is the only
 * credential a homeowner ever holds, so only its SHA-256 is stored and every
 * lookup hashes first.
 */

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generateStatusToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

export function isWellFormedToken(token: string): boolean {
  return TOKEN_RE.test(token);
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array | string): Promise<string> {
  // Copy into a fresh ArrayBuffer-backed view: SubtleCrypto takes no SharedArrayBuffer.
  const input = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const hashStatusToken = (token: string): Promise<string> => sha256Hex(token);
