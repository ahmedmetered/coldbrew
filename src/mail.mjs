// Reads one mailbox (IMAP, READ-ONLY) and hands each reply from a known prospect to replies.mjs.
// imapflow and mailparser are optional dependencies: without them the rest of the app still works.
// Nothing is flagged, moved, deleted or sent. Mail from people who are not prospects is ignored.
import { now } from "./db.mjs";
import { decrypt } from "./secrets.mjs";
import { PROVIDERS, detectProvider, cleanBody } from "./mailutil.mjs";
import { matchProspect, processIncoming } from "./replies.mjs";

const clip = (s, n) => String(s ?? "").slice(0, n);
export { PROVIDERS, detectProvider };

export function accountConfig(row) {
  return { provider: row.provider, user: row.mail_user, password: decrypt(row.pass_enc), host: row.host, port: row.port, secure: !!row.secure, folders: JSON.parse(row.folders_json || '["INBOX"]') };
}
export function accountFromInput(input, encrypt) {
  const user = clip(input.user, 200).trim(), provider = PROVIDERS[input.provider] ? input.provider : detectProvider(user), preset = PROVIDERS[provider], host = clip(input.host || preset.host, 200).trim();
  if (!user || !user.includes("@")) throw Object.assign(new Error("Enter the full email address."), { status: 400 });
  if (!host) throw Object.assign(new Error("This provider needs an IMAP host."), { status: 400 });
  const list = (Array.isArray(input.folders) ? input.folders : String(input.folders || "").split(",")).map(s => clip(s, 80).trim()).filter(Boolean).slice(0, 20);
  return { provider, mail_user: user, host, port: Math.max(1, Math.min(65535, +(input.port || preset.port) || 993)), secure: (input.secure ?? preset.secure) ? 1 : 0, folders: list.length ? list : ["INBOX"], pass: input.password ? encrypt(String(input.password).trim()) : null };
}

async function connect(cfg) {
  let ImapFlow;
  try { ({ ImapFlow } = await import("imapflow")); } catch { throw new Error("Reading replies needs two optional packages. Run: npm install"); }
  const open = async user => { const c = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: { user, pass: cfg.password }, logger: false }); await c.connect(); return c; };
  try { return await open(cfg.user); }
  catch (e) { try { return await open(cfg.user.split("@")[0]); } catch { throw new Error(`Login failed on ${cfg.host}: ${e.message}. ${PROVIDERS[cfg.provider]?.help || ""}`.trim()); } } // some providers want only the part before the @
}
export async function testLogin(cfg) { const c = await connect(cfg); try { return (await c.list()).map(b => b.path); } finally { await c.logout().catch(() => {}); } }

export async function checkReplies(db, userId, { days = 3, log = () => {} } = {}) {
  const row = db.prepare("SELECT * FROM mail_accounts WHERE user_id = ?").get(userId);
  if (!row) return { configured: false };
  const cfg = accountConfig(row), me = cfg.user.toLowerCase(), res = { configured: true, scanned: 0, replies: 0, excluded: 0, attention: 0 };
  let client;
  try {
    client = await connect(cfg);
    const { simpleParser } = await import("mailparser");
    const since = new Date(Date.now() - days * 864e5), seen = db.prepare("SELECT 1 FROM messages WHERE ext_id = ?");
    for (const box of cfg.folders) {
      const lock = await client.getMailboxLock(box, { readOnly: true });
      try {
        const uids = await client.search({ since }, { uid: true }); if (!(uids || []).length) continue;
        for await (const msg of client.fetch(uids, { source: true, uid: true }, { uid: true })) {
          if (!msg.source || msg.source.length > 3e6) continue;
          const mail = await simpleParser(msg.source), from = (mail.from?.value?.[0]?.address || "").toLowerCase();
          if (!from || from === me) continue;
          const id = mail.messageId || `${box}:${msg.uid}`; if (seen.get(id)) continue; res.scanned++;
          const pid = matchProspect(db, userId, from); if (!pid) continue;
          const r = processIncoming(db, userId, { prospectId: pid, extId: id, text: cleanBody({ text: mail.text, html: mail.html }), ts: (mail.date || new Date()).toISOString() });
          if (r.outcome === "replied" || r.outcome === "lost") res.replies++; if (r.outcome === "excluded") res.excluded++; if (r.attention) res.attention++;
        }
      } finally { lock.release(); }
    }
    await client.logout().catch(() => {});
    db.prepare("UPDATE mail_accounts SET last_check = ?, last_result = ?, last_error = NULL WHERE user_id = ?").run(now(), JSON.stringify(res), userId);
    return res;
  } catch (e) {
    try { await client?.logout(); } catch { /* ignore */ }
    db.prepare("UPDATE mail_accounts SET last_check = ?, last_error = ? WHERE user_id = ?").run(now(), e.message, userId);
    return { ...res, error: e.message };
  }
}
