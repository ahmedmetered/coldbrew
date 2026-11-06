// The rules of the app, on top of the database: campaigns, prospects, the do-not-contact list, drafts and their approval,
// follow-ups, and the numbers behind the dashboard. No HTTP here, so everything is tested directly.
import { now } from "./db.mjs";
import { dedupeKey, mergeProspects, normPhone, domainOf, cleanEmail } from "./normalize.mjs";
import { passesFilter, channelFor, scoreProspect } from "./rank.mjs";
import { fetchOsm } from "./sources.mjs";
import { enrichProspect } from "./enrich.mjs";
import { lintDraft } from "./lint.mjs";

export const STATUSES = ["Found", "Drafted", "Approved", "Contacted", "Replied", "Meeting", "Won", "Lost"];
export const DRAFT_STATUSES = ["draft", "approved", "sent", "discarded"];
// days to wait after a sent message before the next one is due: email 2 around day 5, email 3 around day 10, breakup around day 14
export const FOLLOW_UP_DAYS = { 1: 5, 2: 5, 3: 4 };
export const MAX_STEP = 4;

const J = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };
const err = (status, message) => Object.assign(new Error(message), { status });
const cap = (v, n) => String(v ?? "").slice(0, n);
const event = (db, userId, kind, detail = "", prospectId = null, draftId = null) => db.prepare("INSERT INTO events (user_id, prospect_id, draft_id, kind, detail, at) VALUES (?, ?, ?, ?, ?, ?)").run(userId, prospectId, draftId, kind, cap(detail, 500), now());

// ---------- campaigns ----------
export function createCampaign(db, userId, b) {
  const name = cap(b.name, 120).trim(); if (!name) throw err(400, "Give the campaign a name.");
  const t = now();
  const id = db.prepare("INSERT INTO campaigns (user_id, name, vertical, place, language, persona_json, filters_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(userId, name, cap(b.vertical, 120), cap(b.place, 160), ["it", "en"].includes(b.language) ? b.language : "en", JSON.stringify(cleanPersona(b.persona)), JSON.stringify(cleanFilters(b.filters)), t, t).lastInsertRowid;
  return Number(id);
}
export function cleanPersona(p = {}) {
  const list = v => (Array.isArray(v) ? v : String(v || "").split("\n")).map(s => cap(s, 300).trim()).filter(Boolean).slice(0, 20);
  return { sender: cap(p.sender, 120), company: cap(p.company, 120), product: cap(p.product, 80), offer: cap(p.offer, 600), icp: cap(p.icp, 400), claims: list(p.claims), optout: cap(p.optout, 300), requireOptout: p.requireOptout !== false,
    legitimateInterest: cap(p.legitimateInterest, 400), icpRules: { noBooking: !!p.icpRules?.noBooking, hasBooking: !!p.icpRules?.hasBooking, activeSocial: !!p.icpRules?.activeSocial } };
}
export function cleanFilters(f = {}) { return { keep: cap(f.keep, 300), drop: cap(f.drop, 300), dropNames: cap(f.dropNames, 300), needWebsite: !!f.needWebsite, needContact: !!f.needContact }; }
export const campaignRow = r => r && ({ ...r, persona: J(r.persona_json, {}), filters: J(r.filters_json, {}) });
export const getCampaign = (db, userId, id) => campaignRow(db.prepare("SELECT * FROM campaigns WHERE id = ? AND user_id = ?").get(Number(id), userId));

// ---------- the do-not-contact list ----------
export function suppress(db, userId, kind, value, reason = "") {
  value = String(value || "").trim().toLowerCase(); if (!value) return;
  db.prepare("INSERT INTO suppressions (user_id, kind, value, reason, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, kind, value) DO NOTHING").run(userId, kind, value, cap(reason, 200), now());
}
export function suppressedBy(db, userId, p) {
  const q = db.prepare("SELECT reason FROM suppressions WHERE user_id = ? AND kind = ? AND value = ?");
  for (const e of p.emails || []) { const r = q.get(userId, "email", e.toLowerCase()); if (r) return `email on your do-not-contact list (${r.reason || "no reason given"})`; }
  const dom = domainOf(p.website || ""); if (dom) { const r = q.get(userId, "domain", dom); if (r) return `website on your do-not-contact list (${r.reason || "no reason given"})`; }
  for (const ph of p.phones || []) { const r = q.get(userId, "phone", normPhone(ph)); if (r) return `phone on your do-not-contact list (${r.reason || "no reason given"})`; }
  return "";
}
export function setDoNotContact(db, userId, prospectId, reason = "asked not to be contacted") {
  const p = getProspect(db, userId, prospectId); if (!p) throw err(404, "Prospect not found.");
  const SHARED = /(facebook|instagram|linkedin|google|wixsite|linktr)/i;
  for (const e of p.emails) suppress(db, userId, "email", e, reason);
  const dom = domainOf(p.website); if (dom && !SHARED.test(dom)) suppress(db, userId, "domain", dom, reason);
  for (const ph of p.phones) suppress(db, userId, "phone", normPhone(ph), reason);
  db.prepare("UPDATE prospects SET dnc = 1, dnc_reason = ?, status = 'Lost', score = 0, updated_at = ? WHERE id = ? AND user_id = ?").run(cap(reason, 200), now(), p.id, userId);
  const open = db.prepare("UPDATE drafts SET status = 'discarded', updated_at = ? WHERE prospect_id = ? AND user_id = ? AND status IN ('draft','approved')").run(now(), p.id, userId).changes;
  event(db, userId, "do_not_contact", `${reason}${open ? `; ${open} open draft(s) discarded` : ""}`, p.id);
}
export function allowContactAgain(db, userId, prospectId) {
  const p = getProspect(db, userId, prospectId); if (!p) throw err(404, "Prospect not found.");
  for (const e of p.emails) db.prepare("DELETE FROM suppressions WHERE user_id = ? AND kind = 'email' AND value = ?").run(userId, e.toLowerCase());
  db.prepare("UPDATE prospects SET dnc = 0, dnc_reason = '', status = 'Found', updated_at = ? WHERE id = ? AND user_id = ?").run(now(), p.id, userId);
  event(db, userId, "contact_allowed_again", "removed from the do-not-contact list by you", p.id);
}

// ---------- prospects ----------
export const prospectRow = r => r && ({ ...r, emails: J(r.emails_json, []), phones: J(r.phones_json, []), socials: J(r.socials_json, {}), dnc: !!r.dnc });
export const getProspect = (db, userId, id) => prospectRow(db.prepare("SELECT * FROM prospects WHERE id = ? AND user_id = ?").get(Number(id), userId));
export const factsOf = (db, prospectId) => db.prepare("SELECT kind, text, source_url, fetched_at FROM facts WHERE prospect_id = ? ORDER BY id").all(prospectId);

// add what a source found: dedupe inside the campaign, merge what we learn, check the do-not-contact list, score
export function addProspects(db, userId, campaignId, list, { applyFilter = true } = {}) {
  const c = getCampaign(db, userId, campaignId); if (!c) throw err(404, "Campaign not found.");
  const out = { added: 0, merged: 0, filtered: 0, suppressed: 0, why: {} };
  const find = db.prepare("SELECT * FROM prospects WHERE campaign_id = ? AND dedupe_key = ?");
  const ins = db.prepare(`INSERT INTO prospects (user_id, campaign_id, name, category, address, city, lat, lon, website, emails_json, phones_json, socials_json, source, source_id, dedupe_key, rating, reviews, score, channel, dnc, dnc_reason, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const t = now();
  db.exec("BEGIN");
  try {
    for (const raw of list) {
      const p = { ...raw, emails: raw.emails || [], phones: raw.phones || [], socials: raw.socials || {} };
      if (!p.name) continue;
      if (applyFilter) { const f = passesFilter(p, c.filters); if (!f.ok) { out.filtered++; out.why[f.why] = (out.why[f.why] || 0) + 1; continue; } }
      const key = dedupeKey(p), ex = find.get(campaignId, key);
      if (ex) {
        const m = mergeProspects(prospectRow(ex), p);
        const nFacts = db.prepare("SELECT COUNT(*) n FROM facts WHERE prospect_id = ?").get(ex.id).n;
        db.prepare("UPDATE prospects SET website = ?, emails_json = ?, phones_json = ?, socials_json = ?, address = ?, city = ?, rating = ?, reviews = ?, channel = ?, score = ?, updated_at = ? WHERE id = ?")
          .run(m.website || "", JSON.stringify(m.emails), JSON.stringify(m.phones), JSON.stringify(m.socials), m.address || "", m.city || "", m.rating ?? null, m.reviews ?? null, channelFor(m), ex.dnc ? 0 : scoreProspect(m, { facts: nFacts, icp: c.persona.icpRules }), t, ex.id);
        out.merged++; continue;
      }
      const why = suppressedBy(db, userId, p);
      const score = why ? 0 : scoreProspect(p, { icp: c.persona.icpRules });
      ins.run(userId, campaignId, cap(p.name, 160), cap(p.category, 100), cap(p.address, 240), cap(p.city, 80), p.lat ?? null, p.lon ?? null, cap(p.website, 300), JSON.stringify(p.emails), JSON.stringify(p.phones), JSON.stringify(p.socials),
        cap(p.source, 20), cap(p.source_id, 80), key, p.rating ?? null, p.reviews ?? null, score, channelFor(p), why ? 1 : 0, why, t, t);
      if (why) out.suppressed++; else out.added++;
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return out;
}

// one sweep over several municipalities for one category; each query is recorded so the dashboard can show what each source gave
export async function runOsmSweep(db, userId, campaignId, { category, places }, fetchImpl = fetch, log = () => {}) {
  const total = { found: 0, added: 0, merged: 0, filtered: 0, suppressed: 0, errors: [] };
  for (const place of places) {
    try {
      const found = await fetchOsm(category, place, fetchImpl);
      const r = addProspects(db, userId, campaignId, found.map(p => ({ ...p, city: p.city || place })));
      db.prepare("INSERT INTO sweeps (campaign_id, source, query, found, added, at) VALUES (?, 'osm', ?, ?, ?, ?)").run(campaignId, `${category} in ${place}`, found.length, r.added, now());
      total.found += found.length; for (const k of ["added", "merged", "filtered", "suppressed"]) total[k] += r[k];
      log(`${place}: ${found.length} found, ${r.added} new`);
    } catch (e) {
      db.prepare("INSERT INTO sweeps (campaign_id, source, query, found, added, error, at) VALUES (?, 'osm', ?, 0, 0, ?, ?)").run(campaignId, `${category} in ${place}`, cap(e.message, 200), now());
      total.errors.push(`${place}: ${e.message}`);
    }
  }
  return total;
}

// read the business's own site once; store contacts and facts, and re-score
export async function enrichStored(db, userId, prospectId, fetchImpl = fetch) {
  const p = getProspect(db, userId, prospectId); if (!p) throw err(404, "Prospect not found.");
  const c = db.prepare("SELECT persona_json FROM campaigns WHERE id = ?").get(p.campaign_id), persona = J(c?.persona_json, {});
  const r = await enrichProspect(p, fetchImpl), t = now();
  const emails = [...new Set([...p.emails, ...r.emails.map(cleanEmail)].filter(Boolean))], phones = [...new Set([...p.phones, ...r.phones])], socials = { ...r.socials, ...p.socials };
  const insFact = db.prepare("INSERT OR IGNORE INTO facts (prospect_id, kind, text, source_url, fetched_at) VALUES (?, ?, ?, ?, ?)");
  for (const f of r.facts) insFact.run(p.id, f.kind, cap(f.text, 220), cap(f.source_url, 300), t);
  const nFacts = db.prepare("SELECT COUNT(*) n FROM facts WHERE prospect_id = ?").get(p.id).n;
  const why = suppressedBy(db, userId, { ...p, emails, phones });
  const next = { ...p, emails, phones, socials };
  const score = why ? 0 : scoreProspect(next, { facts: nFacts, signals: r.signals, icp: persona.icpRules });
  db.prepare("UPDATE prospects SET emails_json = ?, phones_json = ?, socials_json = ?, channel = ?, score = ?, dnc = ?, dnc_reason = ?, enriched_at = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(emails), JSON.stringify(phones), JSON.stringify(socials), channelFor(next), score, why ? 1 : p.dnc ? 1 : 0, why || p.dnc_reason || "", t, t, p.id);
  event(db, userId, "enriched", r.ok ? `${r.pages.length} page(s), ${r.facts.length} fact(s), ${emails.length} email(s)` : r.reason, p.id);
  return { ok: r.ok, reason: r.reason, emails, phones, facts: nFacts, pages: r.pages || [] };
}

// ---------- drafts and approval ----------
export const draftRow = r => r && ({ ...r, lint: J(r.lint_json, {}), ai: !!r.ai });
export const getDraft = (db, userId, id) => draftRow(db.prepare("SELECT * FROM drafts WHERE id = ? AND user_id = ?").get(Number(id), userId));

function lintFor(db, userId, prospect, d) {
  const c = db.prepare("SELECT persona_json FROM campaigns WHERE id = ?").get(prospect.campaign_id);
  return lintDraft({ subject: d.subject, body: d.body, step: d.step, persona: J(c?.persona_json, {}), facts: factsOf(db, prospect.id), prospect });
}
export function createDraft(db, userId, b) {
  const p = getProspect(db, userId, b.prospectId); if (!p) throw err(404, "Prospect not found.");
  if (p.dnc) throw err(409, `${p.name} is on your do-not-contact list${p.dnc_reason ? ` (${p.dnc_reason})` : ""}. No draft can be written for them.`);
  const step = Math.min(Math.max(Math.floor(+b.step || 1), 1), MAX_STEP);
  if (db.prepare("SELECT 1 FROM drafts WHERE prospect_id = ? AND step = ? AND status IN ('draft','approved')").get(p.id, step)) throw err(409, `There is already an open message ${step} for ${p.name}.`);
  if (db.prepare("SELECT 1 FROM drafts WHERE prospect_id = ? AND step >= ? AND status = 'sent'").get(p.id, step)) throw err(409, `Message ${step} (or a later one) was already sent to ${p.name}.`);
  const t = now(), lint = lintFor(db, userId, p, { ...b, step });
  const id = Number(db.prepare("INSERT INTO drafts (user_id, prospect_id, step, subject, body, angle, status, lint_json, ai, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)")
    .run(userId, p.id, step, cap(b.subject, 160), cap(b.body, 4000), cap(b.angle, 80), JSON.stringify(lint), b.ai ? 1 : 0, t, t).lastInsertRowid);
  if (p.status === "Found") db.prepare("UPDATE prospects SET status = 'Drafted', updated_at = ? WHERE id = ?").run(t, p.id);
  event(db, userId, "draft_created", `message ${step}${b.ai ? " (written by a model)" : ""}`, p.id, id);
  return id;
}
// editing a draft re-checks it, and an edit to an approved draft takes the approval back: what is sent must be what you approved
export function updateDraft(db, userId, id, b) {
  const d = getDraft(db, userId, id); if (!d) throw err(404, "Draft not found.");
  if (["sent", "discarded"].includes(d.status)) throw err(409, `This message is already ${d.status}.`);
  const p = getProspect(db, userId, d.prospect_id);
  const next = { ...d, subject: "subject" in b ? cap(b.subject, 160) : d.subject, body: "body" in b ? cap(b.body, 4000) : d.body }, lint = lintFor(db, userId, p, next), changed = next.subject !== d.subject || next.body !== d.body;
  const status = changed && d.status === "approved" ? "draft" : d.status;
  db.prepare("UPDATE drafts SET subject = ?, body = ?, lint_json = ?, status = ?, approved_at = ?, updated_at = ? WHERE id = ?").run(next.subject, next.body, JSON.stringify(lint), status, status === "draft" ? null : d.approved_at, now(), d.id);
  if (changed) event(db, userId, status !== d.status ? "approval_withdrawn_by_edit" : "draft_edited", "", p.id, d.id);
  return getDraft(db, userId, id);
}
export function approveDraft(db, userId, id) {
  const d = getDraft(db, userId, id); if (!d) throw err(404, "Draft not found.");
  if (d.status !== "draft") throw err(409, d.status === "approved" ? "Already approved." : `This message is ${d.status}.`);
  const p = getProspect(db, userId, d.prospect_id);
  if (p.dnc) throw err(409, "This business is on your do-not-contact list.");
  const lint = lintFor(db, userId, p, d), errors = lint.issues.filter(i => i.severity === "error");
  if (errors.length) throw err(422, `Fix this first: ${errors[0].text}${errors.length > 1 ? ` (and ${errors.length - 1} more)` : ""}`);
  const t = now();
  db.prepare("UPDATE drafts SET status = 'approved', approved_at = ?, lint_json = ?, updated_at = ? WHERE id = ?").run(t, JSON.stringify(lint), t, d.id);
  if (["Found", "Drafted"].includes(p.status)) db.prepare("UPDATE prospects SET status = 'Approved', updated_at = ? WHERE id = ?").run(t, p.id);
  event(db, userId, "approved", `message ${d.step}`, p.id, d.id);
  return getDraft(db, userId, id);
}
export function discardDraft(db, userId, id) {
  const d = getDraft(db, userId, id); if (!d) throw err(404, "Draft not found.");
  if (d.status === "sent") throw err(409, "A sent message cannot be discarded.");
  db.prepare("UPDATE drafts SET status = 'discarded', updated_at = ? WHERE id = ?").run(now(), d.id);
  event(db, userId, "discarded", `message ${d.step}`, d.prospect_id, d.id);
}
// you pressed "Sent" (or the inbox reader saw it): only approved messages can be marked sent
export function markSent(db, userId, id, when = now()) {
  const d = getDraft(db, userId, id); if (!d) throw err(404, "Draft not found.");
  if (d.status !== "approved") throw err(409, "Only an approved message can be marked as sent.");
  const p = getProspect(db, userId, d.prospect_id); if (p.dnc) throw err(409, "This business is on your do-not-contact list.");
  const t = now();
  db.prepare("UPDATE drafts SET status = 'sent', sent_at = ?, updated_at = ? WHERE id = ?").run(when, t, d.id);
  if (["Found", "Drafted", "Approved"].includes(p.status)) db.prepare("UPDATE prospects SET status = 'Contacted', updated_at = ? WHERE id = ?").run(t, p.id);
  event(db, userId, "sent", `message ${d.step}`, p.id, d.id);
  return getDraft(db, userId, id);
}

// who is due a follow-up: the last message was sent long enough ago, nobody answered, and no later message exists
export function followUpsDue(db, userId, at = Date.now()) {
  const rows = db.prepare(`SELECT d.step, d.sent_at, p.id AS prospect_id, p.name, p.status, p.channel, p.campaign_id FROM drafts d JOIN prospects p ON p.id = d.prospect_id
    WHERE d.user_id = ? AND d.status = 'sent' AND p.dnc = 0 AND p.status IN ('Contacted') AND d.step = (SELECT MAX(step) FROM drafts WHERE prospect_id = p.id AND status = 'sent')
    AND NOT EXISTS (SELECT 1 FROM drafts x WHERE x.prospect_id = p.id AND x.step > d.step AND x.status IN ('draft','approved','sent'))
    AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.prospect_id = p.id AND m.dir = 'in')`).all(userId);
  return rows.filter(r => FOLLOW_UP_DAYS[r.step]).map(r => ({ ...r, next_step: r.step + 1, due_at: new Date(Date.parse(r.sent_at) + FOLLOW_UP_DAYS[r.step] * 864e5).toISOString() }))
    .filter(r => Date.parse(r.due_at) <= at).sort((a, b) => a.due_at.localeCompare(b.due_at));
}

// ---------- the dashboard ----------
export function insights(db, userId, { campaignId = null, days = 30 } = {}) {
  const w = campaignId ? "AND p.campaign_id = ?" : "", a = campaignId ? [userId, campaignId] : [userId];
  const funnel = Object.fromEntries(STATUSES.map(s => [s, 0]));
  for (const r of db.prepare(`SELECT p.status, COUNT(*) n FROM prospects p WHERE p.user_id = ? ${w} GROUP BY p.status`).all(...a)) funnel[r.status] = r.n;
  const total = Object.values(funnel).reduce((x, y) => x + y, 0);
  const sinceIso = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const perDay = {};
  const bump = (day, k) => { if (day >= sinceIso) (perDay[day] ||= { drafted: 0, approved: 0, sent: 0, replies: 0 })[k]++; };
  for (const r of db.prepare(`SELECT e.kind, substr(e.at, 1, 10) AS day FROM events e LEFT JOIN prospects p ON p.id = e.prospect_id WHERE e.user_id = ? ${w} AND e.kind IN ('draft_created','approved','sent')`).all(...a)) bump(r.day, { draft_created: "drafted", approved: "approved", sent: "sent" }[r.kind]);
  for (const r of db.prepare(`SELECT substr(m.ts, 1, 10) AS day FROM messages m JOIN prospects p ON p.id = m.prospect_id WHERE p.user_id = ? ${w} AND m.dir = 'in'`).all(...a)) bump(r.day, "replies");
  const series = []; for (let i = days - 1; i >= 0; i--) { const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10); series.push({ day: d, ...(perDay[d] || { drafted: 0, approved: 0, sent: 0, replies: 0 }) }); }
  const sent = db.prepare(`SELECT d.step, d.angle, d.prospect_id, d.sent_at, p.category, p.campaign_id, p.channel FROM drafts d JOIN prospects p ON p.id = d.prospect_id WHERE d.user_id = ? ${w} AND d.status = 'sent'`).all(...a);
  const replied = new Set(db.prepare(`SELECT DISTINCT m.prospect_id FROM messages m JOIN prospects p ON p.id = m.prospect_id WHERE p.user_id = ? ${w} AND m.dir = 'in'`).all(...a).map(r => r.prospect_id));
  const group = (keyFn) => { const g = {}; for (const s of sent) { const k = keyFn(s) || "(none)"; (g[k] ||= { sent: 0, replied: new Set() }); g[k].sent++; if (replied.has(s.prospect_id)) g[k].replied.add(s.prospect_id); } return Object.entries(g).map(([k, v]) => ({ key: k, sent: v.sent, replied: v.replied.size, rate: v.sent ? Math.round(100 * v.replied.size / v.sent) : 0 })).sort((x, y) => y.sent - x.sent).slice(0, 8); };
  const gaps = db.prepare(`SELECT (julianday(MIN(m.ts)) - julianday(MIN(d.sent_at))) AS days FROM drafts d JOIN messages m ON m.prospect_id = d.prospect_id AND m.dir = 'in' JOIN prospects p ON p.id = d.prospect_id WHERE d.user_id = ? ${w} AND d.status = 'sent' GROUP BY d.prospect_id`).all(...a).map(r => r.days).filter(x => x != null && x >= 0);
  const buckets = [["same day", 1], ["1-2 days", 3], ["3-5 days", 6], ["6-10 days", 11], ["11+ days", 1e9]], hist = buckets.map(([label, max], i) => ({ label, n: gaps.filter(g => g >= (i ? buckets[i - 1][1] : 0) && g < max).length }));
  const intents = Object.fromEntries(db.prepare(`SELECT m.intent, COUNT(*) n FROM messages m JOIN prospects p ON p.id = m.prospect_id WHERE p.user_id = ? ${w} AND m.dir = 'in' AND m.intent != '' GROUP BY m.intent`).all(...a).map(r => [r.intent, r.n]));
  const sources = db.prepare(`SELECT s.source, SUM(s.found) found, SUM(s.added) added FROM sweeps s JOIN campaigns c ON c.id = s.campaign_id WHERE c.user_id = ? ${campaignId ? "AND s.campaign_id = ?" : ""} GROUP BY s.source`).all(...a);
  const scoreBands = [[0, 25], [25, 50], [50, 75], [75, 101]].map(([lo, hi]) => ({ label: `${lo}-${Math.min(hi, 100)}`, n: db.prepare(`SELECT COUNT(*) n FROM prospects p WHERE p.user_id = ? ${w} AND p.dnc = 0 AND p.score >= ? AND p.score < ?`).get(...a, lo, hi).n }));
  const channels = db.prepare(`SELECT COALESCE(NULLIF(p.channel, ''), 'none') AS key, COUNT(*) n FROM prospects p WHERE p.user_id = ? ${w} AND p.dnc = 0 GROUP BY 1`).all(...a);
  const prospectsSent = new Set(sent.map(s => s.prospect_id)).size;
  return { total, funnel, series, prospectsSent, replied: replied.size, replyRate: prospectsSent ? Math.round(100 * replied.size / prospectsSent) : null, meetings: funnel.Meeting + funnel.Won, won: funnel.Won,
    medianDaysToReply: gaps.length ? Math.round(gaps.sort((x, y) => x - y)[Math.floor(gaps.length / 2)] * 10) / 10 : null, byStep: group(s => `message ${s.step}`), byAngle: group(s => s.angle), byCategory: group(s => s.category),
    byCampaign: group(s => `#${s.campaign_id}`), hist, intents, sources, scoreBands, channels, dnc: db.prepare(`SELECT COUNT(*) n FROM prospects p WHERE p.user_id = ? ${w} AND p.dnc = 1`).get(...a).n,
    outbox: { draft: db.prepare(`SELECT COUNT(*) n FROM drafts d JOIN prospects p ON p.id = d.prospect_id WHERE d.user_id = ? ${w} AND d.status = 'draft'`).get(...a).n, approved: db.prepare(`SELECT COUNT(*) n FROM drafts d JOIN prospects p ON p.id = d.prospect_id WHERE d.user_id = ? ${w} AND d.status = 'approved'`).get(...a).n }, followUps: followUpsDue(db, userId).length };
}
