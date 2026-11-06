# Coldbrew: product plan

*Approval-first outreach for local businesses.* An open-source app that runs on your own computer. It builds a ranked
list of businesses in a city, helps you write a short honest first message to each one, holds every draft until you
approve it, reads the replies back, and shows what works. It never sends anything itself.

This is the standalone successor to [anydeals](https://github.com/ahmedmetered/anydeals) (the agent-skill pack),
built the way Posto was built from anyjobsearch. anydeals stays as the agent-native version; Coldbrew is the app.

## Decisions already made

- **Approval-first, you send.** Coldbrew drafts; you approve; then you send from your own mailbox or Instagram.
  Approved drafts open in your mail app (mailto) or copy to the clipboard. No SMTP sending in the app.
- **Prospects from two sources plus CSV.** OpenStreetMap, and an optional connector to the Google Maps scraper
  (gosom, needs Docker) as anydeals uses today. CSV import for lists you already have.
- **Separate repo, reusing Posto's tested modules** (accounts, SQLite layer, scheduler, encrypted secrets, IMAP reading,
  webhook digest, optional AI, importer pattern). Its own name (Coldbrew), look and tests. Local-first, MIT, no
  runtime dependencies for the core.

## What the sources really give (measured, not assumed)

A real query for dentists in central Turin on OpenStreetMap returned 49 businesses, but only 3 had a website, 3 an
email and 7 a phone number. OpenStreetMap is good for finding that a business exists and where, and thin for how to
reach it. So:

- **Google Maps scraper** is the rich source (phone, website, reviews, hours) and is a first-class connector, not an afterthought.
- **OpenStreetMap** is the Docker-free way to discover businesses. Contact details are then filled in from each
  business's own website when one is known, and from an optional search step (the user's own key) when it is not.
- **CSV import** covers everything else.

## The workflow, in the app's words

1. **Campaign.** A vertical in a place ("dentists in Turin and hinterland") plus a **persona**: who you are, what you
   offer, the *only* claims allowed, who you are looking for, how people can opt out.
2. **Sweep.** Plan per-municipality queries, collect, dedupe (source id, then normalised name + phone/domain), filter
   by category **before** ranking, rank by fit to the persona.
3. **Enrich.** From the business's own public website: email, phone, social links, and one *verifiable detail* worth
   mentioning (a claim, a service, hours, how they take bookings), stored with its source URL.
4. **Draft.** Every draft follows the method from anydeals (one observation, one question, under 75 words, honest
   subject, no banned patterns). Two ways to get one: write it yourself with the helper, or press a button and a model
   writes it (optional: local Ollama or your own cloud key). Either way it goes through the same **linter**.
5. **Approve.** The outbox holds every draft as `draft`. Only you move it to `approved`. Approved drafts show
   "Open in mail", "Copy" or "Open Instagram chat". You send, then press "Sent" (or the inbox reader notices).
6. **Sequence.** For non-responders Coldbrew *queues* email 2 (day 4-6, new angle), email 3 (day 9-11, short bump) and
   a breakup (day 14), six touches at most, each waiting for your approval like the first.
7. **Replies.** Read-only IMAP matches replies to prospects, classifies them (interested, question, objection, wrong
   person, not interested, opt-out, angry or legal) and applies the rules from anydeals: opt-outs are never saved or
   answered and are excluded for good; angry or legal replies are kept word for word and never answered. Optional
   Instagram connector (Meta token) as in anydeals.
8. **Pipeline and insights.** Found, Drafted, Approved, Contacted, Replied, Meeting, Won, Lost. Reply rate by campaign,
   angle, step and subject; time to reply; meetings booked.

## What is new compared with anydeals

- **The linter in code.** Word count, one question, subject rules, banned patterns, em dashes, claims traceable to the
  persona, opt-out present. Deterministic, tested, and useful even for hand-written drafts.
- **A permanent do-not-contact list** shared across campaigns, checked before any draft is created.
- **A real approval queue** with a per-draft audit trail (who changed what, when).
- **Reply handling without an agent**: the classifier runs locally; AI is only ever optional.

## Data model (SQLite)

`campaigns`, `personas`, `prospects` (name, category, address, city, lat/lon, website, emails, phones, socials, source,
source_id, score, channel, status, dnc), `facts` (prospect, text, source_url, fetched_at), `drafts` (prospect, step,
subject, body, angle, status, lint_json, approved_at), `threads` and `messages`, `events` (audit trail), `suppressions`,
`sweeps`, `settings`, `kv`. Accounts, sessions, encrypted secrets and the scheduler come over from Posto unchanged.

## Compliance guardrails (built in, not advice)

Plain-text drafts, truthful subjects, real sender identity, an opt-out line, honoured immediately and permanently. For
EU and UK recipients the persona asks for a one-line legitimate-interest note and the linter refuses drafts that are
not relevant to the recipient's business. Prospect data is personal data in the EU: the README says plainly that the
user is responsible for lawful use, that lists are for their own outreach and not for resale, and that this is not
legal advice.

## Out of scope

Sending email or DMs, scraping LinkedIn or Instagram, anything bulk, open and click tracking, selling or sharing lists.

## Milestones

1. **Engine:** sources (OSM, gosom connector, CSV), dedupe, category filter, ranking, website enrichment, with fixtures and tests.
2. **Drafting:** persona, linter, optional AI, outbox and approval, sequences.
3. **Replies:** IMAP matching, classifier, do-not-contact rules, optional Instagram connector, digest.
4. **Interface:** a new look through the design process (not Posto's), Campaigns, Prospects, Outbox, Replies, Pipeline, Insights, Settings.
5. **Open-source packaging:** README with screenshots, CI, import from the anydeals tracker, portfolio entry, CV line.

## Risks

- OpenStreetMap contact data is sparse (see above), so quality depends on the Google Maps connector or a CSV.
- Websites vary wildly; enrichment will miss, and the app must say "not found" rather than guess.
- Cold email law differs by country; the app guards the common rules but cannot know your recipient's situation.
- Name overlap: other projects are called Coldbrew (a Go framework, several small repos, and coffee). The README leads
  with the tagline "Coldbrew: approval-first outreach for local businesses".

## Answers to the open questions

1. **Languages:** Italian and English first.
2. **First campaign:** Milan.
3. **Existing data:** import the prospects from the anydeals tracker (port 8789).
4. **AI:** optional and off by default.

## Interface requirements (from the owner)

- A real **dashboard with charts**: funnel, activity over time, reply rate by step, angle and category, time to reply, score and channel mix, source yield.
- **The tracker filters always available** on the prospect list: search, status, channel, source, category, city, score, has email or website, enriched, date added, sort, saved views, bulk actions, possible duplicates.
- **Look and feel: calm and steady**, with coffee colours. Built through the design process, not Posto's funky look.

## Open questions (resolved above)

1. **Languages:** drafts in the prospect's language is a core rule. Which languages must the linter and templates
   support first (Italian and English)?
2. **Your own first campaign:** which vertical and city do you want to run through it first, so the demo data is real?
3. **Existing anydeals data:** import the prospects from your current tracker (port 8789) when ready?
4. **AI:** keep it strictly optional and off by default (as in Posto), or is there a model you want it built around?
