# arcdesk-architectural-review (AD) — Implementation status

As-built ≠ intent. This file records what actually shipped, and every place
the code departed from `design.md`.

| Milestone | State | PR |
|---|---|---|
| AD0 — the spec | ✅ landed | #6 |
| AD1 — the public request form | ✅ landed (AD-2) | #11 |
| AD2 — the review-board workflow | ✅ landed (AD-3) | #12 |
| AD3 — the decision-deadline clock | ✅ landed (AD-4) | #13 |

## Departures from the design

### AD1 (task AD-2)

- **Baseline departure — the cirrus D1 fix.** `factory/patches/cirrus-d1-fix.patch`
  is applied in this task. The cirrus baseline (baseline-v12) ships
  Postgres-only SQL that D1 cannot run: `appendEventWithAudit` in
  `packages/db/src/events/repository.ts` is a data-modifying CTE
  (`WITH inserted_event AS (INSERT …)`, `row_to_json`), and the membership
  repository's organization-create and invitation-accept have the same shape —
  so every audited write failed and no customer could create an organization.
  The patch rewrites both as portable statements and adds the real-SQLite
  schema harness under `tests/db`. It is not arcdesk product code.
- **Every worker's `component.yaml` carries a redeploy marker.** A change to a
  shared package (`packages/db`, `packages/policy-engine`,
  `packages/contracts`) does not redeploy the workers that bundle it; the
  marker is the only way the fleet picks up the D1 fix and the `arc.*` actions.
- **`arc-worker` is an allowed internal caller of `notifications-worker`**
  (`NOTIFICATIONS_INTERNAL_ACTOR_VALUES` in `packages/contracts`). Not in the
  design; without it every arc email is refused `403`.
- **`arc-worker` writes its audit entries itself** (`appendEvent`, then an
  `INSERT … SELECT` into `events_audit_entries`), best-effort, rather than
  through `appendEventWithAudit`. It predates the D1 fix and is portable either way.
- **Writes report their outcome through `RETURNING`, never `rowCount`.** The
  D1 executor reports `rowCount = rows.length`, so a write without `RETURNING`
  always reports 0 on D1; `tests/arc-worker/src/d1-rowcount.test.ts` pins it on
  real SQLite.
- **Verified live (stage)**: organization create 201 (the D1 fix), board, public
  form, submit, upload; the clock started on live D1 only when the last required
  document arrived; the PDF streamed back from R2 byte-for-byte. **Prod**:
  `/health` and the public lane answer; the authenticated R2 round-trip was not
  run on prod, because prod sign-in sends a real magic-link email.

### AD2 (task AD-3)

- Trap 22: the vote upsert, the decision insert and the request close all
  report through `RETURNING`; `markLetterEmailed` is fire-and-forget and
  inspects nothing.
- **Verified live (stage)**: a second vote replaced the first (one row);
  a denial without rationale was `422`; the decision rendered a `%PDF-` letter
  whose SHA-256, served back by status token from R2, equals
  `arc_decisions.letter_sha256`; a second decision was `409 already_decided`;
  `arc.request.voted`, `arc.request.decided` and `arc.request.letter_emailed`
  are in the organization's audit trail.
- **The appeal wording is a draft (risk AD-A).** It needs HOA-attorney review
  before a real association relies on the letter.

### AD3 (task AD-4)

- Trap 22: a rung is claimed with `INSERT … ON CONFLICT DO NOTHING RETURNING id`
  and counted from the returned rows; the missed flag is
  `UPDATE … WHERE deadline_missed_at IS NULL RETURNING`. Both pinned through the
  real D1 executor on real SQLite in `d1-rowcount.test.ts`.
- SMS reminders are not built (no provider credential).
