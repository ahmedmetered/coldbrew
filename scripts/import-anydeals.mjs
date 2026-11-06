// Bring the prospects from the anydeals tracker (prospects-data.json) into a Coldbrew campaign.
// Run: node scripts/import-anydeals.mjs <prospects-data.json> <your Coldbrew email> [--campaign "name"] [--db data/app.db] [--dry]
// Keeps names, handles, notes, stage, the drafts already written, any stored replies and the do-not-contact flags.
// Drafts keep their channel: an Instagram draft needs no subject. Everything is added to ONE campaign, so you can split it later.
import fs from "node:fs";
import { openDb, now } from "../src/db.mjs";
import * as core from "../src/core.mjs";

const STAGE = { Found: "Found", Drafted: "Drafted", Approved: "Approved", Contacted: "Contacted", "Follow-up sent": "Contacted", Replied: "Replied", Meeting: "Meeting", Won: "Won", Lost: "Lost" };
const CHANNEL = { Instagram: "instagram", Email: "email", WhatsApp: "phone", Phone: "phone" };
const asIso = d => (d && !isNaN(Date.parse(d)) ? new Date(d).toISOString() : now());

export function toProspect(a) {
  const ch = CHANNEL[a.channel] || "", handle = String(a.handle || "").trim(), notes = String(a.notes || "");
  const sector = (notes.match(/Settore:\s*([^.]+)/i) || [])[1]?.trim() || "", reviews = (notes.match(/Recensioni:\s*([\d.]+)/i) || [])[1];
  const isMail = /@/.test(handle) && !handle.startsWith("@") && ch !== "instagram";
  return { name: String(a.name || "").trim(), category: sector, city: "Milano", website: "", emails: isMail ? [handle.toLowerCase()] : [], phones: [],
    socials: ch === "instagram" && handle ? { instagram: `https://instagram.com/${handle.replace(/^@/, "")}` } : {}, source: "anydeals", source_id: String(a.id || ""), rating: null, reviews: reviews ? parseInt(reviews.replace(/\./g, ""), 10) : null };
}

export function importAnydeals(db, userId, campaignId, rows, { dry = false } = {}) {
  const out = { added: 0, merged: 0, drafts: 0, messages: 0, dnc: 0, skipped: 0 };
  const prospects = rows.filter(a => a && a.name).map(toProspect);
  const r = dry ? { added: prospects.length, merged: 0 } : core.addProspects(db, userId, campaignId, prospects, { applyFilter: false });
  out.added = r.added; out.merged = r.merged; out.skipped = rows.length - prospects.length;
  if (dry) return out;
  const find = db.prepare("SELECT id FROM prospects WHERE campaign_id = ? AND source = 'anydeals' AND source_id = ?");
  const upd = db.prepare("UPDATE prospects SET status = ?, notes = ?, channel = CASE WHEN channel = '' THEN ? ELSE channel END, created_at = ?, updated_at = ? WHERE id = ?");
  const draftExists = db.prepare("SELECT 1 FROM drafts WHERE prospect_id = ? AND step = 1");
  const msgIns = db.prepare("INSERT OR IGNORE INTO messages (prospect_id, ext_id, dir, platform, text, ts, intent) VALUES (?, ?, ?, ?, ?, ?, ?)");
  for (const a of rows) {
    const p = find.get(campaignId, String(a.id || "")); if (!p) continue;
    const ch = CHANNEL[a.channel] || "";
    upd.run(a.dnc ? "Lost" : STAGE[a.status] || "Found", [a.notes, a.next && `Next: ${a.next}`].filter(Boolean).join(" | ").slice(0, 4000), ch, asIso(a.added), asIso(a.updated), p.id);
    if (a.draft && !draftExists.get(p.id)) {
      const t = asIso(a.added), sent = a.date_contacted ? asIso(a.date_contacted) : null, st = sent ? "sent" : a.status === "Approved" ? "approved" : "draft";
      const id = Number(db.prepare("INSERT INTO drafts (user_id, prospect_id, step, subject, body, angle, status, lint_json, ai, created_at, updated_at, approved_at, sent_at) VALUES (?, ?, 1, '', ?, '', ?, '{}', 0, ?, ?, ?, ?)")
        .run(userId, p.id, String(a.draft).slice(0, 4000), st, t, t, st === "draft" ? null : t, sent).lastInsertRowid);
      db.prepare("INSERT INTO events (user_id, prospect_id, draft_id, kind, detail, at) VALUES (?, ?, ?, 'imported_from_anydeals', ?, ?)").run(userId, p.id, id, `draft ${st}`, now()); out.drafts++;
    }
    for (const m of a.messages || []) if (m && m.text) { out.messages += Number(msgIns.run(p.id, String(m.id || `${a.id}-${m.ts}`), m.dir === "out" ? "out" : "in", String(m.platform || "instagram").toLowerCase(), String(m.text).slice(0, 4000), asIso(m.ts), a.intent || "").changes); }
    if (a.dnc) { core.setDoNotContact(db, userId, p.id, a.attention || "marked do-not-contact in anydeals"); out.dnc++; }
  }
  return out;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  const argv = process.argv.slice(2), flag = n => argv.includes(n), opt = n => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);
  const [file, email] = argv.filter(a => !a.startsWith("--") && a !== opt("--db") && a !== opt("--campaign"));
  if (!file || !email) { console.log('Usage: node scripts/import-anydeals.mjs <prospects-data.json> <your Coldbrew email> [--campaign "name"] [--db data/app.db] [--dry]'); process.exit(1); }
  const db = openDb(opt("--db") || "data/app.db"), user = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (!user) { console.log(`No Coldbrew account for ${email}. Sign up in the app first.`); process.exit(1); }
  let rows = JSON.parse(fs.readFileSync(file, "utf8")); if (!Array.isArray(rows)) rows = rows.prospects || [];
  const name = opt("--campaign") || "From anydeals", ex = db.prepare("SELECT id FROM campaigns WHERE user_id = ? AND name = ?").get(user.id, name);
  const cid = ex ? ex.id : flag("--dry") ? 0 : core.createCampaign(db, user.id, { name, vertical: "training academies", place: "Milano", language: "it", persona: { sender: "", optout: "", requireOptout: false } });
  const r = importAnydeals(db, user.id, cid, rows, { dry: flag("--dry") });
  console.log(`${flag("--dry") ? "Would add" : "Added"} ${r.added} prospects (${r.merged} already there), ${r.drafts} drafts, ${r.messages} replies, ${r.dnc} do-not-contact, into "${name}".`);
}
