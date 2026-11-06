// Instagram replies, READ-ONLY. Uses the "Instagram API with Instagram Login" on graph.instagram.com. It only works once you
// connect an Instagram professional account (Business or Creator) with a token that has instagram_business_manage_messages.
// Until a token is saved nothing here runs. The API can read conversations but cannot start one: first messages are always
// sent by you, by hand, from Instagram, and this module never sends anything.
import { now } from "./db.mjs";
import { decrypt } from "./secrets.mjs";
import { processIncoming } from "./replies.mjs";
import { markSent } from "./core.mjs";

const fixTz = s => String(s || "").replace(/([+-]\d\d)(\d\d)$/, "$1:$2"); // Graph returns +0000, JS wants +00:00
const iso = s => { const d = new Date(fixTz(s)); return isNaN(d) ? "" : d.toISOString(); };
export const normalizeHandle = h => String(h || "").trim().toLowerCase().replace(/^https?:\/\/(www\.)?instagram\.com\//, "").replace(/^@/, "").split(/[/?#]/)[0];

export async function fetchInstagram(cfg, { since = null, fetchImpl = fetch } = {}) {
  const base = (cfg.baseUrl || "https://graph.instagram.com") + "/" + (cfg.apiVersion || "v23.0");
  const get = async url => {
    const r = await fetchImpl(url, { headers: { authorization: "Bearer " + cfg.token } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Instagram API ${r.status}: ${(j.error && j.error.message) || JSON.stringify(j).slice(0, 200)}`);
    return j;
  };
  const me = await get(`${base}/me?fields=user_id,username`);
  const myId = String(me.user_id || me.id || ""), myName = (me.username || "").toLowerCase();
  const fields = encodeURIComponent(`participants,updated_time,messages.limit(${cfg.messagesPerThread || 20}){id,created_time,from,to,message}`);
  let url = `${base}/me/conversations?platform=instagram&fields=${fields}&limit=${cfg.threadsPerPage || 25}`;
  const threads = []; let pages = 0;
  while (url && pages < (cfg.maxPages || 4)) {
    const j = await get(url); pages++;
    const data = j.data || [];
    for (const c of data) {
      const lead = ((c.participants && c.participants.data) || []).find(x => String(x.id) !== myId && (x.username || "").toLowerCase() !== myName);
      if (!lead) continue;
      const msgs = ((c.messages && c.messages.data) || []).map(m => ({ id: String(m.id), dir: (String(m.from && m.from.id) === myId || ((m.from && m.from.username) || "").toLowerCase() === myName) ? "out" : "in",
        text: m.message || "[attachment or reaction]", ts: iso(m.created_time) })).filter(m => m.ts && (!since || new Date(m.ts) >= since)).sort((a, b) => a.ts.localeCompare(b.ts));
      if (msgs.length) threads.push({ threadId: c.id, handle: lead.username || String(lead.id), name: lead.name || "", messages: msgs });
    }
    url = (j.paging && j.paging.next) || "";
    if (since && data.length && data.every(c => c.updated_time && new Date(fixTz(c.updated_time)) < since)) break; // older than the window, stop paging
  }
  return { me: { id: myId, username: myName }, threads };
}

// a quick "is this token good, and whose is it?" for the settings page
export async function testInstagram(token, fetchImpl = fetch, baseUrl = "https://graph.instagram.com") {
  const r = await fetchImpl(`${baseUrl}/v23.0/me?fields=user_id,username`, { headers: { authorization: "Bearer " + token } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Instagram said no (${r.status}): ${(j.error && j.error.message) || "check the token and its permissions"}`);
  return { username: j.username || "", id: String(j.user_id || j.id || "") };
}

// long-lived tokens last 60 days and can be refreshed once they are at least a day old
export async function refreshInstagramToken(token, fetchImpl = fetch) {
  const r = await fetchImpl(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error("Token refresh failed: " + ((j.error && j.error.message) || r.status));
  return { token: j.access_token, expiresInDays: Math.round((j.expires_in || 0) / 86400) };
}

// which prospect has this Instagram handle?
export function prospectByHandle(db, userId, handle) {
  const want = normalizeHandle(handle); if (!want) return null;
  for (const r of db.prepare("SELECT id, socials_json FROM prospects WHERE user_id = ? AND socials_json LIKE '%instagram%'").all(userId)) {
    try { if (normalizeHandle(JSON.parse(r.socials_json).instagram) === want) return r.id; } catch { /* skip bad row */ }
  }
  return null;
}

// apply one conversation: what you sent (so the outbox knows it went out) and what they wrote back
export function applyThread(db, userId, thread) {
  const pid = prospectByHandle(db, userId, thread.handle);
  if (!pid) return { matched: false, replies: 0, excluded: 0, attention: 0 };
  const res = { matched: true, replies: 0, excluded: 0, attention: 0 };
  const outIns = db.prepare("INSERT OR IGNORE INTO messages (prospect_id, ext_id, dir, platform, text, ts, intent) VALUES (?, ?, 'out', 'instagram', ?, ?, '')");
  for (const m of thread.messages) {
    if (m.dir === "out") {
      if (!outIns.run(pid, `ig-${m.id}`, m.text.slice(0, 4000), m.ts).changes) continue;
      // you sent it from Instagram: the oldest approved message for them is now sent
      const d = db.prepare("SELECT id FROM drafts WHERE prospect_id = ? AND user_id = ? AND status = 'approved' ORDER BY step, id LIMIT 1").get(pid, userId);
      if (d) { try { markSent(db, userId, d.id, m.ts); } catch { /* not allowed (do-not-contact) */ } }
      else db.prepare("UPDATE prospects SET status = 'Contacted', updated_at = ? WHERE id = ? AND status IN ('Found','Drafted','Approved')").run(now(), pid);
    } else {
      const r = processIncoming(db, userId, { prospectId: pid, extId: `ig-${m.id}`, text: m.text, ts: m.ts, platform: "instagram" });
      if (r.outcome === "replied" || r.outcome === "lost") res.replies++; if (r.outcome === "excluded") res.excluded++; if (r.attention) res.attention++;
    }
  }
  return res;
}

export async function checkInstagram(db, userId, { days = 14, fetchImpl = fetch } = {}) {
  const row = db.prepare("SELECT * FROM social_accounts WHERE user_id = ? AND platform = 'instagram'").get(userId);
  if (!row) return { configured: false };
  const res = { configured: true, threads: 0, unmatched: 0, replies: 0, excluded: 0, attention: 0 };
  try {
    const { threads, me } = await fetchInstagram({ token: decrypt(row.token_enc) }, { since: new Date(Date.now() - days * 864e5), fetchImpl });
    for (const t of threads) { res.threads++; const r = applyThread(db, userId, t); if (!r.matched) res.unmatched++; res.replies += r.replies; res.excluded += r.excluded; res.attention += r.attention; }
    db.prepare("UPDATE social_accounts SET username = ?, last_check = ?, last_result = ?, last_error = NULL WHERE user_id = ? AND platform = 'instagram'").run(me.username, now(), JSON.stringify(res), userId);
    return res;
  } catch (e) {
    db.prepare("UPDATE social_accounts SET last_check = ?, last_error = ? WHERE user_id = ? AND platform = 'instagram'").run(now(), e.message, userId);
    return { ...res, error: e.message };
  }
}
