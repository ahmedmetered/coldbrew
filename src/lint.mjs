// The method from anydeals as code. A draft is checked against the same floor whether a person or a model wrote it.
// Pure and deterministic: lintDraft({ subject, body, step, persona, facts }) -> { ok, words, issues[] }
// Rules: one idea and one question, under the word cap, an honest short subject, no marketing tells, no invented
// numbers, nothing that is not in the persona or the prospect's own public facts.

export const WORD_CAPS = { 1: 75, 2: 75, 3: 40, 4: 40, 5: 40, 6: 40 }; // email 1 and 2 under 75 words, bumps under 40, breakup short
const countWords = s => (String(s).trim().match(/[\p{L}\p{N}'’-]+/gu) || []).length;

const BANNED_PHRASES = [
  "quick question", "domanda veloce", "breve domanda", "hope this finds you well", "spero che tu stia bene", "spero stia bene", "just following up", "just checking in", "following up",
  "picture this", "imagine if", "what if i told you", "here's what i keep seeing", "worth a quick call", "worth a quick look", "worth a quick chat", "i'd love to", "mi piacerebbe tanto",
  "great question", "i completely understand", "touch base", "circle back", "game changer", "cutting-edge", "state-of-the-art", "all-in-one", "revolutionary",
  "rivoluzionari", "all'avanguardia", "soluzione innovativa", "ti rubo", "un attimo del tuo tempo", "ti ruberò",
];
const SPAM_WORDS = ["free", "gratis", "gratuito", "guarantee", "guaranteed", "garantito", "garanzia", "risk-free", "act now", "limited time", "offerta limitata", "exclusive", "esclusivo", "discount", "sconto", "% off", "save big",
  "winner", "congratulations", "congratulazioni", "urgent", "urgente", "last chance", "ultima occasione", "click here", "clicca qui", "sign up now", "make money", "increase sales", "double your", "100%", "$$$"];
const GUILT = [/probably losing/i, /stai (probabilmente )?perdendo/i, /you('| a)re missing out/i, /ti stai perdendo/i];

const FIRST_PERSON = /^(i|i'm|i've|we|we're|we've|my|our|io|noi|mi chiamo|sono|siamo|abbiamo|ho|offriamo|proponiamo|vorrei|volevo|scrivo)\b/i;
const MARKDOWN = /(^|\n)\s*([-*•]|\d+\.)\s|[*_]{1,2}[^*_\n]+[*_]{1,2}|^#{1,6}\s|\[[^\]]+\]\([^)]+\)/m;

export function lintDraft({ subject = "", body = "", step = 1, persona = {}, facts = [], prospect = {} } = {}) {
  const issues = [], add = (code, text, severity = "error") => issues.push({ code, severity, text });
  body = String(body).replace(/\r\n/g, "\n"); subject = String(subject).trim();
  const optout = String(persona.optout || "").trim();
  const dm = !!prospect.channel && prospect.channel !== "email"; // a DM has no subject and no email footer
  const core = optout ? body.replace(optout, "") : body;               // the opt-out line is required, so it does not count against the cap
  const words = countWords(core), cap = WORD_CAPS[step] || 40, lower = `${subject}\n${body}`.toLowerCase();

  if (!body.trim()) add("empty", "The message is empty.");
  if (words > cap) add("too_long", `${words} words; message ${step} must be under ${cap}. Cut until one idea and one question are left.`);
  if (step === 1 && words < 18 && body.trim()) add("too_short", `${words} words is too thin to say something specific about them.`, "warning");

  // subject: lowercase, 2-5 words, no recipient name, honest, new for each step
  const sw = countWords(subject);
  if (dm) { /* no subject on a DM */ }
  else if (!subject) add("subject_missing", "Add a subject.");
  else {
    if (sw < 2 || sw > 5) add("subject_length", `The subject has ${sw} words; use 2 to 5.`);
    if (subject !== subject.toLowerCase()) add("subject_case", "Write the subject in lowercase, like an internal email.");
    if (/^(re|fwd?|r|i):/i.test(subject)) add("subject_fake_reply", 'No fake "re:" or "fwd:" in the subject.');
    if (/[!?]{1,}$/.test(subject) && /!/.test(subject)) add("subject_hype", "No exclamation marks in the subject.");
    if (prospect.name && lower.split("\n")[0].includes(String(prospect.name).toLowerCase())) add("subject_name", "Do not put their name in the subject.", "warning");
  }

  // marketing tells
  for (const ph of BANNED_PHRASES) if (lower.includes(ph)) add("banned_phrase", `"${ph}" sounds like a template. Say it your own way.`);
  for (const w of SPAM_WORDS) {
    const hit = /[%$]/.test(w) ? lower.includes(w) : new RegExp(`(^|[^\\p{L}])${w}([^\\p{L}]|$)`, "iu").test(lower); // words match on boundaries, symbols as they are
    if (hit) add("spam_word", `"${w}" is a spam trigger.`);
  }
  for (const g of GUILT) if (g.test(body)) add("guilt", "Guilt-tripping ('you are probably losing...') is not a hook.");
  if (/[—–]/.test(subject + body)) add("em_dash", "Remove em dashes and en dashes; use a comma, a full stop or a new sentence.");
  if (/!/.test(body)) add("exclamation", "No exclamation marks in the body.");
  if (/[“”‘’]/.test(body)) add("curly_quotes", "Use straight quotes only.", "warning");
  if (MARKDOWN.test(body)) add("formatting", "Plain text only: no bullets, bold, headers or links in brackets.");
  if (/(before\s*\/?\s*after|prima\s*\/\s*dopo)/i.test(body)) add("before_after", "No before/after lists.");
  if (/not [^.]{3,40}, but /i.test(body) || /non [^.]{3,40}, ma /i.test(body)) add("not_x_but_y", 'Skip "not X, but Y": state Y.', "warning");

  // one idea, one question, starts with them
  const questions = (body.match(/\?/g) || []).length;
  if (step <= 3 && questions === 0) add("no_question", "End with one real question they would want to answer.");
  if (questions > 1) add("many_questions", `${questions} questions; ask exactly one.`);
  if (step === 1 && FIRST_PERSON.test(core.trim())) add("starts_with_me", "Start with them, not with I or We.");
  const lastLine = core.trim().split(/\n+/).pop() || "";
  if (questions >= 1 && !/\?\s*$/.test(lastLine) && step <= 3 && !optout) add("question_not_last", "End on the question.", "warning");

  // links and attachments
  const links = (body.match(/https?:\/\/\S+|www\.\S+/gi) || []).length;
  if (step === 1 && links > 0) add("link_in_first", "No links in the first email.");
  if (links > 1) add("too_many_links", "At most one link per email.");
  if (/(allegat|attach)/i.test(body)) add("attachment", "No attachments.", "warning");

  // the product is not named in email 1; claims must trace to the persona or to the prospect's own public facts
  const product = String(persona.product || "").trim();
  if (step === 1 && product && lower.includes(product.toLowerCase())) add("product_in_first", `Do not name ${product} in the first email.`);
  const allowed = [persona.claims, persona.facts, ...facts.map(f => f.text || f)].flat().filter(Boolean).join(" \n ").toLowerCase();
  for (const n of new Set(body.match(/\b\d[\d.,]*\s?(?:%|€|\$|£|k|euro|clienti|customers|anni|years|recensioni|reviews|stelle|stars)?/gi) || [])) {
    const num = n.trim().replace(/[.,]$/, "");
    if (/^\d{1,2}$/.test(num)) continue; // small counts like "two" written as digits are not claims
    if (!allowed.includes(num.toLowerCase().replace(/\s+/g, "")) && !allowed.replace(/\s+/g, "").includes(num.toLowerCase().replace(/\s+/g, ""))) add("untraced_number", `"${num}" is not in your profile or in what their site says. Use a number you can show, or leave it out.`);
  }
  if (!dm && persona.requireOptout && optout && !body.includes(optout)) add("optout_missing", "Add your opt-out line (it is required for this campaign).");

  const errors = issues.filter(i => i.severity === "error");
  return { ok: errors.length === 0, words, cap, issues };
}
