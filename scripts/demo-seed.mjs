// Fills a database with SYNTHETIC demo data (made-up businesses, drafts and replies) so the interface and the charts can be tried.
// Run: DB_FILE=data/demo.db node scripts/demo-seed.mjs   then   DB_FILE=data/demo.db npm start   (login: demo@example.com / demo-password-123)
import { openDb } from "../src/db.mjs";
import { signup } from "../src/auth.mjs";
import * as core from "../src/core.mjs";

const db = openDb(process.env.DB_FILE || "data/demo.db");
if (db.prepare("SELECT 1 FROM users WHERE email = 'demo@example.com'").get()) { console.log("demo data already there"); process.exit(0); }
const uid = signup(db, "demo@example.com", "demo-password-123");
let seed = 7; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296, pick = a => a[Math.floor(rnd() * a.length)];
const day = n => new Date(Date.now() - n * 864e5).toISOString();

const persona = { sender: "Ahmed", company: "Demo Studio", product: "Mimo", offer: "Online booking for small clinics (demo)", icp: "independent clinics with 2 to 10 staff and no online booking",
  claims: ["manages bookings for 12 clinics"], optout: "Se preferisci non ricevere altri messaggi, basta dirmelo.", icpRules: { noBooking: true } };
const camp = core.createCampaign(db, uid, { name: "Dentisti Milano (demo)", vertical: "dentisti", place: "Milano e hinterland", language: "it", persona, filters: { keep: "dent|odont", drop: "supermercato" } });
const camp2 = core.createCampaign(db, uid, { name: "Fisioterapisti Milano (demo)", vertical: "fisioterapisti", place: "Milano", language: "it", persona, filters: { keep: "fisio" } });

const surnames = ["Rossi", "Bianchi", "Verdi", "Ferrari", "Esposito", "Romano", "Colombo", "Ricci", "Marino", "Greco", "Bruno", "Gallo", "Conti", "De Luca", "Mancini", "Costa", "Giordano", "Rizzo", "Lombardi", "Moretti"];
const cities = ["Milano", "Milano", "Milano", "Monza", "Sesto San Giovanni", "Rho", "Legnano", "Cinisello Balsamo", "Assago"];
const sources = ["osm", "osm", "gmaps", "csv"];
const prospects = [];
for (let i = 0; i < 64; i++) {
  const name = `Studio ${pick(surnames)} ${i + 1}`, dom = `demo-${i + 1}.example`, hasWeb = rnd() > 0.2, hasMail = hasWeb && rnd() > 0.35, ig = rnd() > 0.6;
  prospects.push({ name, category: i % 9 === 0 ? "Odontoiatra" : "Dentista", city: pick(cities), address: `Via Demo ${i + 1}`, website: hasWeb ? `https://${dom}` : "", emails: hasMail ? [`info@${dom}`] : [], phones: [`02 ${100000 + i * 37}`],
    socials: ig ? { instagram: `https://instagram.com/demo${i + 1}` } : {}, source: pick(sources), source_id: `demo/${i + 1}`, rating: +(3.6 + rnd() * 1.4).toFixed(1), reviews: Math.floor(rnd() * 220) });
}
core.addProspects(db, uid, camp, prospects, { applyFilter: false });
const ids = db.prepare("SELECT id, emails_json, website FROM prospects WHERE campaign_id = ? ORDER BY id").all(camp);

const FACTS = ["Urgenze anche la domenica mattina, chiamare il numero in basso.", "Studio odontoiatrico a conduzione familiare dal 1998.", "Prenotazioni solo telefoniche, dal lunedì al venerdì.", "Parcheggio riservato ai pazienti nel cortile interno.", "Ortodonzia invisibile e sbiancamento in giornata."];
const insFact = db.prepare("INSERT OR IGNORE INTO facts (prospect_id, kind, text, source_url, fetched_at) VALUES (?, ?, ?, ?, ?)");
for (const r of ids) if (r.website && rnd() > 0.25) { for (const f of [pick(FACTS), pick(FACTS)]) insFact.run(r.id, "site", f, r.website, day(Math.floor(rnd() * 25))); db.prepare("UPDATE prospects SET enriched_at = ? WHERE id = ?").run(day(Math.floor(rnd() * 25)), r.id); }

const angles = ["urgenze", "orari", "prenotazioni", "parcheggio"];
const GOOD = (a, n) => ({ subject: `${a} dello studio`, body: `Il vostro sito parla di ${a} (${n}). Come funziona per chi vi scrive fuori orario?\n\n${persona.optout}` });
const insDraft = db.prepare("INSERT INTO drafts (user_id, prospect_id, step, subject, body, angle, status, lint_json, ai, created_at, updated_at, approved_at, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?)");
const ev = db.prepare("INSERT INTO events (user_id, prospect_id, draft_id, kind, detail, at) VALUES (?, ?, ?, ?, '', ?)");
const msg = db.prepare("INSERT OR IGNORE INTO messages (prospect_id, ext_id, dir, platform, text, ts, intent) VALUES (?, ?, 'in', 'email', ?, ?, ?)");
const REPLIES = [["interested", "Sì, volentieri, ci racconta come funziona?"], ["question", "Quanto tempo serve per attivarlo?"], ["objection", "Per ora abbiamo già un gestionale."], ["not_interested", "No grazie, non ci interessa."], ["wrong_person", "Scriva alla dott.ssa Conti."], ["interested", "Interessante, ne parliamo giovedì?"]];
let k = 0;
for (const r of ids) {
  k++; const sentDaysAgo = 2 + Math.floor(rnd() * 26), angle = pick(angles); if (!r.emails_json || r.emails_json === "[]" || rnd() < 0.35) continue;
  const g = GOOD(angle, "demo"), step = rnd() > 0.7 ? 2 : 1;
  const mk = (st, daysAgo, status) => { const d = Number(insDraft.run(uid, r.id, st, g.subject, g.body, angle, status, 0, day(daysAgo + 2), day(daysAgo + 1), status === "draft" ? null : day(daysAgo + 1), status === "sent" ? day(daysAgo) : null).lastInsertRowid); ev.run(uid, r.id, d, "draft_created", day(daysAgo + 2)); if (status !== "draft") ev.run(uid, r.id, d, "approved", day(daysAgo + 1)); if (status === "sent") ev.run(uid, r.id, d, "sent", day(daysAgo)); return d; };
  if (k % 11 === 0) { mk(1, 0, "draft"); db.prepare("UPDATE prospects SET status = 'Drafted' WHERE id = ?").run(r.id); continue; }
  if (k % 13 === 0) { mk(1, 0, "approved"); db.prepare("UPDATE prospects SET status = 'Approved' WHERE id = ?").run(r.id); continue; }
  mk(1, sentDaysAgo, "sent"); if (step === 2 && sentDaysAgo > 8) mk(2, sentDaysAgo - 6, "sent");
  db.prepare("UPDATE prospects SET status = 'Contacted' WHERE id = ?").run(r.id);
  if (rnd() < 0.3) { const [intent, text] = pick(REPLIES), when = day(Math.max(0, sentDaysAgo - 1 - Math.floor(rnd() * 5))); msg.run(r.id, `demo-${r.id}`, text, when, intent); ev.run(uid, r.id, null, "reply", when);
    db.prepare("UPDATE prospects SET status = ? WHERE id = ?").run(intent === "not_interested" ? "Lost" : intent === "interested" && rnd() > 0.5 ? "Meeting" : "Replied", r.id); }
}
core.setDoNotContact(db, uid, ids[3].id, "asked by phone not to be contacted"); core.setDoNotContact(db, uid, ids[9].id, "opted out by reply");
db.prepare("INSERT INTO sweeps (campaign_id, source, query, found, added, at) VALUES (?, 'osm', 'dentist in Milano', 118, 41, ?), (?, 'osm', 'dentist in Monza', 36, 12, ?), (?, 'gmaps', 'dentisti Milano.csv', 80, 63, ?)").run(camp, day(20), camp, day(19), camp, day(18));
console.log("demo ready:", db.prepare("SELECT COUNT(*) n FROM prospects").get().n, "prospects; login demo@example.com / demo-password-123");
