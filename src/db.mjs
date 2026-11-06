// SQLite storage (node:sqlite, no dependencies). Everything lives in one file on the user's machine.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, k TEXT NOT NULL, v TEXT NOT NULL, PRIMARY KEY (user_id, k));
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);

-- a campaign is one vertical in one place, with the persona that decides what may be claimed
CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, vertical TEXT NOT NULL DEFAULT '',
  place TEXT NOT NULL DEFAULT '', language TEXT NOT NULL DEFAULT 'en', status TEXT NOT NULL DEFAULT 'active',
  persona_json TEXT NOT NULL DEFAULT '{}', filters_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS prospects (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  name TEXT NOT NULL, category TEXT DEFAULT '', address TEXT DEFAULT '', city TEXT DEFAULT '', lat REAL, lon REAL, website TEXT DEFAULT '',
  emails_json TEXT NOT NULL DEFAULT '[]', phones_json TEXT NOT NULL DEFAULT '[]', socials_json TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL DEFAULT '', source_id TEXT DEFAULT '', dedupe_key TEXT NOT NULL, rating REAL, reviews INTEGER, score INTEGER NOT NULL DEFAULT 0,
  channel TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'Found', dnc INTEGER NOT NULL DEFAULT 0, dnc_reason TEXT DEFAULT '', notes TEXT DEFAULT '',
  enriched_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (campaign_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS prospects_campaign ON prospects(campaign_id, status, score DESC);
-- one verifiable thing about a prospect, with the page it came from, so a draft can cite it and a person can check it
CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY, prospect_id INTEGER NOT NULL REFERENCES prospects(id) ON DELETE CASCADE, kind TEXT NOT NULL DEFAULT 'site',
  text TEXT NOT NULL, source_url TEXT DEFAULT '', fetched_at TEXT NOT NULL, UNIQUE (prospect_id, text)
);
CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, prospect_id INTEGER NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  step INTEGER NOT NULL DEFAULT 1, subject TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', angle TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft', lint_json TEXT NOT NULL DEFAULT '{}', ai INTEGER NOT NULL DEFAULT 0, due_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, approved_at TEXT, sent_at TEXT
);
CREATE INDEX IF NOT EXISTS drafts_user ON drafts(user_id, status, due_at);
-- audit trail: every state change, who did it and when
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, prospect_id INTEGER REFERENCES prospects(id) ON DELETE CASCADE,
  draft_id INTEGER REFERENCES drafts(id) ON DELETE SET NULL, kind TEXT NOT NULL, detail TEXT DEFAULT '', at TEXT NOT NULL
);
-- permanent do-not-contact list, shared by every campaign and checked before a draft exists
CREATE TABLE IF NOT EXISTS suppressions (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL, value TEXT NOT NULL, reason TEXT DEFAULT '', at TEXT NOT NULL,
  PRIMARY KEY (user_id, kind, value)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY, prospect_id INTEGER NOT NULL REFERENCES prospects(id) ON DELETE CASCADE, ext_id TEXT NOT NULL, dir TEXT NOT NULL, platform TEXT NOT NULL,
  text TEXT NOT NULL, ts TEXT NOT NULL, intent TEXT DEFAULT '', UNIQUE (prospect_id, ext_id)
);
CREATE TABLE IF NOT EXISTS mail_accounts (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, provider TEXT NOT NULL, mail_user TEXT NOT NULL, pass_enc TEXT NOT NULL, host TEXT NOT NULL,
  port INTEGER NOT NULL, secure INTEGER NOT NULL DEFAULT 1, folders_json TEXT NOT NULL DEFAULT '["INBOX"]', last_check TEXT, last_result TEXT, last_error TEXT
);
CREATE TABLE IF NOT EXISTS social_accounts (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, platform TEXT NOT NULL, token_enc TEXT NOT NULL, username TEXT DEFAULT '', saved_at TEXT NOT NULL,
  last_check TEXT, last_result TEXT, last_error TEXT, PRIMARY KEY (user_id, platform)
);
CREATE TABLE IF NOT EXISTS sweeps (
  id INTEGER PRIMARY KEY, campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE, source TEXT NOT NULL, query TEXT DEFAULT '',
  found INTEGER NOT NULL DEFAULT 0, added INTEGER NOT NULL DEFAULT 0, error TEXT DEFAULT '', at TEXT NOT NULL
);
`;

export function openDb(file = path.resolve("data/app.db")) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}

export const now = () => new Date().toISOString();
