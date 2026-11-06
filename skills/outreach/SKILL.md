---
name: coldbrew-outreach
description: >
  Write personalized first messages and follow-ups for a Coldbrew campaign, using the
  Harvey-derived method (one specific observation, one real question, under 75 words,
  no AI tells), and draft replies. Use when the user pastes a Coldbrew brief, or asks
  to "write the message for this prospect" or "answer this reply". Writes text only;
  the user pastes it into Coldbrew, which lints it and holds it for approval.
license: MIT
metadata:
  origin: Method adapted from ethanplusai/harvey (MIT, Ethan Rogers), via anydeals / anyoutreach.
---

# Coldbrew outreach (agent skill)

Coldbrew never sends anything and never needs an AI key. If you have an agent you already use,
this skill lets it do the writing while Coldbrew keeps the facts, the linter and the approval queue.

## The loop

1. In Coldbrew, open a prospect and press **Copy brief for my AI agent**. The brief holds the language, the word limit,
   the only claims allowed, the facts found on the business's own site (with where each came from) and the output format.
2. Give the brief to your agent. It follows `references/method.md` and returns `SUBJECT:` and `BODY:` only.
3. In Coldbrew, start a **Blank** draft and paste the result. It is linted straight away and waits for your approval.
4. For replies, paste the reply into the prospect (Coldbrew classifies it), then ask your agent to follow `references/replies.md`.

## Hard rules

- Use only the facts and claims in the brief. Never invent a number, a customer, a mutual contact or a result.
- One observation, one question, under the word limit, no product name in message 1.
- Opt-outs and angry or legal replies get no answer from you, ever.
- Never send, schedule or script sending. The user sends, from their own mail or Instagram.
