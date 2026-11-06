// Helping write the message: what is worth mentioning, a skeleton to edit by hand, and (optionally) a model's first draft.
// Whatever produces the text, it goes through lint.mjs and waits for approval: this file never sends or approves anything.
import { call } from "./ai.mjs";
import { lintDraft, WORD_CAPS } from "./lint.mjs";

// facts about the business, best first: things that are specific and checkable beat generic descriptions
const KIND_RANK = { emergency: 0, history: 1, hours: 2, heading: 3, description: 4, site: 5 };
export const observationCandidates = facts => [...facts].sort((a, b) => (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9)).slice(0, 5);

const SKELETONS = {
  it: {
    1: { subject: "una cosa sul vostro sito", body: n => `Sul vostro sito si legge "${n}". Come funziona nella pratica per chi vi contatta fuori orario?` },
    2: { subject: "un altro punto", body: n => `Un altro dettaglio: "${n}". Oggi come lo gestite quando siete in due cose insieme?` },
    3: { subject: "ancora utile", body: () => "Ti scrivo un'ultima volta in breve: l'argomento è ancora rilevante per voi? Se no, mi fermo qui." },
    4: { subject: "chiudo il filo", body: () => "Non ti scrivo più su questo. Se un giorno ti torna utile, la porta resta aperta." },
  },
  en: {
    1: { subject: "one thing on your site", body: n => `Your site says "${n}". How does that work in practice for someone reaching you outside opening hours?` },
    2: { subject: "another point", body: n => `One more detail: "${n}". How do you handle it when two things land at once?` },
    3: { subject: "still relevant", body: () => "One last short note: is this still something you care about? If not, I will stop here." },
    4: { subject: "closing the loop", body: () => "I will not write again about this. If it ever becomes useful, the door stays open." },
  },
};
export function skeleton({ step = 1, lang = "it", fact = null, persona = {} }) {
  const s = (SKELETONS[lang] || SKELETONS.it)[Math.min(step, 4)];
  const body = s.body(fact ? fact.text : "[something specific from their site]");
  return { subject: s.subject, body: persona.optout && step <= 2 ? `${body}\n\n${persona.optout}` : body };
}

const SYSTEM = `You write a first cold message to a local business on behalf of a real person. Follow these rules exactly:
- Write like a person who noticed something. Plain text only. No greetings like "I hope this finds you well".
- ONE specific observation taken only from the FACTS given, then ONE real question about it. No pitch. Do not name the product.
- Under the word limit. No em dashes, no exclamation marks, no bullets, no links, no numbers that are not in the facts or claims.
- Start with them or their business, not with I or We. End on the question.
- Subject: 2 to 5 lowercase words, honest, no name, never "quick question".
- Write in the language requested. Never invent anything.
Return exactly two lines of output:
SUBJECT: <subject>
BODY: <body text, may span several lines>`;

// the facts, limits and claims for one message, as plain text: sent to a model, or copied for the user's own AI agent
export function briefText({ step = 1, lang = "it", prospect, facts = [], persona = {}, angle = "" }) {
  const cap = WORD_CAPS[step] || 40, usable = facts;
  return `LANGUAGE: ${lang === "it" ? "Italian" : "English"}\nWORD LIMIT: ${cap}\nMESSAGE NUMBER: ${step}${angle ? `\nANGLE: ${angle}` : ""}\nBUSINESS: ${prospect.name} (${prospect.category || "local business"}, ${prospect.city || ""})\nFACTS FROM THEIR OWN SITE:\n${usable.map(f => `- ${f.text}`).join("\n") || "- (none)"}\nWHO IS WRITING: ${persona.sender || "the sender"}\nCLAIMS ALLOWED: ${(persona.claims || []).join("; ") || "none"}`;
}
export const agentBrief = args => `${SYSTEM}

--- THIS MESSAGE ---
${briefText({ ...args, facts: observationCandidates(args.facts || []) })}`;

export function parseModelDraft(out) {
  const s = String(out).match(/SUBJECT:\s*(.+)/i), b = String(out).match(/BODY:\s*([\s\S]+)/i);
  if (!s || !b) return null;
  return { subject: s[1].trim().replace(/^["']|["']$/g, ""), body: b[1].trim() };
}

// ask a model for a draft, lint it, and give it ONE chance to fix what the linter found
export async function aiDraft(cfg, { step = 1, lang = "it", prospect, facts = [], persona = {}, angle = "" }, fetchImpl = fetch) {
  const cap = WORD_CAPS[step] || 40, usable = observationCandidates(facts);
  if (!usable.length && step === 1) throw new Error("There is nothing specific to say about this business yet. Enrich it first, or write the message yourself.");
  const brief = briefText({ step, lang, prospect, facts: usable, persona, angle });
  let out = parseModelDraft(await call(cfg, SYSTEM, brief, fetchImpl)), report = out && lintDraft({ ...out, step, persona, facts, prospect });
  if (out && !report.ok) {
    const fixed = parseModelDraft(await call(cfg, SYSTEM, `${brief}\n\nYOUR PREVIOUS DRAFT:\nSUBJECT: ${out.subject}\nBODY: ${out.body}\n\nFIX THESE PROBLEMS AND RETURN THE SAME TWO LINES:\n${report.issues.filter(i => i.severity === "error").map(i => "- " + i.text).join("\n")}`, fetchImpl));
    if (fixed) { out = fixed; report = lintDraft({ ...out, step, persona, facts, prospect }); }
  }
  if (!out) throw new Error("The model did not return a usable draft. Try again or write it yourself.");
  const body = persona.optout && step <= 2 && !out.body.includes(persona.optout) ? `${out.body}\n\n${persona.optout}` : out.body;
  return { subject: out.subject, body, lint: lintDraft({ subject: out.subject, body, step, persona, facts, prospect }), ai: true };
}
