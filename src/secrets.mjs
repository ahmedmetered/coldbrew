// Encrypts secrets (mailbox password, AI key) before they go into the local database.
// The key lives in data/secret.key (created on first use, readable by the owner only). Anyone who can read both
// files can decrypt, so this protects against a leaked database file, not against someone with access to the machine.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const cache = new Map();
function key(dir) {
  if (cache.has(dir)) return cache.get(dir);
  const file = path.join(dir, "secret.key");
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString("base64"), { mode: 0o600 });
  const k = Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64"); cache.set(dir, k); return k;
}
export const secretsDir = () => process.env.DATA_DIR || path.resolve("data");

export function encrypt(text, dir = secretsDir()) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key(dir), iv);
  const enc = Buffer.concat([c.update(String(text), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}
export function decrypt(blob, dir = secretsDir()) {
  const b = Buffer.from(String(blob), "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", key(dir), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
}
