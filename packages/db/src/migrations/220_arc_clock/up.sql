-- 220_arc_clock
-- Architectural review decision-deadline clock — the rule each request's due date
-- came from, the missed-deadline flag, and one row per reminder rung sent
-- Bounded context: arc
-- schema arc: The clock is derived, not scheduled: decision_due_on is computed when
-- clock_started_at is written, and the nightly cron walks running requests. A rung
-- is sent only when its (request, offset) row is newly inserted, so no re-run,
-- retry or overlapping cron can send it twice.

ALTER TABLE arc_requests ADD COLUMN deadline_rule TEXT;

ALTER TABLE arc_requests ADD COLUMN deadline_missed_at TEXT;

-- column arc_requests.deadline_rule: Key of the rule that set decision_due_on, e.g. 'CA.solar' or 'TX.documents'.
-- column arc_requests.deadline_missed_at: Set once, by the clock, the first run after decision_due_on passes undecided.

CREATE INDEX IF NOT EXISTS idx_arc_requests_running_due ON arc_requests (status, decision_due_on);

CREATE TABLE IF NOT EXISTS arc_deadline_reminders (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  request_id    TEXT NOT NULL REFERENCES arc_requests (id) ON DELETE CASCADE,
  offset_days   INTEGER NOT NULL,
  recipients    TEXT NOT NULL DEFAULT '',
  sent_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- table arc_deadline_reminders: One row per reminder rung sent for a request: 14, 7, 3, 1, 0 days before the due date, and -1 for the missed deadline.

CREATE UNIQUE INDEX IF NOT EXISTS uq_arc_deadline_reminders_rung ON arc_deadline_reminders (request_id, offset_days);
