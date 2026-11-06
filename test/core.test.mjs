import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.mjs";
import { signup } from "../src/auth.mjs";
import * as core from "../src/core.mjs";
import { aiDraft, skeleton, parseModelDraft, observationCandidates } from "../src/draft.mjs";

const PERSONA = { sender: "Ahmed", product: "Mimo", optout: "Se preferisci non ricevere altri messaggi, basta dirmelo.", claims: ["gestisce le prenotazioni di 12 cliniche"], icpRules: { noBooking: true } };
function setup() {
  const db = openDb(":memory:"), uid = signup(db, "a@example.com", "correct horse battery");
  const cid = core.createCampaign(db, uid, { name: "Dentisti Milano", vertical: "dentisti", place: "Milano", language: "it", persona: PERSONA, filters: { keep: "dent|odont", drop: "supermercato" } });
  return { db, uid, cid };
}
const P = (o = {}) => ({ name: "Studio Rossi", category: "Dentista", city: "Milano", website: "https://rossi.it", emails: ["info@rossi.it"], phones: ["02 123456"], socials: {}, source: "osm", source_id: "node/1", ...o });
const GOOD = { subject: "urgenze della domenica", body: "Il vostro sito dice che le urgenze della domenica mattina vanno chiamate al numero in basso. Quel numero arriva a chi è di turno o direttamente a voi?\n\n" + PERSONA.optout };

test("prospects are filtered, deduplicated, merged and scored when added", () => {
  const { db, uid, cid } = setup();
  const r = core.addProspects(db, uid, cid, [P(), P({ name: "Studio Rossi Milano", source_id: "node/1", emails: ["segreteria@rossi.it"], reviews: 80 }), { name: "Esselunga", category: "Supermercato", source: "osm", source_id: "node/9" }, P({ name: "Bar X", category: "Bar", source_id: "node/3" })]);
  assert.deepEqual([r.added, r.merged, r.filtered], [1, 1, 2]);
  const p = core.getProspect(db, uid, 1); assert.deepEqual(p.emails, ["info@rossi.it", "segreteria@rossi.it"]); assert.equal(p.reviews, 80); assert.equal(p.channel, "email"); assert.ok(p.score > 50);
});

test("the do-not-contact list blocks prospects, drafts and approvals, and sticks across campaigns", () => {
  const { db, uid, cid } = setup();
  core.addProspects(db, uid, cid, [P()]);
  const draftId = core.createDraft(db, uid, { prospectId: 1, step: 1, ...GOOD });
  core.setDoNotContact(db, uid, 1, "wrote back: remove me");
  const p = core.getProspect(db, uid, 1); assert.equal(p.dnc, true); assert.equal(p.status, "Lost"); assert.equal(p.score, 0);
  assert.equal(core.getDraft(db, uid, draftId).status, "discarded");
  assert.throws(() => core.createDraft(db, uid, { prospectId: 1, step: 1, ...GOOD }), /do-not-contact/);
  assert.throws(() => core.approveDraft(db, uid, draftId), /not|discarded/);
  const cid2 = core.createCampaign(db, uid, { name: "Altro", persona: PERSONA });
  const again = core.addProspects(db, uid, cid2, [P({ name: "Rossi Dental", source_id: "node/77", emails: ["info@rossi.it"] })], { applyFilter: false });
  assert.equal(again.suppressed, 1); assert.equal(core.getProspect(db, uid, 2).dnc, true, "same email in another campaign stays blocked");
  core.allowContactAgain(db, uid, 1); assert.equal(core.getProspect(db, uid, 1).dnc, false);
});

test("approval needs a clean lint; editing an approved draft withdraws the approval; sent only after approval", () => {
  const { db, uid, cid } = setup();
  core.addProspects(db, uid, cid, [P()]);
  const id = core.createDraft(db, uid, { prospectId: 1, step: 1, subject: "Quick Question!", body: "We offer a free tool." });
  assert.ok(core.getDraft(db, uid, id).lint.issues.length > 0);
  assert.throws(() => core.approveDraft(db, uid, id), /Fix this first/);
  core.updateDraft(db, uid, id, GOOD);
  assert.equal(core.approveDraft(db, uid, id).status, "approved"); assert.equal(core.getProspect(db, uid, 1).status, "Approved");
  const edited = core.updateDraft(db, uid, id, { body: GOOD.body + " Aggiungo una frase." });
  assert.equal(edited.status, "draft", "what is sent must be what you approved");
  assert.throws(() => core.markSent(db, uid, id), /approved/);
  core.approveDraft(db, uid, id); const sent = core.markSent(db, uid, id);
  assert.equal(sent.status, "sent"); assert.equal(core.getProspect(db, uid, 1).status, "Contacted");
  const kinds = db.prepare("SELECT kind FROM events WHERE draft_id = ? ORDER BY id").all(id).map(e => e.kind);
  assert.deepEqual(kinds, ["draft_created", "draft_edited", "approved", "approval_withdrawn_by_edit", "approved", "sent"]);
  assert.throws(() => core.createDraft(db, uid, { prospectId: 1, step: 1, ...GOOD }), /already sent/);
});

test("follow-ups come due on schedule, only for people who have not answered", () => {
  const { db, uid, cid } = setup();
  core.addProspects(db, uid, cid, [P(), P({ name: "Studio Verdi", source_id: "node/2", emails: ["a@verdi.it"], website: "https://verdi.it", phones: [] })]);
  for (const pid of [1, 2]) { const id = core.createDraft(db, uid, { prospectId: pid, step: 1, ...GOOD }); core.approveDraft(db, uid, id); core.markSent(db, uid, id, new Date(Date.now() - 6 * 864e5).toISOString()); }
  assert.deepEqual(core.followUpsDue(db, uid).map(f => [f.name, f.next_step]), [["Studio Rossi", 2], ["Studio Verdi", 2]]);
  assert.equal(core.followUpsDue(db, uid, Date.now() - 3 * 864e5).length, 0, "not yet due three days ago");
  db.prepare("INSERT INTO messages (prospect_id, ext_id, dir, platform, text, ts) VALUES (2, 'm1', 'in', 'email', 'ciao', ?)").run(new Date().toISOString());
  assert.deepEqual(core.followUpsDue(db, uid).map(f => f.name), ["Studio Rossi"]);
});

test("the dashboard numbers add up", () => {
  const { db, uid, cid } = setup();
  core.addProspects(db, uid, cid, [P(), P({ name: "Studio Verdi", source_id: "node/2", emails: ["a@verdi.it"], website: "https://verdi.it", phones: [] })]);
  for (const pid of [1, 2]) { const id = core.createDraft(db, uid, { prospectId: pid, step: 1, ...GOOD, angle: pid === 1 ? "urgenze" : "orari" }); core.approveDraft(db, uid, id); core.markSent(db, uid, id, new Date(Date.now() - 2 * 864e5).toISOString()); }
  db.prepare("INSERT INTO messages (prospect_id, ext_id, dir, platform, text, ts, intent) VALUES (1, 'm1', 'in', 'email', 'ok', ?, 'interested')").run(new Date().toISOString());
  const i = core.insights(db, uid, { days: 14 });
  assert.equal(i.total, 2); assert.equal(i.funnel.Contacted, 2); assert.equal(i.prospectsSent, 2); assert.equal(i.replied, 1); assert.equal(i.replyRate, 50);
  assert.equal(i.series.length, 14); assert.equal(i.series.reduce((n, d) => n + d.sent, 0), 2); assert.equal(i.byAngle.find(a => a.key === "urgenze").rate, 100); assert.equal(i.byAngle.find(a => a.key === "orari").rate, 0);
  assert.equal(i.intents.interested, 1); assert.equal(i.hist.reduce((n, h) => n + h.n, 0), 1); assert.equal(core.insights(db, uid, { campaignId: 999 }).total, 0);
});

test("model drafts: parsed, linted, given one chance to fix, and never sent or approved by this code", async () => {
  assert.deepEqual(parseModelDraft("SUBJECT: urgenze della domenica\nBODY: Il vostro sito dice X.\nChi risponde?"), { subject: "urgenze della domenica", body: "Il vostro sito dice X.\nChi risponde?" });
  const facts = [{ kind: "emergency", text: "urgenze anche la domenica mattina" }, { kind: "heading", text: "Studio odontoiatrico Rossi a Torino" }];
  assert.equal(observationCandidates(facts)[0].kind, "emergency");
  const replies = ["SUBJECT: Quick Question!\nBODY: We offer a free tool — worth a quick call?", "SUBJECT: urgenze della domenica\nBODY: Il vostro sito parla di urgenze anche la domenica mattina. Chi risponde al numero in basso?"];
  let n = 0; const f = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: replies[Math.min(n++, 1)] } }] }) });
  const d = await aiDraft({ provider: "openai", baseUrl: "x", model: "m", apiKey: "k" }, { step: 1, lang: "it", prospect: { name: "Studio Rossi" }, facts, persona: PERSONA }, f);
  assert.equal(n, 2, "one retry"); assert.equal(d.lint.ok, true, JSON.stringify(d.lint.issues)); assert.ok(d.body.includes(PERSONA.optout)); assert.equal(d.ai, true);
  await assert.rejects(() => aiDraft({}, { step: 1, lang: "it", prospect: { name: "X" }, facts: [], persona: PERSONA }, f), /nothing specific/);
  const sk = skeleton({ step: 1, lang: "it", fact: facts[0], persona: PERSONA }); assert.match(sk.body, /urgenze anche la domenica/); assert.ok(sk.body.includes(PERSONA.optout));
});
