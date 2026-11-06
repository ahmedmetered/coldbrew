// Checks the mailbox for replies while the server is up, so nothing needs cron or Task Scheduler.
import { checkReplies } from "./mail.mjs";
import { checkInstagram } from "./instagram.mjs";
import { runDigestIfDue } from "./digest.mjs";

export function startScheduler(db, { log = console.log, everyMinutes = 15 } = {}) {
  let busy = false;
  const tick = async () => {
    if (busy) return; busy = true;
    try {
      for (const m of db.prepare("SELECT user_id, last_check FROM mail_accounts").all()) {
        if (m.last_check && Date.now() - new Date(m.last_check).getTime() < everyMinutes * 60000) continue;
        const r = await checkReplies(db, m.user_id, { days: 3 });
        if (r.error) log(`scheduler: mail for user ${m.user_id}: ${r.error}`); else if (r.replies || r.excluded) log(`scheduler: ${r.replies} repl(ies), ${r.excluded} excluded`);
      }
      for (const s of db.prepare("SELECT user_id, last_check FROM social_accounts WHERE platform = 'instagram'").all()) { // nothing here runs until Instagram has been connected
        if (s.last_check && Date.now() - new Date(s.last_check).getTime() < everyMinutes * 60000) continue;
        const r = await checkInstagram(db, s.user_id, { days: 3 });
        if (r.error) log(`scheduler: instagram for user ${s.user_id}: ${r.error}`); else if (r.replies || r.excluded) log(`scheduler: instagram ${r.replies} repl(ies), ${r.excluded} excluded`);
      }
      for (const u of db.prepare("SELECT id FROM users").all()) await runDigestIfDue(db, u.id, { log });
    } catch (e) { log("scheduler error: " + e.message); } finally { busy = false; }
  };
  const timer = setInterval(tick, 60000); timer.unref?.();
  setTimeout(tick, 5000).unref?.();
  return () => clearInterval(timer);
}
