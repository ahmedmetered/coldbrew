// Accounts and sessions with the standard library only: scrypt password hashes, random session tokens
// stored as SHA-256 hashes, HttpOnly cookies.
import crypto from "node:crypto";
import { now } from "./db.mjs";

const SESSION_DAYS = 30;
const sha = s => crypto.createHash("sha256").update(s).digest("hex");

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}
export function verifyPassword(pw, stored) {
  const [alg, saltHex, hashHex] = String(stored || "").split("$");
  if (alg !== "scrypt" || !saltHex || !hashHex) return false;
  const want = Buffer.from(hashHex, "hex"), got = crypto.scryptSync(pw, Buffer.from(saltHex, "hex"), want.length);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

export const validEmail = e => typeof e === "string" && e.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);

export function signup(db, email, password) {
  email = String(email || "").trim().toLowerCase();
  if (!validEmail(email)) throw httpErr(400, "Enter a valid email address.");
  if (typeof password !== "string" || password.length < 10) throw httpErr(400, "Use a password of at least 10 characters.");
  if (password.length > 200) throw httpErr(400, "That password is too long.");
  if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) throw httpErr(409, "An account with this email already exists.");
  const r = db.prepare("INSERT INTO users (email, pass_hash, created_at) VALUES (?, ?, ?)").run(email, hashPassword(password), now());
  return Number(r.lastInsertRowid);
}

// failed-attempt throttle per email, in memory (resets on restart): 8 tries per 15 minutes
const tries = new Map();
export function login(db, email, password) {
  email = String(email || "").trim().toLowerCase();
  const t = tries.get(email) || { n: 0, at: Date.now() };
  if (Date.now() - t.at > 15 * 60e3) { t.n = 0; t.at = Date.now(); }
  if (t.n >= 8) throw httpErr(429, "Too many attempts. Try again in a few minutes.");
  const u = db.prepare("SELECT id, pass_hash FROM users WHERE email = ?").get(email);
  const ok = u ? verifyPassword(String(password || ""), u.pass_hash) : (verifyPassword("x", "scrypt$00$00"), false); // keep timing similar
  if (!ok) { t.n++; tries.set(email, t); throw httpErr(401, "Wrong email or password."); }
  tries.delete(email);
  return u.id;
}

export function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const exp = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha(token), userId, exp);
  return { token, maxAge: SESSION_DAYS * 86400 };
}
export function userFromToken(db, token) {
  if (!token) return null;
  const row = db.prepare("SELECT u.id, u.email, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?").get(sha(token));
  if (!row) return null;
  if (row.expires_at < now()) { db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha(token)); return null; }
  return { id: row.id, email: row.email };
}
export const destroySession = (db, token) => token && db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha(token));

export function parseCookies(header = "") {
  const out = {};
  for (const part of String(header).split(";")) { const i = part.indexOf("="); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}
export function cookie(token, maxAge, secure = false) {
  return `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

export function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }

// delete the account and everything tied to it
export function deleteAccount(db, userId) { db.prepare("DELETE FROM users WHERE id = ?").run(userId); }
