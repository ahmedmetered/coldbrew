import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.mjs";
import { signup } from "../src/auth.mjs";
import * as core from "../src/core.mjs";
import { classifyReply, stripQuoted, matchProspect, processIncoming } from "../src/replies.mjs";

test("replies are classified in Italian and English, with the safest reading winning", () => {
  const c = classifyReply;
  assert.equal(c("Non scrivermi più, grazie."), "opt_out"); assert.equal(c("Please remove me from your list"), "opt_out"); assert.equal(c("STOP"), "opt_out");
  assert.equal(c("Segnalerò questa mail al Garante della privacy, come avete avuto il mio indirizzo?"), "angry_legal"); assert.equal(c("My lawyer will contact you."), "angry_legal");
  assert.equal(c("Non siamo interessati, grazie"), "not_interested"); assert.equal(c("No thanks"), "not_interested");
  assert.equal(c("Non sono la persona giusta, rivolgiti a Marco"), "wrong_person"); assert.equal(c("Quanto costa?"), "objection"); assert.equal(c("Come funziona esattamente?"), "question");
  assert.equal(c("Sì, volentieri, mi racconti di più"), "interested"); assert.equal(c("Sono fuori sede fino al 12, risposta automatica"), "auto"); assert.equal(c("Ricevuto."), "other");
  assert.equal(c("Non siamo interessati e vi prego di non scriverci più"), "opt_out", "opt-out beats not-interested");
});

test("quoted text and signatures are removed from a reply", () => {
  assert.equal(stripQuoted("Sì, volentieri.\n\nIl giorno 3 nov 2026 Ahmed ha scritto:\n> Il vostro sito dice..."), "Sì, volentieri.");
  assert.equal(stripQuoted("Ok\n> citazione\n\nOn Mon, Nov 3, 2026 at 10:00 Ahmed wrote:\n> x"), "Ok");
});

function setup() {
  const db = openDb(":memory:"), uid = signup(db, "a@example.com", "correct horse battery"), cid = core.createCampaign(db, uid, { name: "C", persona: { optout: "x" } });
  core.addProspects(db, uid, cid, [{ name: "Studio Rossi", category: "Dentista", website: "https://rossi.it", emails: ["info@rossi.it"], source: "osm", source_id: "n1" }, { name: "Studio Verdi", category: "Dentista", website: "https://verdi.it", emails: [], source: "osm", source_id: "n2" }], { applyFilter: false });
  for (const id of [1, 2]) db.prepare("UPDATE prospects SET status = 'Contacted' WHERE id = ?").run(id);
  return { db, uid };
}

test("a reply is matched by the exact address first, then by the business's own domain; strangers are ignored", () => {
  const { db, uid } = setup();
  assert.equal(matchProspect(db, uid, "INFO@rossi.it"), 1); assert.equal(matchProspect(db, uid, "segretaria@verdi.it"), 2); assert.equal(matchProspect(db, uid, "x@gmail.com"), null);
});

test("opt-outs are never saved, angry replies are kept verbatim and never answered, both exclude for good", () => {
  const { db, uid } = setup();
  db.prepare("INSERT INTO drafts (user_id, prospect_id, step, subject, body, status, created_at, updated_at) VALUES (?, 1, 2, 's', 'b', 'draft', 'x', 'x')").run(uid);
  const out = processIncoming(db, uid, { prospectId: 1, extId: "m1", text: "Rimuovetemi dalla lista, non scrivermi più." });
  assert.equal(out.outcome, "excluded"); assert.equal(db.prepare("SELECT COUNT(*) n FROM messages").get().n, 0, "the opt-out text is not stored");
  assert.equal(core.getProspect(db, uid, 1).dnc, true); assert.equal(db.prepare("SELECT status FROM drafts").get().status, "discarded");
  const angry = processIncoming(db, uid, { prospectId: 2, extId: "m2", text: "Ho segnalato tutto al Garante, il mio avvocato vi scriverà." });
  assert.deepEqual([angry.outcome, angry.attention], ["excluded", true]);
  assert.match(db.prepare("SELECT text FROM messages WHERE prospect_id = 2").get().text, /avvocato/); assert.equal(core.getProspect(db, uid, 2).dnc, true);
});

test("a normal reply moves the prospect to Replied, ends the sequence, and is stored once", () => {
  const { db, uid } = setup();
  db.prepare("INSERT INTO drafts (user_id, prospect_id, step, subject, body, status, created_at, updated_at) VALUES (?, 1, 2, 's', 'b', 'approved', 'x', 'x')").run(uid);
  const r = processIncoming(db, uid, { prospectId: 1, extId: "m1", text: "Sì, volentieri, quando ci sentiamo?\n\nIl giorno 3 nov ha scritto:\n> ..." });
  assert.deepEqual([r.outcome, r.intent], ["replied", "question"]);
  assert.equal(core.getProspect(db, uid, 1).status, "Replied"); assert.equal(db.prepare("SELECT status FROM drafts").get().status, "discarded");
  assert.equal(processIncoming(db, uid, { prospectId: 1, extId: "m1", text: "Sì, volentieri" }).outcome, "duplicate");
  assert.equal(processIncoming(db, uid, { prospectId: 1, extId: "m9", text: "Sono fuori sede fino a lunedì" }).outcome, "ignored");
  const no = processIncoming(db, uid, { prospectId: 2, extId: "m3", text: "No grazie, non ci interessa." });
  assert.equal(no.outcome, "lost"); assert.equal(core.getProspect(db, uid, 2).status, "Lost"); assert.equal(core.getProspect(db, uid, 2).dnc, false);
});
