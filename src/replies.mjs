// Reading what comes back. Classifies a reply (Italian and English) and applies the rules from the anydeals method:
//  - opt-out, in any wording: the text is NOT saved, nothing is drafted, the business is excluded for good
//  - angry or legal (a lawyer, a privacy authority, a spam report): kept word for word for you, never answered, excluded for good
//  - not interested: lost for this campaign; one polite later check-in is allowed, nothing else
//  - anything else moves the prospect to Replied and stores the thread
import { now } from "./db.mjs";
import { domainOf } from "./normalize.mjs";
import { setDoNotContact, getProspect } from "./core.mjs";

const RX = {
  auto: /(out of office|fuori sede|fuori ufficio|risposta automatica|auto-?reply|automatic reply|sono assente|vacation reply|non sono in ufficio|delivery status|undeliverable|mailer-daemon)/i,
  optout: /(\bstop\b|\bunsubscribe\b|remove me|take me off|do not (contact|email|write)|don'?t (contact|email|write)|non (scrivermi|contattarmi|contattateci|scrivete|inviatemi|scriverci|contattarci|disturbarci|chiamarci|scriveteci)|cancellami|toglimi|rimuovimi|toglietemi|toglierci|non voglio (più )?ricevere|non desidero (più )?ricevere|smettete di|interrompete|opt[- ]?out|cancellate (il mio|la mia)|non inviate(ci)? (più )?(mail|email|messaggi))/i,
  angry: /(garante|privacy|gdpr|avvocat|legale|denunc|querela|diffida|spam\b|segnalaz|vi segnaler|molestie|harass|lawyer|attorney|legal action|report(ing)? you|sue you|abuse|come (avete|hai) avuto (il mio|la mia)|dove (avete|hai) trovato (il mio|la mia)|how did you get my)/i,
  notInterested: /(non (siamo|sono) interessat|non ci interessa|non mi interessa|no,? grazie|no thanks|not interested|no thank you|non ci serve|non ne abbiamo bisogno|we('re| are) (all )?set|already (have|covered)|già (coperti|a posto|serviti))/i,
  wrongPerson: /(non sono (io )?la persona|non mi occupo|wrong person|not the right person|rivolgiti a|rivolgetevi a|contatta (il|la|l')|scrivi a|per questo (deve|devi) (scrivere|contattare)|forward(ed)? (this )?to|the person you want|è il titolare|ne parli con)/i,
  objection: /(quanto costa|troppo (caro|costos)|prezzo|costo|budget|non abbiamo (tempo|budget)|no budget|too expensive|not now|non è il momento|per ora no|già (usiamo|abbiamo|lavoriamo)|we already use|we use|abbiamo già)/i,
  interested: /(interessat|volentieri|mi (racconti|spieg|dica|dite)|ci racconti|sì|certo|ok\b|va bene|perfetto|yes\b|sure\b|sounds good|tell me more|happy to|let'?s (talk|chat|call)|quando (sei|siete|possiamo)|disponibil|chiamami|call me|mandami|inviami|send (me|over))/i,
};
export function classifyReply(text = "") {
  const t = String(text).slice(0, 4000);
  if (RX.auto.test(t)) return "auto";
  if (RX.optout.test(t)) return "opt_out";
  if (RX.angry.test(t)) return "angry_legal";
  if (RX.notInterested.test(t)) return "not_interested";
  if (RX.wrongPerson.test(t)) return "wrong_person";
  if (RX.objection.test(t)) return "objection";
  if (/\?/.test(t)) return "question";
  if (RX.interested.test(t)) return "interested";
  return "other";
}

// drop what the sender quoted from our own message, signatures and "On ... wrote:" headers, so the reply is just the reply
export function stripQuoted(text) {
  const lines = String(text).replace(/\r\n/g, "\n").split("\n"), out = [];
  for (const l of lines) {
    if (/^\s*>/.test(l)) continue;
    if (/^(on .{5,80} wrote:|il giorno .{5,80} ha scritto:|il .{5,60} ha scritto:|-{2,}\s*(original message|messaggio originale)|from:.{3,}\s*$|da:.{3,}\s*$)/i.test(l.trim())) break;
    out.push(l);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// who wrote? the exact email of a prospect first, then the domain of its own website
export function matchProspect(db, userId, fromEmail) {
  fromEmail = String(fromEmail || "").toLowerCase();
  if (!fromEmail) return null;
  const dom = fromEmail.split("@")[1] || "";
  const rows = db.prepare("SELECT id, emails_json, website, status FROM prospects WHERE user_id = ? AND status != 'Found'").all(userId);
  let byDomain = null;
  for (const r of rows) {
    if (JSON.parse(r.emails_json || "[]").map(e => e.toLowerCase()).includes(fromEmail)) return r.id;
    if (!byDomain && dom && domainOf(r.website) === dom) byDomain = r.id;
  }
  return byDomain;
}

// apply one incoming message to the right prospect. Returns what happened, never throws for "nothing to do".
export function processIncoming(db, userId, { prospectId, extId, text, ts = now(), platform = "email" }) {
  const p = getProspect(db, userId, prospectId); if (!p) return { outcome: "no_prospect" };
  const body = stripQuoted(text), intent = classifyReply(body);
  if (intent === "auto") return { outcome: "ignored", intent };
  const log = (kind, detail) => db.prepare("INSERT INTO events (user_id, prospect_id, kind, detail, at) VALUES (?, ?, ?, ?, ?)").run(userId, p.id, kind, detail, now());
  if (intent === "opt_out") { setDoNotContact(db, userId, p.id, "opted out by reply"); log("opt_out", "a reply asked to stop; the message was not saved"); return { outcome: "excluded", intent }; }
  const saved = db.prepare("INSERT OR IGNORE INTO messages (prospect_id, ext_id, dir, platform, text, ts, intent) VALUES (?, ?, 'in', ?, ?, ?, ?)").run(p.id, String(extId).slice(0, 200), platform, body.slice(0, 4000), ts, intent).changes;
  if (!saved) return { outcome: "duplicate", intent };
  if (intent === "angry_legal") { setDoNotContact(db, userId, p.id, "angry or legal reply: kept as received, never answered"); log("angry_legal", "needs your attention; do not reply"); return { outcome: "excluded", intent, attention: true }; }
  if (intent === "not_interested") { db.prepare("UPDATE prospects SET status = 'Lost', notes = trim(notes || ' one polite later check-in is allowed, nothing else'), updated_at = ? WHERE id = ?").run(now(), p.id); log("not_interested", "lost for this campaign"); return { outcome: "lost", intent }; }
  if (["Contacted", "Approved", "Drafted", "Found"].includes(p.status)) db.prepare("UPDATE prospects SET status = 'Replied', updated_at = ? WHERE id = ?").run(now(), p.id);
  db.prepare("UPDATE drafts SET status = 'discarded', updated_at = ? WHERE prospect_id = ? AND status IN ('draft','approved')").run(now(), p.id); // a reply ends the sequence; open follow-ups would be wrong now
  log("reply", intent);
  return { outcome: "replied", intent };
}
