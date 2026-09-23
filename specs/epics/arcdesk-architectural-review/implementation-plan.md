# arcdesk-architectural-review — implementation plan

Milestones land in order. Each is one or more tasks, each task one pull
request, each pull request landed with `orun pr land`. A milestone is marked
✅ here when its "done when" list is true, and recorded in
`IMPLEMENTATION-STATUS.md`.

## AD0 — the spec

This doc set, merged to `main` and attached to the epic with `orun spec push`.

**Done when**
- the five documents are on `main`
- `orun spec list --epic arcdesk-architectural-review` shows them

## AD1 — the public request form

The first user-visible change. `packages/db` gains the `arc` bounded context
and migration `200_arc_core` (boards, checklist items, requests, documents)
with its repository. `infra/terraform/cloudflare-r2` provisions the
`arcdesk-arc-docs-{stage,prod}` buckets under a brokered `r2-data` token.
`apps/arc-worker` is new: the board and checklist settings, the authenticated
request list and read, the public lane (form page, board read, submit, upload,
status page) and document streaming out of R2. `apps/api-edge` gains the arc
facade — authenticated routes through `resolveActor`, public routes without it
under their own IP-keyed rate-limit family — and the `ARC_WORKER` binding.
`packages/policy-engine` gains the six `arc.*` actions; `packages/contracts`
and `packages/sdk` gain the wire. `notifications-worker` gains the
`arc.request.received` template. The Solo profile goes off (an association is
many members). The console gains the board settings and requests list pages.

**Done when**
- migration `200_arc_core` is in the manifest and replays green against `node:sqlite`; applied on stage and prod
- `GET /v1/public/arc/boards/{slug}` answers through api-edge on stage and prod, and `/arc/f/{slug}` serves the form
- a request submitted without every required document is `incomplete` with `clock_started_at` null
- uploading the last required document flips it to `under_review` and sets `clock_started_at` in one conditional statement
- a PDF uploaded through the public lane streams back byte-for-byte (same SHA-256) from R2
- the status link answers for the right token and `404` for any other

## AD2 — the review-board workflow

Migration `210_arc_review` (comments, votes, decisions, `arc_boards.appeal_text`).
`arc-worker` gains comments, the vote upsert with conditions and the tally, and
the decision: validate, render the PDF letter with the state's appeal language,
put it in R2, write the immutable decision row, email the homeowner through
`notifications-worker` (`arc.request.decided`), emit the audit events. The
status page and `GET /v1/public/arc/requests/{token}/letter` serve the letter.
The console gains the request detail page.

**Done when**
- a committee member's second vote replaces the first (one row per voter)
- voting or deciding an `incomplete` request is `409 clock_not_started`; a second decision is `409 already_decided`
- a denial without a rationale, or conditional approval without conditions, is `422`
- a decision writes a `%PDF-` letter to R2 whose SHA-256 matches `arc_decisions.letter_sha256`, served to the homeowner by token
- `arc.request.voted` and `arc.request.decided` appear in the organization's audit trail

## AD3 — the decision-deadline clock

Migration `220_arc_clock` (`arc_deadline_reminders`, `deadline_rule`,
`deadline_missed_at`). `ARC_DEADLINE_RULES` in `packages/contracts`, with
citations. `decision_due_on` is computed when the clock starts and backfilled
for requests already running. `arc-worker` gains a `scheduled` handler (cron
`0 14 * * *`) that walks the 14/7/3/1/0 ladder and the missed rung, each rung
guarded by the unique row, and the `due_within` queue filter. The status page
shows the due date; the console list shows days remaining.

**Done when**
- a California solar request's due date is `clock_started_at + 45 days` even when the board's own period is longer; a request with no statutory rule uses the board's period
- the cron, run twice for the same day, sends each rung exactly once (the unique index holds)
- a request past its due date is flagged `deadline_missed_at` once and escalated with the rule's citation
- the cron trigger is deployed on stage and prod (`wrangler deploy` output lists it)

## Sequencing note

AD1 has to come first: without a request and its `clock_started_at` there is
nothing to vote on and nothing to time. AD2 and AD3 both build only on AD1 and
could run in parallel; AD2 goes first because a decision is what stops the
clock, so the clock's "decided requests are not chased" rule has something to
test against. Nothing here is gated on a provider we do not hold: R2 is
enabled on the account, email is the baseline's, and the rules are data.
