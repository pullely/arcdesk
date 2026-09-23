# Epic: arcdesk-architectural-review (AD)

**Homeowner associations run architectural review by email and spreadsheet, so
an incomplete request quietly starts a statutory clock nobody is watching, a
missed deadline can turn into an automatic approval (California deems solar
applications approved after 45 days and EV-charger applications after 60), and
two committees rule two ways on the same fence. This epic makes the request
itself the unit of record: a public form that will not start the clock until
the document checklist is complete, a review board that votes and writes its
conditions against that record, and a decision-deadline clock computed from the
state's rules and the association's own documents that escalates before it
runs out. The one design idea: the clock starts on a database fact
(`clock_started_at`, set only when every required document is in R2), not on
the date an email arrived.**

Arcdesk is for self-managed HOAs and small community-management companies,
starting in California and Texas. A homeowner files a request from a link the
board publishes, uploads plans against a checklist, and gets a status link. The
committee sees every open request with its days-remaining, comments, votes and
attaches conditions; the chair records the decision, and Arcdesk renders a
decision letter with the appeal language, stores it in R2 and emails it to the
homeowner. Nobody has to remember a deadline: the nightly clock does.

## Status

| Field | Value |
|-------|-------|
| Status | In progress |
| Cluster | **AD** (AD0–AD3) |
| Owner(s) | `apps/arc-worker` (the resource, the public form, the clock) · `apps/api-edge` (the facade) · `packages/db` (migrations `200`–`220`) · `packages/contracts` + `packages/sdk` (the wire) · `infra/terraform/cloudflare-r2` (the document bucket) · `apps/notifications-worker` (the templates) · `apps/web-console-next` (the surface) |
| Builds on | `cirrus baseline-v12` — organizations as associations, members as the committee, the policy engine for who may vote and decide, `notifications-worker` for email, the audit trail in `events-worker`, api-edge rate limiting |
| Changes | Adds one bounded context (`arc`), one worker, one R2 bucket per environment and one cron trigger; every baseline context is reused, none is modified beyond new actions, templates and a subject prefix |
| Decisions locked | (1) An association is a cirrus organization; the committee is its members — no second tenancy axis. (2) The clock starts only when every required checklist item has a document in R2; the submission date alone never starts it. (3) Deadline = the stricter of the state rule for the request's category and the association's own review period; rules are data in `packages/contracts`, each with its citation. (4) The homeowner never has an account: a hashed, unguessable status token is their capability. (5) Decision letters are rendered in the worker as PDF, stored immutably in R2, and are the record — not the email. |
| Gate | AD1 is the first user-visible change (the public form). AD2 makes the board usable. AD3 is what makes a missed deadline impossible to miss. |
| Shipped as | |

## Read order

1. `design.md` — the resource, the routes, the surfaces, what is out of scope
2. `implementation-plan.md` — the milestones and what "done" means for each
3. `risks-and-open-questions.md` — what could go wrong and what was decided
4. `IMPLEMENTATION-STATUS.md` — what actually shipped (kept distinct from intent)

## Milestones at a glance

| Milestone | What it lands | Done when |
|---|---|---|
| AD0 — the spec | this doc set | merged and pushed with `orun spec push` |
| AD1 — the public request form | `arc` context (migration `200_arc_core`), R2 bucket per env, `arc-worker`, board + checklist settings, the public form page, document uploads to R2, the homeowner status link, console request list | a request missing a required document stays `incomplete` with no clock; the last upload starts the clock; a PDF round-trips byte-for-byte on stage and prod |
| AD2 — the review-board workflow | comments, votes with conditions, the decision, the PDF decision letter with appeal language archived in R2 and emailed, audit events | a decision renders a letter into R2, the homeowner's status link serves it, and every step is in the audit trail |
| AD3 — the decision-deadline clock | state rules (CA solar 45 days, CA EV charger 60 days, association documents otherwise), `decision_due_on`, a nightly cron with an idempotent 14/7/3/1/0-day reminder ladder, missed-deadline flagging | the cron sends each rung once and only once; a request past its due date is flagged `missed` and escalated with the rule's citation |

Later, deliberately not built here: the searchable decisions history (the
brief's M3), neighbour notices, and the management-company multi-association
plan (the brief's M4). See `risks-and-open-questions.md`.
