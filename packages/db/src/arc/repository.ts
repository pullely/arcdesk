import type { SqlExecutor, SqlRow } from "../d1/executor.js";
import type {
  ArcBoard,
  ArcComment,
  ArcDecision,
  ArcVoteRow,
  CreateArcCommentInput,
  CreateArcDecisionInput,
  UpsertArcVoteInput,
  ArcChecklistItem,
  ArcDocument,
  ArcRepository,
  ArcRequest,
  CreateArcChecklistItemInput,
  CreateArcDocumentInput,
  CreateArcRequestInput,
  ListArcRequestsFilter,
  UpdateArcChecklistItemInput,
  UpsertArcBoardInput,
} from "./types.js";
import { isUniqueViolation } from "../d1/errors.js";

type Row = SqlRow & Record<string, unknown>;

function str(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/** ',solar,ev_charger,' ⇄ ['solar','ev_charger']; '' ⇄ []. */
export function encodeCategories(categories: readonly string[]): string {
  const clean = [...new Set(categories.filter((c) => c.length > 0))].sort();
  return clean.length === 0 ? "" : `,${clean.join(",")},`;
}

export function decodeCategories(value: unknown): string[] {
  const raw = typeof value === "string" ? value : "";
  return raw.split(",").filter((c) => c.length > 0);
}

function mapBoard(row: Row): ArcBoard {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    publicSlug: row.public_slug as string,
    associationName: row.association_name as string,
    state: row.state as string,
    reviewDays: Number(row.review_days),
    contactEmail: row.contact_email as string,
    escalationEmail: str(row.escalation_email),
    formEnabled: Number(row.form_enabled) === 1,
    appealText: str(row.appeal_text),
    createdBy: str(row.created_by),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function mapChecklistItem(row: Row): ArcChecklistItem {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    boardId: row.board_id as string,
    key: row.key as string,
    label: row.label as string,
    required: Number(row.required) === 1,
    categories: decodeCategories(row.categories),
    position: Number(row.position),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    archivedAt: str(row.archived_at),
  };
}

function mapRequest(row: Row): ArcRequest {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    boardId: row.board_id as string,
    number: Number(row.number),
    category: row.category as string,
    title: row.title as string,
    description: (row.description as string) ?? "",
    propertyAddress: row.property_address as string,
    applicantName: row.applicant_name as string,
    applicantEmail: row.applicant_email as string,
    status: row.status as string,
    submittedAt: row.submitted_at as string,
    clockStartedAt: str(row.clock_started_at),
    decisionDueOn: str(row.decision_due_on),
    decidedAt: str(row.decided_at),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function mapDocument(row: Row): ArcDocument {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    requestId: row.request_id as string,
    checklistKey: str(row.checklist_key),
    objectKey: row.object_key as string,
    filename: row.filename as string,
    contentType: row.content_type as string,
    byteSize: Number(row.byte_size),
    sha256: row.sha256 as string,
    uploadedAt: row.uploaded_at as string,
  };
}

const BOARD_COLUMNS = `id, org_id, public_slug, association_name, state, review_days, contact_email,
  escalation_email, form_enabled, appeal_text, created_by, created_at, updated_at`;

const CHECKLIST_COLUMNS = `id, org_id, board_id, key, label, required, categories, position,
  created_at, updated_at, archived_at`;

const REQUEST_COLUMNS = `id, org_id, board_id, number, category, title, description, property_address,
  applicant_name, applicant_email, status, submitted_at, clock_started_at, decision_due_on,
  decided_at, created_at, updated_at`;

function mapComment(row: Row): ArcComment {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    requestId: row.request_id as string,
    authorSubjectId: row.author_subject_id as string,
    body: row.body as string,
    visibility: row.visibility as string,
    createdAt: row.created_at as string,
  };
}

function mapVote(row: Row): ArcVoteRow {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    requestId: row.request_id as string,
    voterSubjectId: row.voter_subject_id as string,
    vote: row.vote as string,
    conditions: str(row.conditions),
    note: str(row.note),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function mapDecision(row: Row): ArcDecision {
  let tally: Record<string, number> = {};
  try {
    tally = JSON.parse(String(row.vote_tally ?? "{}")) as Record<string, number>;
  } catch {
    tally = {};
  }
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    requestId: row.request_id as string,
    outcome: row.outcome as string,
    conditions: str(row.conditions),
    rationale: str(row.rationale),
    voteTally: tally,
    letterObjectKey: row.letter_object_key as string,
    letterSha256: row.letter_sha256 as string,
    decidedBy: str(row.decided_by),
    decidedAt: row.decided_at as string,
    letterEmailedAt: str(row.letter_emailed_at),
  };
}

const COMMENT_COLUMNS = `id, org_id, request_id, author_subject_id, body, visibility, created_at`;
const VOTE_COLUMNS = `id, org_id, request_id, voter_subject_id, vote, conditions, note, created_at, updated_at`;
const DECISION_COLUMNS = `id, org_id, request_id, outcome, conditions, rationale, vote_tally, letter_object_key,
  letter_sha256, decided_by, decided_at, letter_emailed_at`;

const DOCUMENT_COLUMNS = `id, org_id, request_id, checklist_key, object_key, filename, content_type,
  byte_size, sha256, uploaded_at`;

export function createArcRepository(executor: SqlExecutor): ArcRepository {
  async function one(sql: string, params: unknown[]): Promise<Row | null> {
    const result = await executor.execute<Row>(sql, params);
    return result.rows[0] ?? null;
  }

  return {
    async getBoardByOrg(orgId) {
      const row = await one(`SELECT ${BOARD_COLUMNS} FROM arc_boards WHERE org_id = $1`, [orgId]);
      return row ? mapBoard(row) : null;
    },

    async getBoardBySlug(slug) {
      const row = await one(`SELECT ${BOARD_COLUMNS} FROM arc_boards WHERE public_slug = $1`, [slug]);
      return row ? mapBoard(row) : null;
    },

    async getBoardById(boardId) {
      const row = await one(`SELECT ${BOARD_COLUMNS} FROM arc_boards WHERE id = $1`, [boardId]);
      return row ? mapBoard(row) : null;
    },

    async upsertBoard(input: UpsertArcBoardInput) {
      const existing = await one(`SELECT id FROM arc_boards WHERE org_id = $1`, [input.orgId]);
      const row = await one(
        `INSERT INTO arc_boards
           (id, org_id, public_slug, association_name, state, review_days, contact_email,
            escalation_email, form_enabled, appeal_text, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $12, $10, $11, $11)
         ON CONFLICT (org_id) DO UPDATE SET
           public_slug = excluded.public_slug,
           association_name = excluded.association_name,
           state = excluded.state,
           review_days = excluded.review_days,
           contact_email = excluded.contact_email,
           escalation_email = excluded.escalation_email,
           form_enabled = excluded.form_enabled,
           appeal_text = excluded.appeal_text,
           updated_at = excluded.updated_at
         RETURNING ${BOARD_COLUMNS}`,
        [
          input.id,
          input.orgId,
          input.publicSlug,
          input.associationName,
          input.state,
          input.reviewDays,
          input.contactEmail,
          input.escalationEmail,
          input.formEnabled ? 1 : 0,
          input.createdBy,
          input.now,
          input.appealText,
        ],
      );
      if (!row) throw new Error("arc: board upsert returned no row");
      return { board: mapBoard(row), created: existing === null };
    },

    async listChecklist(boardId, includeArchived) {
      const result = await executor.execute<Row>(
        `SELECT ${CHECKLIST_COLUMNS} FROM arc_checklist_items
          WHERE board_id = $1 ${includeArchived ? "" : "AND archived_at IS NULL"}
          ORDER BY position ASC, created_at ASC, id ASC`,
        [boardId],
      );
      return result.rows.map(mapChecklistItem);
    },

    async getChecklistItem(orgId, itemId) {
      const row = await one(
        `SELECT ${CHECKLIST_COLUMNS} FROM arc_checklist_items WHERE org_id = $1 AND id = $2`,
        [orgId, itemId],
      );
      return row ? mapChecklistItem(row) : null;
    },

    async createChecklistItem(input: CreateArcChecklistItemInput) {
      try {
        const row = await one(
          `INSERT INTO arc_checklist_items
             (id, org_id, board_id, key, label, required, categories, position, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
           RETURNING ${CHECKLIST_COLUMNS}`,
          [
            input.id,
            input.orgId,
            input.boardId,
            input.key,
            input.label,
            input.required ? 1 : 0,
            encodeCategories(input.categories),
            input.position,
            input.now,
          ],
        );
        return row ? mapChecklistItem(row) : null;
      } catch (err) {
        if (isUniqueViolation(err)) return null;
        throw err;
      }
    },

    async updateChecklistItem(orgId, itemId, patch: UpdateArcChecklistItemInput) {
      const row = await one(
        `UPDATE arc_checklist_items SET
           label = COALESCE($3, label),
           required = COALESCE($4, required),
           categories = COALESCE($5, categories),
           position = COALESCE($6, position),
           updated_at = $7
         WHERE org_id = $1 AND id = $2 AND archived_at IS NULL
         RETURNING ${CHECKLIST_COLUMNS}`,
        [
          orgId,
          itemId,
          patch.label ?? null,
          patch.required === undefined ? null : patch.required ? 1 : 0,
          patch.categories === undefined ? null : encodeCategories(patch.categories),
          patch.position ?? null,
          patch.now,
        ],
      );
      return row ? mapChecklistItem(row) : null;
    },

    async archiveChecklistItem(orgId, itemId, now) {
      const row = await one(
        `UPDATE arc_checklist_items SET archived_at = COALESCE(archived_at, $3), updated_at = $3
          WHERE org_id = $1 AND id = $2
          RETURNING ${CHECKLIST_COLUMNS}`,
        [orgId, itemId, now],
      );
      return row ? mapChecklistItem(row) : null;
    },

    async allocateRequestNumber(boardId) {
      const row = await one(
        `UPDATE arc_boards SET next_number = next_number + 1
          WHERE id = $1
          RETURNING next_number - 1 AS number`,
        [boardId],
      );
      if (!row) throw new Error("arc: board not found while allocating a request number");
      return Number(row.number);
    },

    async createRequest(input: CreateArcRequestInput) {
      const row = await one(
        `INSERT INTO arc_requests
           (id, org_id, board_id, number, category, title, description, property_address,
            applicant_name, applicant_email, status, status_token_hash, submitted_at,
            created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'incomplete', $11, $12, $12, $12)
         RETURNING ${REQUEST_COLUMNS}`,
        [
          input.id,
          input.orgId,
          input.boardId,
          input.number,
          input.category,
          input.title,
          input.description,
          input.propertyAddress,
          input.applicantName,
          input.applicantEmail,
          input.statusTokenHash,
          input.now,
        ],
      );
      if (!row) throw new Error("arc: request insert returned no row");
      return mapRequest(row);
    },

    async getRequest(orgId, requestId) {
      const row = await one(
        `SELECT ${REQUEST_COLUMNS} FROM arc_requests WHERE org_id = $1 AND id = $2`,
        [orgId, requestId],
      );
      return row ? mapRequest(row) : null;
    },

    async getRequestByTokenHash(tokenHash) {
      const row = await one(
        `SELECT ${REQUEST_COLUMNS} FROM arc_requests WHERE status_token_hash = $1`,
        [tokenHash],
      );
      return row ? mapRequest(row) : null;
    },

    async listRequests(orgId, filter: ListArcRequestsFilter) {
      const params: unknown[] = [orgId];
      let where = "org_id = $1";
      if (filter.status) {
        params.push(filter.status);
        where += ` AND status = $${params.length}`;
      }
      if (filter.before) {
        params.push(filter.before.createdAt, filter.before.id);
        where += ` AND (created_at < $${params.length - 1} OR (created_at = $${params.length - 1} AND id < $${params.length}))`;
      }
      params.push(filter.limit);
      const result = await executor.execute<Row>(
        `SELECT ${REQUEST_COLUMNS} FROM arc_requests WHERE ${where}
          ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
        params,
      );
      return result.rows.map(mapRequest);
    },

    async createDocument(input: CreateArcDocumentInput) {
      const row = await one(
        `INSERT INTO arc_request_documents
           (id, org_id, request_id, checklist_key, object_key, filename, content_type,
            byte_size, sha256, uploaded_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING ${DOCUMENT_COLUMNS}`,
        [
          input.id,
          input.orgId,
          input.requestId,
          input.checklistKey,
          input.objectKey,
          input.filename,
          input.contentType,
          input.byteSize,
          input.sha256,
          input.uploadedAt,
        ],
      );
      if (!row) throw new Error("arc: document insert returned no row");
      return mapDocument(row);
    },

    async listDocuments(requestId) {
      const result = await executor.execute<Row>(
        `SELECT ${DOCUMENT_COLUMNS} FROM arc_request_documents
          WHERE request_id = $1 ORDER BY uploaded_at ASC, id ASC`,
        [requestId],
      );
      return result.rows.map(mapDocument);
    },

    async getDocument(orgId, requestId, documentId) {
      const row = await one(
        `SELECT ${DOCUMENT_COLUMNS} FROM arc_request_documents
          WHERE org_id = $1 AND request_id = $2 AND id = $3`,
        [orgId, requestId, documentId],
      );
      return row ? mapDocument(row) : null;
    },

    async tryStartClock(requestId, now) {
      const row = await one(
        `UPDATE arc_requests
            SET status = 'under_review', clock_started_at = $2, updated_at = $2
          WHERE id = $1
            AND status = 'incomplete'
            AND clock_started_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM arc_checklist_items c
               WHERE c.board_id = arc_requests.board_id
                 AND c.required = 1
                 AND c.archived_at IS NULL
                 AND (c.categories = '' OR instr(c.categories, ',' || arc_requests.category || ',') > 0)
                 AND NOT EXISTS (
                   SELECT 1 FROM arc_request_documents d
                    WHERE d.request_id = arc_requests.id AND d.checklist_key = c.key
                 )
            )
          RETURNING ${REQUEST_COLUMNS}`,
        [requestId, now],
      );
      return row ? mapRequest(row) : null;
    },

    async createComment(input: CreateArcCommentInput) {
      const row = await one(
        `INSERT INTO arc_comments (id, org_id, request_id, author_subject_id, body, visibility, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING ${COMMENT_COLUMNS}`,
        [input.id, input.orgId, input.requestId, input.authorSubjectId, input.body, input.visibility, input.createdAt],
      );
      if (!row) throw new Error("arc: comment insert returned no row");
      return mapComment(row);
    },

    async listComments(requestId, visibility) {
      const params: unknown[] = [requestId];
      let where = "request_id = $1";
      if (visibility) {
        params.push(visibility);
        where += " AND visibility = $2";
      }
      const result = await executor.execute<Row>(
        `SELECT ${COMMENT_COLUMNS} FROM arc_comments WHERE ${where} ORDER BY created_at ASC, id ASC`,
        params,
      );
      return result.rows.map(mapComment);
    },

    async upsertVote(input: UpsertArcVoteInput) {
      const row = await one(
        `INSERT INTO arc_votes (id, org_id, request_id, voter_subject_id, vote, conditions, note, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
         ON CONFLICT (request_id, voter_subject_id) DO UPDATE SET
           vote = excluded.vote,
           conditions = excluded.conditions,
           note = excluded.note,
           updated_at = excluded.updated_at
         RETURNING ${VOTE_COLUMNS}`,
        [input.id, input.orgId, input.requestId, input.voterSubjectId, input.vote, input.conditions, input.note, input.now],
      );
      if (!row) throw new Error("arc: vote upsert returned no row");
      return mapVote(row);
    },

    async listVotes(requestId) {
      const result = await executor.execute<Row>(
        `SELECT ${VOTE_COLUMNS} FROM arc_votes WHERE request_id = $1 ORDER BY created_at ASC, id ASC`,
        [requestId],
      );
      return result.rows.map(mapVote);
    },

    async createDecision(input: CreateArcDecisionInput) {
      try {
        const row = await one(
          `INSERT INTO arc_decisions
             (id, org_id, request_id, outcome, conditions, rationale, vote_tally, letter_object_key,
              letter_sha256, letter_token_hash, decided_by, decided_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           RETURNING ${DECISION_COLUMNS}`,
          [
            input.id,
            input.orgId,
            input.requestId,
            input.outcome,
            input.conditions,
            input.rationale,
            JSON.stringify(input.voteTally),
            input.letterObjectKey,
            input.letterSha256,
            input.letterTokenHash,
            input.decidedBy,
            input.decidedAt,
          ],
        );
        return row ? mapDecision(row) : null;
      } catch (err) {
        if (isUniqueViolation(err)) return null;
        throw err;
      }
    },

    async getDecision(requestId) {
      const row = await one(`SELECT ${DECISION_COLUMNS} FROM arc_decisions WHERE request_id = $1`, [requestId]);
      return row ? mapDecision(row) : null;
    },

    async getDecisionByLetterTokenHash(tokenHash) {
      const row = await one(`SELECT ${DECISION_COLUMNS} FROM arc_decisions WHERE letter_token_hash = $1`, [tokenHash]);
      return row ? mapDecision(row) : null;
    },

    async markLetterEmailed(decisionId, at) {
      await executor.execute(
        `UPDATE arc_decisions SET letter_emailed_at = COALESCE(letter_emailed_at, $2) WHERE id = $1`,
        [decisionId, at],
      );
    },

    async closeRequest(requestId, status, decidedAt) {
      const row = await one(
        `UPDATE arc_requests SET status = $2, decided_at = $3, updated_at = $3
          WHERE id = $1 AND status = 'under_review'
          RETURNING ${REQUEST_COLUMNS}`,
        [requestId, status, decidedAt],
      );
      return row ? mapRequest(row) : null;
    },
  };
}
