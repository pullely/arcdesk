-- 210_arc_review
-- Architectural review workflow — committee comments, one vote per member per
-- request, and the single immutable decision with its letter in R2
-- Bounded context: arc
-- schema arc: The committee's side of a request. A vote is an upsert keyed on
-- (request, voter); a decision is one row per request, never updated except to
-- record that its letter was emailed.

ALTER TABLE arc_boards ADD COLUMN appeal_text TEXT;

-- column arc_boards.appeal_text: The association's own appeal wording, printed on every decision letter after the state's statutory paragraph.

CREATE TABLE IF NOT EXISTS arc_comments (
  id                 TEXT PRIMARY KEY,
  org_id             TEXT NOT NULL,
  request_id         TEXT NOT NULL REFERENCES arc_requests (id) ON DELETE CASCADE,
  author_subject_id  TEXT NOT NULL,
  body               TEXT NOT NULL,
  visibility         TEXT NOT NULL DEFAULT 'committee' CHECK (visibility IN ('committee','applicant')),
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- table arc_comments: A committee comment on a request. 'applicant' comments are shown on the homeowner's status page.

CREATE INDEX IF NOT EXISTS idx_arc_comments_request ON arc_comments (request_id, created_at);

CREATE TABLE IF NOT EXISTS arc_votes (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL,
  request_id        TEXT NOT NULL REFERENCES arc_requests (id) ON DELETE CASCADE,
  voter_subject_id  TEXT NOT NULL,
  vote              TEXT NOT NULL CHECK (vote IN ('approve','approve_with_conditions','deny','abstain')),
  conditions        TEXT,
  note              TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- table arc_votes: One committee member's current vote on a request. A re-vote replaces it.

CREATE UNIQUE INDEX IF NOT EXISTS uq_arc_votes_request_voter ON arc_votes (request_id, voter_subject_id);

CREATE TABLE IF NOT EXISTS arc_decisions (
  id                 TEXT PRIMARY KEY,
  org_id             TEXT NOT NULL,
  request_id         TEXT NOT NULL REFERENCES arc_requests (id) ON DELETE CASCADE,
  outcome            TEXT NOT NULL CHECK (outcome IN ('approved','approved_with_conditions','denied')),
  conditions         TEXT,
  rationale          TEXT,
  vote_tally         TEXT NOT NULL DEFAULT '{}',
  letter_object_key  TEXT NOT NULL,
  letter_sha256      TEXT NOT NULL,
  letter_token_hash  TEXT NOT NULL,
  decided_by         TEXT,
  decided_at         TEXT NOT NULL,
  letter_emailed_at  TEXT
);

-- table arc_decisions: The committee's decision on a request. One per request; immutable once written.
-- column arc_decisions.letter_sha256: SHA-256 of the PDF in R2 — the letter is the record, the email is a courtesy.
-- column arc_decisions.letter_token_hash: SHA-256 of the capability token in the decision email's letter link.

CREATE UNIQUE INDEX IF NOT EXISTS uq_arc_decisions_request ON arc_decisions (request_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_arc_decisions_letter_token ON arc_decisions (letter_token_hash);
CREATE INDEX IF NOT EXISTS idx_arc_decisions_org ON arc_decisions (org_id, decided_at DESC);
