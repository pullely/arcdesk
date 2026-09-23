# arcdesk-architectural-review (AD) — Implementation status

As-built ≠ intent. This file records what actually shipped, and every place
the code departed from `design.md`.

| Milestone | State | PR |
|---|---|---|
| AD0 — the spec | ✅ landed | #6 |
| AD1 — the public request form | in review | AD-2 |
| AD2 — the review-board workflow | | |
| AD3 — the decision-deadline clock | | |

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
