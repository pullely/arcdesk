# arcdesk-architectural-review — risks and open questions

Each entry is a letter, a title, and a state: **RISK** (open, with a
mitigation), **RESOLVED** (decided; say what and why), **ACCEPTED** (a cost we
carry knowingly), **SETTLED** (decided for now; revisit on a stated cadence).

## AD-A — The rules table is legal content (RISK, mitigated)

A wrong number in `ARC_DEADLINE_RULES` is worse than no number: a board trusting
a 60-day clock on a 45-day statute loses the request by deemed approval. The
two California figures (solar 45 days, Cal. Civ. Code §714; EV charger 60 days,
§4745) are the ones the maintainer's demand signals cite; Texas is modelled as
"the association's documents govern" with the §209.00505 hearing right on the
letter, not as a statutory clock. Mitigation: every rule carries its citation
into the reminder email and the letter; the applied deadline is always the
*earlier* of statute and CC&Rs, so an error in the association's own period
can only make the clock stricter; the listing is recruiting an HOA attorney
advisor and the table is the first thing they review. Arcdesk says "your rules
as configured", never "legal advice".

## AD-B — Public form abuse (RISK, mitigated)

The form and the upload route take anonymous traffic and write to D1 and R2.
Mitigation: an api-edge rate-limit family keyed by client IP for the whole
public lane; a 20 MB per-file cap and a three-type allow-list; uploads are only
possible with the request's own token, so an attacker can fill only a request
they created; the board can switch the form off (`form_enabled`). A Turnstile
challenge is the next step if abuse appears (the Cloudflare skill exists; no
credential is needed beyond the account we hold).

## AD-C — R2 provisioning through a brokered token (RESOLVED)

R2 was disabled on the account at the start of the portfolio run and enabled by
the operator on 2026-09-23. The bucket is provisioned by terraform like D1 and
KV, under a brokered `CLOUDFLARE_R2_TOKEN` (`r2-data` scope template:
"Workers R2 Storage Write") rather than by widening the deploy token, so code
deploys still cannot touch stored plans.

## AD-D — The information-request pause (ACCEPTED)

Both California statutes stop the clock while the association waits on "a
reasonable request for additional information". AD3 does not model the pause:
the checklist is the mechanism that keeps an incomplete request from starting
the clock at all, which covers the common case. A request that needs more after
the clock started is handled by the board today (comment to the applicant,
decide on time). The pause/resume workflow is a later milestone.

## AD-E — Deemed approval is reported, not enacted (SETTLED)

When a statutory clock runs out, Arcdesk flags `deadline_missed_at` and
escalates with the consequence; it does not change the request's status to
approved on its own. Whether a request is in fact deemed approved depends on
facts the product cannot see (a written information request, a tolling
agreement). Revisit with the attorney advisor after the first three
associations are live.

## AD-F — Email is advisory; the record is D1 + R2 (ACCEPTED)

Decision letters and reminders are sent through the baseline's best-effort
notifications path, which never fails the caller. A bounced decision email does
not un-decide a request: the letter is immutable in R2, hashed in D1, and on
the homeowner's status page. `letter_emailed_at` records the send so the board
can see it and resend by hand.

## AD-G — Out-of-scope features that need credentials (ACCEPTED)

SMS reminders (no Twilio credential), LLM summaries of submitted plans (no model
key) and Stripe (billing stays on the baseline's Polar plans) are later
milestones, not this epic. None of AD1–AD3 depends on them.

## AD-H — The brief's M3 and M4 (SETTLED)

The searchable decisions history (M3) and the management-company plan (M4) are
not built here. The decisions table carries everything M3 needs to search; a
management company is already modelled as one member of many organizations.
Revisit after AD3 ships.
