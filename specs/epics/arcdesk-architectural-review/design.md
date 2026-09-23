# arcdesk-architectural-review — design

## 0. The shape

One new bounded context, `arc`, owned by one new Worker, `arc-worker`. It sits
behind `api-edge` like every other runtime worker, reads and writes the shared
D1 database (`PLATFORM_DB`), stores documents in one private R2 bucket per
environment (`ARC_DOCS`), and calls three baseline workers over service
bindings: `membership-worker` (authorization context), `policy-worker`
(authorize) and `notifications-worker` (email). Audit events go to
`events-worker` the way every baseline worker emits them.

| Concept | Is | Reused from the baseline |
|---|---|---|
| Association (HOA) | a cirrus **organization** | identity, membership, billing |
| Committee member | an organization **member** | membership, policy engine roles |
| Review board | `arc_boards`, one per organization | — (new) |
| Homeowner | no account; a hashed status token on the request | — (new) |

Roles map onto the baseline's organization roles, so no new role type exists:
`owner`/`admin` are the chair and the manager (configure the board, decide);
`builder` is a committee member (comment, vote); `viewer` reads.

## 1. The resource

Every id is a UUID in D1 and a prefixed public id on the wire
(`<prefix>_<32 hex>`), exactly as the baseline's `org_`/`prj_` ids are.

### 1.1 AD1 — migration `200_arc_core`

```
arc_boards                                  public id  arb_…
  id                 text   uuid
  org_id             text   the association; UNIQUE — one board per organization
  public_slug        text   UNIQUE; the form lives at /arc/f/{public_slug}
  association_name   text   printed on the form and on every letter
  state              text   'CA' | 'TX' | 'OTHER' — selects the rule set (AD3)
  review_days        int    the association's own review period from its CC&Rs (default 30)
  contact_email      text   where the clock's reminders go (AD3)
  escalation_email   text   nullable; the last rungs of the ladder add this address
  form_enabled       int    0/1 — a disabled board's form answers 404
  created_by, created_at, updated_at

arc_checklist_items                         public id  ack_…
  id, org_id, board_id
  key                text   stable slug, UNIQUE (board_id, key), e.g. 'site_plan'
  label              text   'Site plan showing setbacks'
  required           int    0/1
  categories         text   comma list of request categories it applies to; '' = all
  position           int
  archived_at        text   nullable; an archived item stops gating new requests

arc_requests                                public id  arq_…
  id, org_id, board_id
  number             int    per-board sequence, UNIQUE (board_id, number); shown as AR-0042
  category           text   'solar' | 'ev_charger' | 'exterior_paint' | 'fence' | 'roofing'
                            | 'landscaping' | 'addition' | 'other'
  title, description text
  property_address   text
  applicant_name     text
  applicant_email    text
  status             text   'incomplete' | 'under_review' | 'approved'
                            | 'approved_with_conditions' | 'denied' | 'withdrawn'
  status_token_hash  text   SHA-256 of the homeowner's token; UNIQUE; the raw token is never stored
  submitted_at       text   when the form was posted
  clock_started_at   text   NULL until every required checklist item has a document
  decision_due_on    text   ISO date, filled by the clock (AD3); NULL before
  decided_at         text   nullable
  created_at, updated_at

arc_request_documents                       public id  ard_…
  id, org_id, request_id
  checklist_key      text   which item it satisfies; NULL for an extra attachment
  object_key         text   R2 key: orgs/{org_id}/requests/{request_id}/{ard_id}
  filename, content_type, byte_size, sha256
  uploaded_at        text
```

Checklist completeness is computed, never stored: a request is complete when
every non-archived `required` item whose `categories` is empty or contains the
request's category has at least one document. The transition
`incomplete → under_review` and the write of `clock_started_at` are one
conditional `UPDATE … WHERE status = 'incomplete' AND NOT EXISTS (<a required
item with no document>) RETURNING`, run right after each upload's insert. D1
has no interactive transactions, so the completeness test lives inside the
statement that acts on it: two concurrent final uploads cannot both start the
clock, and a crash between the insert and the update is healed by the next
upload or by the clock's nightly pass (AD3).

### 1.2 AD2 — migration `210_arc_review`

```
arc_comments                                public id  acm_…
  id, org_id, request_id, author_subject_id, body, created_at
  visibility         text   'committee' (internal) | 'applicant' (shown on the status page)

arc_votes                                   public id  avt_…
  id, org_id, request_id, voter_subject_id
  vote               text   'approve' | 'approve_with_conditions' | 'deny' | 'abstain'
  conditions         text   required when vote = 'approve_with_conditions'
  note               text
  created_at, updated_at
  UNIQUE (request_id, voter_subject_id)       -- a re-vote replaces, it never adds

arc_decisions                               public id  adc_…
  id, org_id, request_id UNIQUE               -- one decision per request, immutable
  outcome            text   'approved' | 'approved_with_conditions' | 'denied'
  conditions, rationale text
  vote_tally         text   JSON {approve, approve_with_conditions, deny, abstain} at decision time
  letter_object_key  text   R2 key of the rendered PDF
  letter_sha256      text
  decided_by         text   subject id
  decided_at         text
  letter_emailed_at  text   nullable — the email is advisory, the letter in R2 is the record
```

### 1.3 AD3 — migration `220_arc_clock`

```
arc_deadline_reminders                      public id  adr_…
  id, org_id, request_id
  offset_days        int    14 | 7 | 3 | 1 | 0 | -1 (missed)
  UNIQUE (request_id, offset_days)            -- a rung is sent once, whatever the cron does
  recipients         text   comma list, as sent
  sent_at            text

arc_requests  (+ columns)
  deadline_rule      text   the rule key applied, e.g. 'CA.solar'
  deadline_missed_at text   nullable; set by the cron the first night past decision_due_on
```

The state rules are data, not migrations: `ARC_DEADLINE_RULES` in
`packages/contracts/src/arc.ts`, each `{ state, category, days, deemedApproved,
citation }`. The applied deadline is the **earlier** of
`clock_started_at + rule.days` (when a rule exists for the state and category)
and `clock_started_at + board.review_days`.

| Rule key | Days | On a miss | Citation |
|---|---|---|---|
| `CA.solar` | 45 | deemed approved | Cal. Civ. Code §714 |
| `CA.ev_charger` | 60 | deemed approved | Cal. Civ. Code §4745 |
| `CA.*` | association documents | as the documents say | Cal. Civ. Code §4765 |
| `TX.*` | association documents | as the documents say | Tex. Prop. Code §209.00505 |
| `OTHER.*` | association documents | as the documents say | the association's CC&Rs |

## 2. The API

Envelopes follow the baseline: `{ data, meta: { requestId, cursor } }` on
success, `{ error: { code, message, details, requestId } }` on failure.
Authenticated routes run the baseline pair — membership authorization-context,
then policy authorize — and turn a deny into `not_found`, never `forbidden`.

### 2.1 Board and checklist (authenticated, AD1)

```
GET    /v1/organizations/{org}/arc/board                       arc.board.read
PUT    /v1/organizations/{org}/arc/board                       arc.board.manage   create-or-update
GET    /v1/organizations/{org}/arc/checklist                   arc.board.read
POST   /v1/organizations/{org}/arc/checklist                   arc.board.manage
PATCH  /v1/organizations/{org}/arc/checklist/{ack}             arc.board.manage
DELETE /v1/organizations/{org}/arc/checklist/{ack}             arc.board.manage   archives
```

`PUT board` on an organization with no board seeds the default checklist
(site plan, elevation drawings, materials and colours, contractor licence;
solar: panel layout and spec sheet; EV charger: electrical plan) so a new
association has a working form in one call. `public_slug` conflicts are `409
conflict`.

### 2.2 Requests (authenticated, AD1)

```
GET    /v1/organizations/{org}/arc/requests?status=&cursor=    arc.request.read
GET    /v1/organizations/{org}/arc/requests/{arq}              arc.request.read   + checklist state + documents
GET    /v1/organizations/{org}/arc/requests/{arq}/documents/{ard}   arc.request.read   streams from R2
```

### 2.3 The public lane (no account, AD1)

```
GET    /arc/f/{slug}                                   HTML: the request form
GET    /arc/s/{token}                                  HTML: the homeowner's status page
GET    /v1/public/arc/boards/{slug}                    association name, categories, checklist
POST   /v1/public/arc/boards/{slug}/requests           → 201 { request, statusToken, statusUrl }
GET    /v1/public/arc/requests/{token}                 status, checklist state, documents, due date, decision
PUT    /v1/public/arc/requests/{token}/documents/{checklistKey}   body = the file; → 201 document
GET    /v1/public/arc/requests/{token}/letter          the decision letter PDF (AD2)
```

The token is 32 random bytes, base64url; only its SHA-256 is stored. An unknown
or malformed token is `404`. Uploads accept `application/pdf`, `image/png` and
`image/jpeg`, at most 20 MB, and stream straight into R2 while the SHA-256 is
computed; a document is never overwritten — a second upload for the same
checklist key adds a document. Uploads after the request is decided are `409
request_closed`. The public lane has its own api-edge rate-limit family, keyed
by client IP.

### 2.4 Review (authenticated, AD2)

```
GET    /v1/organizations/{org}/arc/requests/{arq}/comments     arc.request.read
POST   /v1/organizations/{org}/arc/requests/{arq}/comments     arc.request.comment
GET    /v1/organizations/{org}/arc/requests/{arq}/votes        arc.request.read   votes + tally
PUT    /v1/organizations/{org}/arc/requests/{arq}/votes/me     arc.request.vote   upsert the caller's vote
POST   /v1/organizations/{org}/arc/requests/{arq}/decision     arc.request.decide
GET    /v1/organizations/{org}/arc/requests/{arq}/decision     arc.request.read
GET    /v1/organizations/{org}/arc/requests/{arq}/letter       arc.request.read   the PDF
```

Votes and the decision are refused with `409 clock_not_started` while the
request is `incomplete`, and with `409 already_decided` once decided. Deciding
`approved_with_conditions` requires `conditions`; deciding `denied` requires a
`rationale` (both states' statutes require the basis of a denial in writing).

The decision letter is rendered in the worker by a small dependency-free PDF
writer (text, one standard font, A4/Letter): association name, request number,
property, outcome, conditions, rationale, the vote tally, the decision date and
the appeal paragraph — for California the right to reconsideration by the board
in an open meeting (Cal. Civ. Code §4765), for Texas the right to request a
hearing before the board (Tex. Prop. Code §209.00505), otherwise the
association's own appeal wording (`board.appeal_text`, AD2 column).

### 2.5 The clock (AD3)

```
GET    /v1/organizations/{org}/arc/requests?due_within=14      the committee's queue, soonest first
```

plus a `scheduled` handler on `arc-worker`, cron `0 14 * * *` (early morning in
California and Texas), which for every `under_review` request with a
`decision_due_on`:

1. computes days remaining in UTC dates;
2. for each rung in `14, 7, 3, 1, 0` that has been reached, inserts the
   `arc_deadline_reminders` row with `INSERT … ON CONFLICT DO NOTHING` and
   sends only when the insert took — so a re-run, a retry or two overlapping
   crons send nothing twice;
3. past the due date, sets `deadline_missed_at` once and sends the `-1` rung to
   the contact and escalation addresses with the rule's consequence and
   citation.

Rungs `14` and `7` go to `contact_email`; `3`, `1`, `0` and `-1` also go to
`escalation_email`. The clock computes `decision_due_on` at the moment
`clock_started_at` is written (AD3 backfills the requests AD1 and AD2 started).

## 3. The console

- **Review board** (`/orgs/{org}/arc/board`) — AD1: association name, state,
  review period, contact addresses, public slug with a copyable form link, and
  the checklist editor.
- **Requests** (`/orgs/{org}/arc/requests`) — AD1: the list with number,
  category, applicant, status, and checklist completeness; AD3 adds the
  days-remaining badge and sorts by due date.
- **Request** (`/orgs/{org}/arc/requests/{arq}`) — AD2: documents, comments,
  the vote panel (your vote, the tally), the decision form, the letter link.

The homeowner never sees the console. Their two pages (`/arc/f/{slug}`,
`/arc/s/{token}`) are served by `arc-worker` itself through api-edge — plain
server-rendered HTML with a few lines of inline script, no framework, so the
form works on any phone.

## 4. Events, secrets, and integrations

Audit events (emitted to `events-worker`, subject kind `arc_request`, prefix
`arq_`): `arc.board.updated`, `arc.request.submitted`,
`arc.request.document_uploaded`, `arc.request.clock_started` (AD1);
`arc.request.commented`, `arc.request.voted`, `arc.request.decided`,
`arc.request.letter_emailed` (AD2); `arc.request.reminder_sent`,
`arc.request.deadline_missed` (AD3).

Email goes through `packages/notifications-client` to the existing
`notifications-worker`, which gains templates: `arc.request.received` (AD1, to
the homeowner, with the status link), `arc.request.decided` (AD2, to the
homeowner, with the letter link) and `arc.deadline.reminder` (AD3, to the
board). No new provider connection: the baseline's sending path is reused.

New infrastructure, provisioned the way the baseline provisions D1 and KV — a
terraform component, `infra/terraform/cloudflare-r2`, applying
`cloudflare_r2_bucket` for `arcdesk-arc-docs-stage` and `-prod`. It
authenticates with a brokered `CLOUDFLARE_R2_TOKEN` minted from the workspace's
Cloudflare connection under the `r2-data` scope template, so the deploy token
still cannot touch storage. `arc-worker` binds the bucket by name as `ARC_DOCS`.
One cron trigger, on `arc-worker` (AD3).

New policy actions, added to the organization role tables:
`arc.board.read`, `arc.board.manage`, `arc.request.read`,
`arc.request.comment`, `arc.request.vote`, `arc.request.decide`.

## 5. Out of scope

- **Searchable decisions history** (the brief's M3). The decisions table is
  shaped for it (outcome, category, conditions, rationale, date), but search
  and the "similar past rulings" panel are a later epic.
- **Neighbour notices.** Needs addresses of adjoining lots, which the product
  does not hold; later, with a lot roster import.
- **Management-company multi-association plan** (the brief's M4). A company
  managing many associations is today one member of many organizations — the
  baseline already supports that; consolidated billing across them is later.
- **Pausing the clock for a "reasonable request for additional information".**
  Both California statutes stop the clock for it; AD3 records the rule but the
  pause/resume workflow is a later milestone (`AD-D`).
- **Anything needing a credential this build does not hold:** SMS reminders,
  LLM summaries of plans, Stripe. Billing stays on the baseline's Polar plans.
- **E-signature on letters.** The letter is signed by the record (hash in D1,
  immutable object in R2), not by a signature provider.
