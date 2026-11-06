// HTTP server: JSON API under /api, the app from /public. Standard library only; listens on 127.0.0.1.
// Run: node src/server.mjs   (PORT, DB_FILE, DATA_DIR, SECURE_COOKIES=1 behind https, NO_SCHEDULER=1)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, now } from "./db.mjs";
import * as auth from "./auth.mjs";
import * as core from "./core.mjs";
import { parseProspectCsv, selectorsFor, OSM_CATEGORIES } from "./sources.mjs";
import { lintDraft } from "./lint.mjs";
import { skeleton, aiDraft, observationCandidates } from "./draft.mjs";
import { aiConfigFromInput, ollamaModels, AI_PROVIDERS } from "./ai.mjs";
import { processIncoming } from "./replies.mjs";
import { accountConfig, accountFromInput, testLogin, checkReplies, PROVIDERS } from "./mail.mjs";
import { encrypt, decrypt } from "./secrets.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, "..", "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".jpg": "image/jpeg" };
const cap = (v, n) => String(v ?? "").slice(0, n);
const J = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };

export function createApp(db, { secureCookies = false, aiFetch = fetch, osmFetch = fetch, siteFetch = fetch } = {}) {
  const sendJson = (res, status, body, extra = {}) => { const s = JSON.stringify(body); res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra }); res.end(s); };
  const readBody = (req, limit = 1e6) => new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on("data", c => { n += c.length; if (n > limit) { reject(auth.httpErr(413, "Request too large.")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { if (!chunks.length) return resolve({}); try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(auth.httpErr(400, "Invalid JSON.")); } });
    req.on("error", reject);
  });
  const sameOrigin = req => { const o = req.headers.origin; if (!o) return true; try { return new URL(o).host === req.headers.host; } catch { return false; } };
  const getSetting = (userId, k) => db.prepare("SELECT v FROM settings WHERE user_id = ? AND k = ?").get(userId, k)?.v ?? null;
  const putSetting = (userId, k, v) => (v == null || v === "" ? db.prepare("DELETE FROM settings WHERE user_id = ? AND k = ?").run(userId, k) : db.prepare("INSERT INTO settings (user_id, k, v) VALUES (?, ?, ?) ON CONFLICT(user_id, k) DO UPDATE SET v = excluded.v").run(userId, k, String(v)));
  const aiConfigFor = userId => { const raw = getSetting(userId, "ai"); if (!raw) return null; const k = getSetting(userId, "ai_key"); return { ...JSON.parse(raw), apiKey: k ? decrypt(k) : "" }; };
  const own = (table, userId, id) => db.prepare(`SELECT * FROM ${table} WHERE id = ? AND user_id = ?`).get(Number(id), userId);

  // ---- prospect list with the filters the tracker needs
  function prospectList(userId, q) {
    const where = ["p.user_id = ?"], args = [userId], add = (sql, ...a) => { where.push(sql); args.push(...a); };
    if (q.get("campaign")) add("p.campaign_id = ?", +q.get("campaign"));
    if (q.get("status")) add("p.status = ?", q.get("status"));
    if (q.get("channel")) add(q.get("channel") === "none" ? "p.channel = ''" : "p.channel = ?", ...(q.get("channel") === "none" ? [] : [q.get("channel")]));
    if (q.get("source")) add("p.source = ?", q.get("source"));
    if (q.get("category")) add("p.category = ?", q.get("category"));
    if (q.get("city")) add("p.city = ?", q.get("city"));
    if (q.get("minScore")) add("p.score >= ?", +q.get("minScore"));
    if (q.get("hasEmail") === "1") add("p.emails_json != '[]'");
    if (q.get("hasWebsite") === "1") add("p.website != ''");
    if (q.get("enriched") === "1") add("p.enriched_at IS NOT NULL"); if (q.get("enriched") === "0") add("p.enriched_at IS NULL");
    if (q.get("dnc") === "1") add("p.dnc = 1"); else if (q.get("dnc") !== "all") add("p.dnc = 0");
    if (q.get("added")) { const d = q.get("added"); add(d === "old" ? "p.created_at < ?" : "p.created_at >= ?", new Date(Date.now() - (d === "old" ? 21 : +d) * 864e5).toISOString()); }
    if (q.get("hasDraft") === "1") add("EXISTS (SELECT 1 FROM drafts d WHERE d.prospect_id = p.id AND d.status IN ('draft','approved'))");
    if (q.get("q")) for (const t of q.get("q").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6)) add("(lower(p.name) LIKE ? OR lower(p.category) LIKE ? OR lower(p.city) LIKE ? OR lower(p.notes) LIKE ? OR lower(p.website) LIKE ? OR lower(p.emails_json) LIKE ?)", ...Array(6).fill(`%${t}%`));
    const order = { score: "p.score DESC", added: "p.created_at DESC", name: "p.name COLLATE NOCASE ASC", updated: "p.updated_at DESC", status: "CASE p.status WHEN 'Replied' THEN 0 WHEN 'Meeting' THEN 1 WHEN 'Contacted' THEN 2 WHEN 'Approved' THEN 3 WHEN 'Drafted' THEN 4 WHEN 'Found' THEN 5 ELSE 6 END, p.score DESC" }[q.get("sort")] || "p.score DESC";
    const limit = Math.min(Math.max(+q.get("limit") || 50, 1), 200), offset = Math.max(+q.get("offset") || 0, 0), w = where.join(" AND ");
    const rows = db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM facts f WHERE f.prospect_id = p.id) AS n_facts, (SELECT MAX(step) FROM drafts d WHERE d.prospect_id = p.id AND d.status = 'sent') AS last_step,
      (SELECT COUNT(*) FROM drafts d WHERE d.prospect_id = p.id AND d.status IN ('draft','approved')) AS open_drafts FROM prospects p WHERE ${w} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, limit, offset);
    const total = db.prepare(`SELECT COUNT(*) n FROM prospects p WHERE ${w}`).get(...args).n;
    const f = (col) => db.prepare(`SELECT ${col} AS v, COUNT(*) n FROM prospects p WHERE p.user_id = ? ${q.get("campaign") ? "AND p.campaign_id = ?" : ""} AND ${col} != '' GROUP BY 1 ORDER BY n DESC LIMIT 40`).all(userId, ...(q.get("campaign") ? [+q.get("campaign")] : []));
    return { total, prospects: rows.map(core.prospectRow), facets: { status: f("p.status"), channel: f("p.channel"), source: f("p.source"), category: f("p.category"), city: f("p.city") } };
  }
  const detail = (userId, id) => {
    const p = core.getProspect(db, userId, id); if (!p) return null;
    return { ...p, facts: core.factsOf(db, p.id), drafts: db.prepare("SELECT * FROM drafts WHERE prospect_id = ? ORDER BY step, id").all(p.id).map(core.draftRow),
      messages: db.prepare("SELECT ext_id, dir, platform, text, ts, intent FROM messages WHERE prospect_id = ? ORDER BY ts").all(p.id), events: db.prepare("SELECT kind, detail, at FROM events WHERE prospect_id = ? ORDER BY id DESC LIMIT 30").all(p.id) };
  };
  const mailState = userId => {
    const r = db.prepare("SELECT * FROM mail_accounts WHERE user_id = ?").get(userId), providers = Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, { host: v.host, port: v.port, secure: v.secure, help: v.help }]));
    if (!r) return { configured: false, providers };
    return { configured: true, providers, provider: r.provider, user: r.mail_user, host: r.host, port: r.port, secure: !!r.secure, folders: JSON.parse(r.folders_json), last_check: r.last_check, last_result: J(r.last_result, null), last_error: r.last_error };
  };
  let sweeping = false;

  async function api(req, res, url) {
    const method = req.method, p = url.pathname.replace(/\/+$/, "") || "/";
    if (method !== "GET" && method !== "HEAD" && !sameOrigin(req)) throw auth.httpErr(403, "Cross-site request blocked.");
    const token = auth.parseCookies(req.headers.cookie).sid;
    const body = (method === "GET" || method === "HEAD" || method === "DELETE") ? {} : await readBody(req, p === "/api/import" || /\/import$/.test(p) ? 8e6 : 1e6);
    const setSession = userId => { const s = auth.createSession(db, userId); return { "set-cookie": auth.cookie(s.token, s.maxAge, secureCookies) }; };
    let m;

    if (p === "/api/signup" && method === "POST") { const id = auth.signup(db, body.email, body.password); return sendJson(res, 201, { ok: true }, setSession(id)); }
    if (p === "/api/login" && method === "POST") { const id = auth.login(db, body.email, body.password); return sendJson(res, 200, { ok: true }, setSession(id)); }
    if (p === "/api/logout" && method === "POST") { auth.destroySession(db, token); return sendJson(res, 200, { ok: true }, { "set-cookie": auth.cookie("", 0, secureCookies) }); }
    if (p === "/api/meta" && method === "GET") return sendJson(res, 200, { statuses: core.STATUSES, categories: Object.keys(OSM_CATEGORIES), followUpDays: core.FOLLOW_UP_DAYS });
    const user = auth.userFromToken(db, token);
    if (!user) throw auth.httpErr(401, "Sign in first.");
    const uid = user.id;

    if (p === "/api/me" && method === "GET") return sendJson(res, 200, { user, ai: !!getSetting(uid, "ai"), campaigns: db.prepare("SELECT COUNT(*) n FROM campaigns WHERE user_id = ?").get(uid).n });

    // ---- campaigns
    if (p === "/api/campaigns" && method === "GET") {
      const rows = db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM prospects p WHERE p.campaign_id = c.id) AS prospects, (SELECT COUNT(*) FROM prospects p WHERE p.campaign_id = c.id AND p.status IN ('Contacted','Replied','Meeting','Won')) AS contacted,
        (SELECT COUNT(*) FROM prospects p WHERE p.campaign_id = c.id AND p.status IN ('Replied','Meeting','Won')) AS replied FROM campaigns c WHERE c.user_id = ? ORDER BY c.id DESC`).all(uid);
      return sendJson(res, 200, { campaigns: rows.map(core.campaignRow) });
    }
    if (p === "/api/campaigns" && method === "POST") return sendJson(res, 201, { id: core.createCampaign(db, uid, body) });
    if ((m = p.match(/^\/api\/campaigns\/(\d+)$/))) {
      const c = core.getCampaign(db, uid, m[1]); if (!c) throw auth.httpErr(404, "Campaign not found.");
      if (method === "GET") return sendJson(res, 200, c);
      if (method === "PATCH") {
        const next = { name: body.name ?? c.name, vertical: body.vertical ?? c.vertical, place: body.place ?? c.place, language: body.language ?? c.language, status: ["active", "paused", "done"].includes(body.status) ? body.status : c.status,
          persona: "persona" in body ? core.cleanPersona(body.persona) : c.persona, filters: "filters" in body ? core.cleanFilters(body.filters) : c.filters };
        db.prepare("UPDATE campaigns SET name = ?, vertical = ?, place = ?, language = ?, status = ?, persona_json = ?, filters_json = ?, updated_at = ? WHERE id = ?")
          .run(cap(next.name, 120), cap(next.vertical, 120), cap(next.place, 160), ["it", "en"].includes(next.language) ? next.language : "en", next.status, JSON.stringify(next.persona), JSON.stringify(next.filters), now(), c.id);
        return sendJson(res, 200, core.getCampaign(db, uid, c.id));
      }
      if (method === "DELETE") { db.prepare("DELETE FROM campaigns WHERE id = ?").run(c.id); return sendJson(res, 200, { ok: true }); }
    }
    if ((m = p.match(/^\/api\/campaigns\/(\d+)\/sweep$/)) && method === "POST") {
      if (!core.getCampaign(db, uid, m[1])) throw auth.httpErr(404, "Campaign not found.");
      const places = (Array.isArray(body.places) ? body.places : String(body.places || "").split(",")).map(s => cap(s, 80).trim()).filter(Boolean).slice(0, 40);
      if (!places.length || !body.category) throw auth.httpErr(400, "Give a category and at least one place.");
      try { selectorsFor(body.category); } catch (e) { throw auth.httpErr(400, e.message); }
      if (sweeping) throw auth.httpErr(409, "A sweep is already running.");
      sweeping = true;
      try { return sendJson(res, 200, await core.runOsmSweep(db, uid, +m[1], { category: body.category, places }, osmFetch)); }
      catch (e) { throw auth.httpErr(400, e.message); } finally { sweeping = false; }
    }
    if ((m = p.match(/^\/api\/campaigns\/(\d+)\/import$/)) && method === "POST") {
      if (!core.getCampaign(db, uid, m[1])) throw auth.httpErr(404, "Campaign not found.");
      const list = body.csv ? parseProspectCsv(String(body.csv), body.source === "gmaps" ? "gosom" : "csv") : Array.isArray(body.prospects) ? body.prospects : [];
      if (!list.length) throw auth.httpErr(400, "Nothing to import: paste CSV text with a header row.");
      return sendJson(res, 200, { parsed: list.length, ...core.addProspects(db, uid, +m[1], list.slice(0, 5000), { applyFilter: body.applyFilter !== false }) });
    }

    // ---- prospects
    if (p === "/api/prospects" && method === "GET") return sendJson(res, 200, prospectList(uid, url.searchParams));
    if (p === "/api/prospects/bulk" && method === "POST") {
      const ids = (Array.isArray(body.ids) ? body.ids : []).map(Number).filter(Number.isInteger).slice(0, 500); let n = 0;
      if (body.action === "status") { if (!core.STATUSES.includes(body.status)) throw auth.httpErr(400, "Unknown status."); for (const id of ids) n += Number(db.prepare("UPDATE prospects SET status = ?, updated_at = ? WHERE id = ? AND user_id = ? AND dnc = 0").run(body.status, now(), id, uid).changes); }
      else if (body.action === "dnc") for (const id of ids) { try { core.setDoNotContact(db, uid, id, cap(body.reason, 120) || "excluded by you"); n++; } catch { /* not yours */ } }
      else if (body.action === "enrich") for (const id of ids.slice(0, 40)) { try { await core.enrichStored(db, uid, id, siteFetch); n++; } catch { /* keep going */ } }
      else throw auth.httpErr(400, "Unknown action.");
      return sendJson(res, 200, { updated: n });
    }
    if ((m = p.match(/^\/api\/prospects\/(\d+)$/))) {
      const d = detail(uid, m[1]); if (!d) throw auth.httpErr(404, "Prospect not found.");
      if (method === "GET") return sendJson(res, 200, d);
      if (method === "PATCH") {
        const set = [], a = [];
        if ("status" in body) { if (!core.STATUSES.includes(body.status)) throw auth.httpErr(400, "Unknown status."); if (d.dnc) throw auth.httpErr(409, "On the do-not-contact list."); set.push("status = ?"); a.push(body.status); }
        if ("notes" in body) { set.push("notes = ?"); a.push(cap(body.notes, 4000)); }
        for (const [k, n] of Object.entries({ name: 160, category: 100, website: 300, address: 240, city: 80 })) if (k in body) { set.push(`${k} = ?`); a.push(cap(body[k], n)); }
        if ("emails" in body && Array.isArray(body.emails)) { set.push("emails_json = ?"); a.push(JSON.stringify(body.emails.map(e => cap(e, 200).toLowerCase()).filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)).slice(0, 5))); }
        if (set.length) db.prepare(`UPDATE prospects SET ${set.join(", ")}, updated_at = ? WHERE id = ?`).run(...a, now(), d.id);
        return sendJson(res, 200, detail(uid, d.id));
      }
      if (method === "DELETE") { db.prepare("DELETE FROM prospects WHERE id = ?").run(d.id); return sendJson(res, 200, { ok: true }); }
    }
    if ((m = p.match(/^\/api\/prospects\/(\d+)\/(enrich|dnc|allow|reply)$/)) && method === "POST") {
      if (!core.getProspect(db, uid, m[1])) throw auth.httpErr(404, "Prospect not found.");
      if (m[2] === "enrich") return sendJson(res, 200, await core.enrichStored(db, uid, +m[1], siteFetch));
      if (m[2] === "dnc") { core.setDoNotContact(db, uid, +m[1], cap(body.reason, 120) || "excluded by you"); return sendJson(res, 200, { ok: true }); }
      if (m[2] === "allow") { core.allowContactAgain(db, uid, +m[1]); return sendJson(res, 200, { ok: true }); }
      if (!body.text) throw auth.httpErr(400, "Paste the reply text.");
      return sendJson(res, 200, processIncoming(db, uid, { prospectId: +m[1], extId: `manual-${Date.now()}`, text: String(body.text), platform: cap(body.platform, 20) || "manual" }));
    }

    // ---- drafts, the outbox, follow-ups
    if (p === "/api/drafts" && method === "GET") {
      const st = url.searchParams.get("status"), camp = url.searchParams.get("campaign");
      const rows = db.prepare(`SELECT d.*, p.name AS prospect_name, p.channel, p.emails_json, p.phones_json, p.socials_json, p.campaign_id, p.city, p.category FROM drafts d JOIN prospects p ON p.id = d.prospect_id
        WHERE d.user_id = ? ${st ? "AND d.status = ?" : "AND d.status IN ('draft','approved')"} ${camp ? "AND p.campaign_id = ?" : ""} ORDER BY d.updated_at DESC LIMIT 300`).all(...[uid, st, camp && +camp].filter(x => x != null));
      return sendJson(res, 200, { drafts: rows.map(r => ({ ...core.draftRow(r), emails: J(r.emails_json, []), phones: J(r.phones_json, []), socials: J(r.socials_json, {}) })) });
    }
    if (p === "/api/followups" && method === "GET") return sendJson(res, 200, { due: core.followUpsDue(db, uid) });
    if (p === "/api/lint" && method === "POST") {
      const pr = core.getProspect(db, uid, body.prospectId); const c = pr && core.getCampaign(db, uid, pr.campaign_id);
      return sendJson(res, 200, lintDraft({ subject: body.subject, body: body.body, step: +body.step || 1, persona: c?.persona || {}, facts: pr ? core.factsOf(db, pr.id) : [], prospect: pr || {} }));
    }
    if (p === "/api/drafts" && method === "POST") {
      const pr = core.getProspect(db, uid, body.prospectId); if (!pr) throw auth.httpErr(404, "Prospect not found.");
      const c = core.getCampaign(db, uid, pr.campaign_id), step = Math.min(Math.max(+body.step || 1, 1), core.MAX_STEP), facts = core.factsOf(db, pr.id);
      let draft = { subject: body.subject || "", body: body.body || "", angle: body.angle || "", ai: false };
      if (body.mode === "skeleton") draft = { ...skeleton({ step, lang: c.language, fact: observationCandidates(facts)[0], persona: c.persona }), angle: body.angle || "", ai: false };
      if (body.mode === "ai") {
        const cfg = aiConfigFor(uid); if (!cfg) throw auth.httpErr(400, "Set up an AI provider in Settings first (a local Ollama model needs no key), or write the message yourself.");
        try { const r = await aiDraft(cfg, { step, lang: c.language, prospect: pr, facts, persona: c.persona, angle: body.angle }, aiFetch); draft = { subject: r.subject, body: r.body, angle: body.angle || "", ai: true }; }
        catch (e) { throw auth.httpErr(502, e.message); }
      }
      return sendJson(res, 201, { id: core.createDraft(db, uid, { prospectId: pr.id, step, ...draft }) });
    }
    if ((m = p.match(/^\/api\/drafts\/(\d+)$/))) {
      if (method === "GET") { const d = core.getDraft(db, uid, m[1]); if (!d) throw auth.httpErr(404, "Draft not found."); return sendJson(res, 200, d); }
      if (method === "PATCH") return sendJson(res, 200, core.updateDraft(db, uid, m[1], body));
    }
    if ((m = p.match(/^\/api\/drafts\/(\d+)\/(approve|discard|sent)$/)) && method === "POST") {
      if (m[2] === "approve") return sendJson(res, 200, core.approveDraft(db, uid, m[1]));
      if (m[2] === "discard") { core.discardDraft(db, uid, m[1]); return sendJson(res, 200, { ok: true }); }
      return sendJson(res, 200, core.markSent(db, uid, m[1]));
    }

    // ---- dashboard, saved views
    if (p === "/api/insights" && method === "GET") return sendJson(res, 200, core.insights(db, uid, { campaignId: +url.searchParams.get("campaign") || null, days: Math.min(Math.max(+url.searchParams.get("days") || 30, 7), 180) }));
    if (p === "/api/views" && method === "GET") return sendJson(res, 200, { views: J(getSetting(uid, "views"), {}) });
    if (p === "/api/views" && method === "PUT") {
      const views = {}; for (const [k, v] of Object.entries(body.views || {}).slice(0, 30)) if (v && typeof v === "object") views[cap(k, 60)] = v;
      putSetting(uid, "views", JSON.stringify(views)); return sendJson(res, 200, { views });
    }

    // ---- settings: mailbox for replies, optional AI
    if (p === "/api/mail" && method === "GET") return sendJson(res, 200, mailState(uid));
    if (p === "/api/mail" && method === "PUT") {
      const prev = db.prepare("SELECT pass_enc FROM mail_accounts WHERE user_id = ?").get(uid), a = accountFromInput(body, encrypt), pass = a.pass || prev?.pass_enc;
      if (!pass) throw auth.httpErr(400, "Enter the app password.");
      db.prepare(`INSERT INTO mail_accounts (user_id, provider, mail_user, pass_enc, host, port, secure, folders_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET provider = excluded.provider, mail_user = excluded.mail_user, pass_enc = excluded.pass_enc, host = excluded.host, port = excluded.port, secure = excluded.secure, folders_json = excluded.folders_json, last_error = NULL`)
        .run(uid, a.provider, a.mail_user, pass, a.host, a.port, a.secure, JSON.stringify(a.folders));
      return sendJson(res, 200, mailState(uid));
    }
    if (p === "/api/mail" && method === "DELETE") { db.prepare("DELETE FROM mail_accounts WHERE user_id = ?").run(uid); return sendJson(res, 200, { ok: true }); }
    if (p === "/api/mail/test" && method === "POST") {
      const row = db.prepare("SELECT * FROM mail_accounts WHERE user_id = ?").get(uid); if (!row) throw auth.httpErr(400, "Save the mailbox settings first.");
      try { return sendJson(res, 200, { ok: true, folders: await testLogin(accountConfig(row)) }); } catch (e) { throw auth.httpErr(502, e.message); }
    }
    if (p === "/api/mail/check" && method === "POST") {
      const r = await checkReplies(db, uid, { days: Math.min(Math.max(+body.days || 3, 1), 90) });
      if (!r.configured) throw auth.httpErr(400, "Connect a mailbox first."); if (r.error) throw auth.httpErr(502, r.error);
      return sendJson(res, 200, r);
    }
    if (p === "/api/settings" && method === "GET") { const ai = getSetting(uid, "ai"); return sendJson(res, 200, { ai: ai ? { ...JSON.parse(ai), hasKey: !!getSetting(uid, "ai_key") } : null, aiProviders: AI_PROVIDERS }); }
    if (p === "/api/settings" && method === "PUT") {
      if ("ai" in body) {
        if (!body.ai || !body.ai.provider) { putSetting(uid, "ai", null); putSetting(uid, "ai_key", null); }
        else { const cfg = aiConfigFromInput(body.ai); if (!cfg) throw auth.httpErr(400, "Unknown AI provider."); putSetting(uid, "ai", JSON.stringify(cfg)); if (body.ai.apiKey) putSetting(uid, "ai_key", encrypt(String(body.ai.apiKey).trim())); }
      }
      return sendJson(res, 200, { ok: true });
    }
    if (p === "/api/ai/models" && method === "GET") { try { return sendJson(res, 200, { models: await ollamaModels(url.searchParams.get("baseUrl") || undefined) }); } catch { throw auth.httpErr(502, "Could not reach Ollama. Is it running?"); } }
    if (p === "/api/export" && method === "GET") {
      const out = { exported_at: now(), campaigns: db.prepare("SELECT * FROM campaigns WHERE user_id = ?").all(uid), prospects: db.prepare("SELECT * FROM prospects WHERE user_id = ?").all(uid), drafts: db.prepare("SELECT * FROM drafts WHERE user_id = ?").all(uid),
        messages: db.prepare("SELECT m.* FROM messages m JOIN prospects p ON p.id = m.prospect_id WHERE p.user_id = ?").all(uid), suppressions: db.prepare("SELECT * FROM suppressions WHERE user_id = ?").all(uid), events: db.prepare("SELECT * FROM events WHERE user_id = ?").all(uid) };
      return sendJson(res, 200, out, { "content-disposition": 'attachment; filename="coldbrew-data.json"' });
    }
    if (p === "/api/account/delete" && method === "POST") {
      const row = db.prepare("SELECT pass_hash FROM users WHERE id = ?").get(uid);
      if (!auth.verifyPassword(String(body.password || ""), row.pass_hash)) throw auth.httpErr(403, "Wrong password.");
      auth.deleteAccount(db, uid); return sendJson(res, 200, { ok: true }, { "set-cookie": auth.cookie("", 0, secureCookies) });
    }
    throw auth.httpErr(404, "Not found.");
  }

  return async (req, res) => {
    const url = new URL(req.url, "http://x");
    try {
      if (url.pathname.startsWith("/api/")) return await api(req, res, url);
      if (req.method !== "GET" && req.method !== "HEAD") throw auth.httpErr(405, "Method not allowed.");
      const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, ""), file = path.resolve(PUBLIC, rel);
      if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) throw auth.httpErr(404, "Not found.");
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "x-content-type-options": "nosniff", "referrer-policy": "same-origin",
        "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'" });
      res.end(fs.readFileSync(file));
    } catch (e) {
      const status = e.status || 500; if (status === 500) console.error(e);
      sendJson(res, status, { error: status === 500 ? "Something went wrong." : e.message });
    }
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const db = openDb(process.env.DB_FILE || path.resolve("data/app.db")), port = +process.env.PORT || 7679;
  http.createServer(createApp(db, { secureCookies: process.env.SECURE_COOKIES === "1" })).listen(port, "127.0.0.1", () => console.log(`http://localhost:${port}`));
  if (process.env.NO_SCHEDULER !== "1") import("./scheduler.mjs").then(s => s.startScheduler(db));
}
