import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.mjs";
import { signup } from "../src/auth.mjs";
import * as core from "../src/core.mjs";
import { lintDraft } from "../src/lint.mjs";
import { importAnydeals, toProspect } from "../scripts/import-anydeals.mjs";

const ROWS = [
  { id: "a1", name: "ONYX Academy", channel: "Instagram", handle: "@onyxacademy", status: "Drafted", notes: "Settore: estetica. Recensioni: 1.153. Priorità: ALTA.", draft: "Con 1.153 recensioni immagino arrivino molte richieste tra un corso e l'altro. Come fate a tenere il conto di chi va richiamato?", added: "2026-10-28", updated: "2026-10-28" },
  { id: "a2", name: "Scuola Mail", channel: "Email", handle: "info@scuolamail.it", status: "Contacted", date_contacted: "2026-10-30", draft: "Messaggio inviato.", notes: "", added: "2026-10-29", messages: [{ id: "m1", dir: "in", platform: "Email", text: "Sì, volentieri.", ts: "2026-11-01T10:00:00Z" }] },
  { id: "a3", name: "Corsi Stop", channel: "Instagram", handle: "@corsistop", status: "Replied", dnc: true, attention: "chiesto di non essere contattato", added: "2026-10-29" },
  { name: "", id: "x" },
];

test("anydeals prospects keep their handle, notes, stage, draft, replies and do-not-contact flag", () => {
  const p = toProspect(ROWS[0]); assert.deepEqual([p.category, p.reviews, p.socials.instagram, p.source_id], ["estetica", 1153, "https://instagram.com/onyxacademy", "a1"]);
  assert.deepEqual(toProspect(ROWS[1]).emails, ["info@scuolamail.it"]);
  const db = openDb(":memory:"), uid = signup(db, "a@example.com", "correct horse battery"), cid = core.createCampaign(db, uid, { name: "From anydeals", language: "it" });
  const r = importAnydeals(db, uid, cid, ROWS); assert.deepEqual([r.added, r.drafts, r.messages, r.dnc, r.skipped], [3, 2, 1, 1, 1]);
  const first = db.prepare("SELECT * FROM prospects WHERE source_id = 'a1'").get(); assert.equal(first.status, "Drafted"); assert.equal(first.channel, "instagram"); assert.equal(first.created_at.slice(0, 10), "2026-10-28");
  assert.equal(db.prepare("SELECT status FROM drafts WHERE prospect_id = ?").get(first.id).status, "draft");
  const second = db.prepare("SELECT * FROM prospects WHERE source_id = 'a2'").get(); assert.equal(second.status, "Contacted"); assert.equal(db.prepare("SELECT status FROM drafts WHERE prospect_id = ?").get(second.id).status, "sent");
  const dnc = core.getProspect(db, uid, db.prepare("SELECT id FROM prospects WHERE source_id = 'a3'").get().id); assert.equal(dnc.dnc, true); assert.equal(dnc.status, "Lost");
  assert.equal(importAnydeals(db, uid, cid, ROWS).drafts, 0, "running it twice adds nothing");
});

test("a DM draft needs no subject and no email opt-out line, but the rest of the method still applies", () => {
  const dm = { channel: "instagram", name: "ONYX Academy" };
  const ok = lintDraft({ subject: "", body: ROWS[0].draft, step: 1, persona: { requireOptout: true, optout: "stop" }, facts: [{ text: "1.153 recensioni" }], prospect: dm });
  assert.equal(ok.issues.some(i => /subject|optout/.test(i.code)), false, JSON.stringify(ok.issues));
  assert.ok(lintDraft({ subject: "", body: "Ottimo lavoro! Abbiamo un tool gratis per voi.", step: 1, persona: {}, prospect: dm }).issues.some(i => i.code === "spam_word"));
  assert.ok(lintDraft({ subject: "", body: "Ciao, come fate?", step: 1, persona: {}, prospect: { channel: "email" } }).issues.some(i => i.code === "subject_missing"));
});
