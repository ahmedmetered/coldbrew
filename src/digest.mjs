// The daily digest: what needs you today. Built from the database; shown in the app and, if you set a webhook, pushed to
// your phone (ntfy.sh, Discord, Slack, or any URL that accepts a POST). It never contains a message body, only counts and names.
import { now } from "./db.mjs";
import { followUpsDue } from "./core.mjs";

export function buildDigest(db, userId, since = new Date(Date.now() - 864e5).toISOString()) {
  const replies = db.prepare(`SELECT p.name, m.intent, m.platform FROM messages m JOIN prospects p ON p.id = m.prospect_id WHERE p.user_id = ? AND m.dir = 'in' AND m.ts >= ? ORDER BY m.ts DESC LIMIT 20`).all(userId, since);
  const attention = db.prepare(`SELECT p.name FROM events e JOIN prospects p ON p.id = e.prospect_id WHERE e.user_id = ? AND e.kind = 'angry_legal' AND e.at >= ?`).all(userId, since);
  const waiting = db.prepare("SELECT COUNT(*) n FROM drafts WHERE user_id = ? AND status = 'draft'").get(userId).n;
  const ready = db.prepare("SELECT COUNT(*) n FROM drafts WHERE user_id = ? AND status = 'approved'").get(userId).n;
  const due = followUpsDue(db, userId);
  const meetings = db.prepare("SELECT COUNT(*) n FROM prospects WHERE user_id = ? AND status = 'Meeting'").get(userId).n;
  const lines = [];
  if (attention.length) lines.push(`Needs your attention, do not reply: ${attention.map(a => a.name).join(", ")} (angry or legal message).`);
  if (replies.length) lines.push(`${replies.length} new repl${replies.length > 1 ? "ies" : "y"}: ${[...new Set(replies.map(r => r.name))].slice(0, 6).join(", ")}${replies.some(r => r.intent === "interested") ? " (someone sounds interested)" : ""}.`);
  if (waiting) lines.push(`${waiting} draft${waiting > 1 ? "s" : ""} wait${waiting > 1 ? "" : "s"} for your approval.`);
  if (ready) lines.push(`${ready} approved message${ready > 1 ? "s are" : " is"} ready to send.`);
  if (due.length) lines.push(`${due.length} follow-up${due.length > 1 ? "s are" : " is"} due: ${due.slice(0, 5).map(d => d.name).join(", ")}${due.length > 5 ? " and more" : ""}.`);
  if (meetings) lines.push(`${meetings} meeting${meetings > 1 ? "s" : ""} in progress.`);
  return { at: now(), since, empty: lines.length === 0, attention: attention.length, replies: replies.length, waiting, ready, due: due.length, meetings, text: lines.length ? lines.join("\n") : "Nothing needs you today." };
}

export async function sendWebhook(url, title, text, fetchImpl = fetch) {
  let u; try { u = new URL(url); } catch { throw new Error("The notification address is not a valid URL."); }
  if (!/^https?:$/.test(u.protocol)) throw new Error("The notification address must start with http:// or https://");
  let init;
  if (/discord(app)?\.com$/.test(u.hostname)) init = { headers: { "content-type": "application/json" }, body: JSON.stringify({ content: `**${title}**\n${text}`.slice(0, 1900) }) };
  else if (/slack\.com$/.test(u.hostname)) init = { headers: { "content-type": "application/json" }, body: JSON.stringify({ text: `*${title}*\n${text}` }) };
  else init = { headers: { "content-type": "text/plain; charset=utf-8", title: title.replace(/[^\x20-\x7e]/g, "").slice(0, 200) || "Coldbrew" }, body: text }; // ntfy and generic receivers
  const r = await fetchImpl(u, { method: "POST", signal: AbortSignal.timeout(15000), ...init });
  if (!r.ok) throw new Error(`The notification service answered ${r.status}.`);
}

export const digestSettings = (db, userId) => { const g = k => db.prepare("SELECT v FROM settings WHERE user_id = ? AND k = ?").get(userId, k)?.v; return { webhook: g("digest_webhook") || "", hour: Math.min(23, Math.max(0, parseInt(g("digest_hour") ?? "8", 10) || 0)), enabled: g("digest_enabled") !== "0" }; };

// once a day, at or after the chosen hour: store the digest and push it if there is a webhook and something to say
export async function runDigestIfDue(db, userId, { at = new Date(), fetchImpl = fetch, log = () => {} } = {}) {
  const s = digestSettings(db, userId); if (!s.enabled) return null;
  const last = db.prepare("SELECT v FROM settings WHERE user_id = ? AND k = 'digest_last'").get(userId)?.v;
  if (at.getHours() < s.hour || (last && new Date(last).toDateString() === at.toDateString())) return null;
  const d = buildDigest(db, userId, last || new Date(at.getTime() - 864e5).toISOString());
  db.prepare("INSERT INTO settings (user_id, k, v) VALUES (?, 'digest_last', ?) ON CONFLICT(user_id, k) DO UPDATE SET v = excluded.v").run(userId, d.at);
  db.prepare("INSERT INTO settings (user_id, k, v) VALUES (?, 'digest_json', ?) ON CONFLICT(user_id, k) DO UPDATE SET v = excluded.v").run(userId, JSON.stringify(d));
  if (s.webhook && !d.empty) { try { await sendWebhook(s.webhook, `Coldbrew: ${d.waiting + d.ready + d.due + d.replies} to look at`, d.text, fetchImpl); } catch (e) { log(`digest for user ${userId}: ${e.message}`); } }
  return d;
}
