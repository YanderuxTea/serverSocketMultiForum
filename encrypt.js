import crypto from "node:crypto";
const algorithm = "aes-256-gcm";
const key = Buffer.from(process.env.KEY_CRYPTO, "hex");
export function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(algorithm, key, iv);
  let encrypted = cipher.update(text, "utf-8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag();
  return JSON.stringify({
    iv: iv.toString("hex"),
    content: encrypted,
    authTag: authTag.toString("hex"),
  });
}
