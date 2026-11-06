import test from "node:test";
import assert from "node:assert/strict";
import { lintDraft } from "../src/lint.mjs";

const persona = { product: "Mimo", optout: "Se preferisci non ricevere altri messaggi, basta dirmelo.", requireOptout: true, claims: ["gestisce le prenotazioni di 12 cliniche"] };
const facts = [{ text: "urgenze anche la domenica mattina" }, { text: "dal 1998" }];
const GOOD = { step: 1, subject: "urgenze della domenica", persona, facts,
  body: "Il vostro sito dice che le urgenze della domenica mattina vanno chiamate al numero in basso. Quel numero arriva a chi è di turno o direttamente a voi?\n\nSe preferisci non ricevere altri messaggi, basta dirmelo." };
const codes = r => r.issues.map(i => i.code);

test("a short honest first email with a real observation and one question passes", () => {
  const r = lintDraft(GOOD); assert.equal(r.ok, true, JSON.stringify(r.issues)); assert.ok(r.words < 75);
});

test("length caps differ by step, and the opt-out line does not count against them", () => {
  const long = "Il vostro sito dice che le urgenze della domenica mattina vanno chiamate al numero in basso e che il numero e valido tutti i giorni dell anno. ".repeat(5) + "Chi risponde davvero?";
  assert.ok(codes(lintDraft({ ...GOOD, body: long })).includes("too_long"));
  const bump = { ...GOOD, step: 3, subject: "ancora utile", body: "Ti scrivo ancora una volta, magari non era il momento giusto. Le urgenze della domenica sono ancora un tema per voi? Se non lo sono mi fermo qui, nessun problema." };
  assert.ok(lintDraft(bump).words < 45); assert.equal(lintDraft({ ...bump, body: bump.body + " Aggiungo altre parole inutili per superare il limite dei quaranta termini concessi a un sollecito breve." }).issues.some(i => i.code === "too_long"), true);
});

test("marketing tells, hype and formatting are caught in Italian and English", () => {
  const bad = lintDraft({ step: 1, subject: "Quick Question!", persona, facts, body: "We hope this finds you well! We offer a free, revolutionary all-in-one tool — worth a quick call?\n- fast\n- easy\nSee https://x.it" });
  for (const c of ["subject_case", "banned_phrase", "spam_word", "em_dash", "exclamation", "formatting", "link_in_first", "starts_with_me"]) assert.ok(codes(bad).includes(c), c + " missing in " + codes(bad));
  const it = lintDraft({ ...GOOD, body: "Abbiamo una soluzione innovativa e gratis per voi. Ti rubo un attimo del tuo tempo?" });
  for (const c of ["banned_phrase", "spam_word", "starts_with_me"]) assert.ok(codes(it).includes(c), c);
});

test("subjects: 2 to 5 lowercase words, no fake reply, no name", () => {
  assert.ok(codes(lintDraft({ ...GOOD, subject: "domanda" })).includes("subject_length"));
  assert.ok(codes(lintDraft({ ...GOOD, subject: "re: urgenze della domenica" })).includes("subject_fake_reply"));
  assert.ok(codes(lintDraft({ ...GOOD, subject: "una due tre quattro cinque sei" })).includes("subject_length"));
});

test("claims must trace to your profile or to their own public facts; the product is not named in email 1", () => {
  const r = lintDraft({ ...GOOD, body: "Il vostro sito dice dal 1998 e 250 pazienti al mese. Mimo gestisce le prenotazioni di 12 cliniche, vi interessa?\n\nSe preferisci non ricevere altri messaggi, basta dirmelo." });
  assert.ok(codes(r).includes("untraced_number")); assert.ok(codes(r).includes("product_in_first"));
  assert.equal(r.issues.filter(i => i.code === "untraced_number").some(i => /1998|12/.test(i.text)), false, "1998 is in their facts, 12 in your profile");
  assert.ok(codes(lintDraft({ ...GOOD, body: "Le urgenze della domenica vanno chiamate al numero in basso, giusto?" })).includes("optout_missing"));
});

test("exactly one question, ending the message", () => {
  assert.ok(codes(lintDraft({ ...GOOD, body: "Le urgenze della domenica? Chi risponde? Sempre voi?\n\n" + persona.optout })).includes("many_questions"));
  assert.ok(codes(lintDraft({ ...GOOD, body: "Il vostro sito parla delle urgenze della domenica mattina.\n\n" + persona.optout })).includes("no_question"));
});
