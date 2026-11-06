# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack
Existing codebase: a plain Node server and one static `public/index.html` (vanilla JS, no framework, no build step, no runtime dependencies). Keep it that way. Text is set through textContent, never innerHTML.

## Users
One person (or a small team on one computer) running outreach to local businesses in their own city: freelancers, small agencies, founders selling to clinics, restaurants, shops. They open it daily to see what needs their approval, what came back, and what is working. Inferred from the build conversation and the anydeals method, not interviewed.

## Product Purpose
Builds a ranked list of local businesses, helps write a short honest first message to each, holds every draft until the person approves it, reads replies back, and shows what works. It never sends anything itself. Local-first, open source, shown in the author's portfolio.

## Positioning
Approval-first by construction: a linter enforces the method (one observation, one question, under the word cap, honest subject, traceable claims), a permanent do-not-contact list is checked before any draft exists, and approval is withdrawn if a draft is edited.

## Operating Context
Daily check-in at a desk: Dashboard (charts), Campaigns, Prospects (list with filters and detail), Outbox (approval queue and follow-ups due), Settings (mailbox, optional AI). Runs at localhost.

## Capabilities and Constraints
Italian and English drafts. Sources: OpenStreetMap, the Google Maps scraper CSV, any CSV. Replies read read-only over IMAP. Must show: dashboard with graphs and charts; the full prospect filter set always available (search, status, channel, source, category, city, score, has email or website, enriched, date added, sort, saved views, bulk actions).

## Brand Commitments
Name: Coldbrew. The owner asked for a calm, steady look with coffee colours (not Posto's funky stamp look). Tagline: "approval-first outreach for local businesses".

## Evidence on Hand
No logo, no real customers, no real campaign data yet. Demo data must be synthetic and labelled as such.

## Product Principles
1. Nothing leaves without the person's approval, and the interface makes that visible.
2. Say what is known and what is not: "not found" beats a guess.
3. Calm by default: no urgency theatre, no red badges for ordinary things.
4. The method is the product: show why a draft passes or fails.

## Accessibility & Inclusion
Body text contrast at least 4.5:1 in both themes, keyboard-operable lists and dialogs, charts with text alternatives (values readable as a table), reduced-motion respected.
