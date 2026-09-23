-- 200_arc_core
-- Architectural review foundation — the association's review board, its document
-- checklist, the homeowner's request and the documents uploaded against it
-- Bounded context: arc
-- schema arc: Architectural review bounded context — owns the review board (one per
-- organization; the organization IS the association), the checklist that decides
-- when a request is complete, the request itself, and the documents stored in R2.
-- The clock starts on a database fact (clock_started_at), never on arrival.

CREATE TABLE IF NOT EXISTS arc_boards (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL,
  public_slug       TEXT NOT NULL,
  association_name  TEXT NOT NULL,
  state             TEXT NOT NULL DEFAULT 'CA' CHECK (state IN ('CA','TX','OTHER')),
  review_days       INTEGER NOT NULL DEFAULT 30 CHECK (review_days BETWEEN 1 AND 365),
  contact_email     TEXT NOT NULL,
  escalation_email  TEXT,
  form_enabled      INTEGER NOT NULL DEFAULT 1 CHECK (form_enabled IN (0,1)),
  next_number       INTEGER NOT NULL DEFAULT 1,
  created_by        TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- table arc_boards: The association's architectural review board. One per organization.
-- column arc_boards.public_slug: The public form lives at /arc/f/{public_slug}. Unique across the product.
-- column arc_boards.review_days: The association's own review period from its CC&Rs; the clock uses the stricter of this and the state rule.
-- column arc_boards.next_number: Per-board request sequence, advanced with UPDATE … RETURNING so two submissions never share a number.

CREATE UNIQUE INDEX IF NOT EXISTS uq_arc_boards_org ON arc_boards (org_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_arc_boards_slug ON arc_boards (public_slug);

CREATE TABLE IF NOT EXISTS arc_checklist_items (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL,
  board_id     TEXT NOT NULL REFERENCES arc_boards (id) ON DELETE CASCADE,
  key          TEXT NOT NULL,
  label        TEXT NOT NULL,
  required     INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0,1)),
  categories   TEXT NOT NULL DEFAULT '',
  position     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  archived_at  TEXT
);

-- table arc_checklist_items: One document the board requires (or accepts) with a request.
-- column arc_checklist_items.categories: Comma-delimited request categories the item applies to, stored with leading and trailing commas (',solar,ev_charger,'); '' means every category.

CREATE UNIQUE INDEX IF NOT EXISTS uq_arc_checklist_board_key ON arc_checklist_items (board_id, key);
CREATE INDEX IF NOT EXISTS idx_arc_checklist_board ON arc_checklist_items (board_id, position);

CREATE TABLE IF NOT EXISTS arc_requests (
  id                 TEXT PRIMARY KEY,
  org_id             TEXT NOT NULL,
  board_id           TEXT NOT NULL REFERENCES arc_boards (id) ON DELETE CASCADE,
  number             INTEGER NOT NULL,
  category           TEXT NOT NULL
                     CHECK (category IN ('solar','ev_charger','exterior_paint','fence','roofing','landscaping','addition','other')),
  title              TEXT NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  property_address   TEXT NOT NULL,
  applicant_name     TEXT NOT NULL,
  applicant_email    TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'incomplete'
                     CHECK (status IN ('incomplete','under_review','approved','approved_with_conditions','denied','withdrawn')),
  status_token_hash  TEXT NOT NULL,
  submitted_at       TEXT NOT NULL,
  clock_started_at   TEXT,
  decision_due_on    TEXT,
  decided_at         TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- table arc_requests: One architectural request from a homeowner. Every query must scope by org_id, except the token lookup.
-- column arc_requests.status_token_hash: SHA-256 (hex) of the homeowner's status token. The raw token is never stored.
-- column arc_requests.clock_started_at: NULL until every required checklist item has a document. The decision clock runs from here.

CREATE UNIQUE INDEX IF NOT EXISTS uq_arc_requests_board_number ON arc_requests (board_id, number);
CREATE UNIQUE INDEX IF NOT EXISTS uq_arc_requests_token ON arc_requests (status_token_hash);
CREATE INDEX IF NOT EXISTS idx_arc_requests_org_created ON arc_requests (org_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_arc_requests_org_status ON arc_requests (org_id, status);

CREATE TABLE IF NOT EXISTS arc_request_documents (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL,
  request_id     TEXT NOT NULL REFERENCES arc_requests (id) ON DELETE CASCADE,
  checklist_key  TEXT,
  object_key     TEXT NOT NULL,
  filename       TEXT NOT NULL,
  content_type   TEXT NOT NULL,
  byte_size      INTEGER NOT NULL,
  sha256         TEXT NOT NULL,
  uploaded_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- table arc_request_documents: A file uploaded against a request. Immutable: a correction is a new document.
-- column arc_request_documents.object_key: R2 key in the ARC_DOCS bucket: orgs/{org_id}/requests/{request_id}/{document_id}.

CREATE INDEX IF NOT EXISTS idx_arc_documents_request ON arc_request_documents (request_id, uploaded_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_arc_documents_object ON arc_request_documents (object_key);
