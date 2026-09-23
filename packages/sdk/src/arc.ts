import type {
  ArcChecklistItemResponse,
  ArcCommentResponse,
  ArcDecisionResponse,
  ArcVoteResponse,
  CreateArcCommentRequest,
  CreateArcDecisionRequest,
  ListArcCommentsResponse,
  ListArcVotesResponse,
  PutArcVoteRequest,
  CreateArcChecklistItemRequest,
  GetArcBoardResponse,
  GetArcRequestResponse,
  ListArcChecklistResponse,
  ListArcRequestsResponse,
  PutArcBoardRequest,
  PutArcBoardResponse,
  UpdateArcChecklistItemRequest,
} from "@saas/contracts/arc";

import type { Transport, RequestOptions } from "./transport.js";

const org = (orgId: string): string => `/v1/organizations/${encodeURIComponent(orgId)}/arc`;

/**
 * Architectural review client — the association's board, its checklist and
 * the requests homeowners file. Org-scoped; maps to `apps/arc-worker` through
 * the api-edge arc facade. The homeowner's public lane is not here: it is
 * served as pages and needs no SDK.
 */
export class ArcClient {
  constructor(private readonly transport: Transport) {}

  /** GET /v1/organizations/:orgId/arc/board */
  getBoard(orgId: string, opts: RequestOptions = {}): Promise<GetArcBoardResponse> {
    return this.transport.request<GetArcBoardResponse>({ method: "GET", path: `${org(orgId)}/board` }, opts);
  }

  /** PUT /v1/organizations/:orgId/arc/board — creating one seeds the default checklist. */
  putBoard(orgId: string, body: PutArcBoardRequest, opts: RequestOptions = {}): Promise<PutArcBoardResponse> {
    return this.transport.request<PutArcBoardResponse>({ method: "PUT", path: `${org(orgId)}/board`, body }, opts);
  }

  /** GET /v1/organizations/:orgId/arc/checklist */
  listChecklist(orgId: string, opts: RequestOptions = {}): Promise<ListArcChecklistResponse> {
    return this.transport.request<ListArcChecklistResponse>({ method: "GET", path: `${org(orgId)}/checklist` }, opts);
  }

  /** POST /v1/organizations/:orgId/arc/checklist */
  createChecklistItem(
    orgId: string,
    body: CreateArcChecklistItemRequest,
    opts: RequestOptions = {},
  ): Promise<ArcChecklistItemResponse> {
    return this.transport.request<ArcChecklistItemResponse>(
      { method: "POST", path: `${org(orgId)}/checklist`, body },
      opts,
    );
  }

  /** PATCH /v1/organizations/:orgId/arc/checklist/:itemId */
  updateChecklistItem(
    orgId: string,
    itemId: string,
    body: UpdateArcChecklistItemRequest,
    opts: RequestOptions = {},
  ): Promise<ArcChecklistItemResponse> {
    return this.transport.request<ArcChecklistItemResponse>(
      { method: "PATCH", path: `${org(orgId)}/checklist/${encodeURIComponent(itemId)}`, body },
      opts,
    );
  }

  /** DELETE /v1/organizations/:orgId/arc/checklist/:itemId — archives. */
  archiveChecklistItem(orgId: string, itemId: string, opts: RequestOptions = {}): Promise<ArcChecklistItemResponse> {
    return this.transport.request<ArcChecklistItemResponse>(
      { method: "DELETE", path: `${org(orgId)}/checklist/${encodeURIComponent(itemId)}` },
      opts,
    );
  }

  /** GET /v1/organizations/:orgId/arc/requests */
  listRequests(
    orgId: string,
    query: { status?: string; limit?: number; cursor?: string } = {},
    opts: RequestOptions = {},
  ): Promise<ListArcRequestsResponse> {
    return this.transport.request<ListArcRequestsResponse>(
      { method: "GET", path: `${org(orgId)}/requests`, query },
      opts,
    );
  }

  /** GET /v1/organizations/:orgId/arc/requests/:requestId */
  getRequest(orgId: string, requestId: string, opts: RequestOptions = {}): Promise<GetArcRequestResponse> {
    return this.transport.request<GetArcRequestResponse>(
      { method: "GET", path: `${org(orgId)}/requests/${encodeURIComponent(requestId)}` },
      opts,
    );
  }

  /** GET /v1/organizations/:orgId/arc/requests/:requestId/comments */
  listComments(orgId: string, requestId: string, opts: RequestOptions = {}): Promise<ListArcCommentsResponse> {
    return this.transport.request<ListArcCommentsResponse>(
      { method: "GET", path: `${org(orgId)}/requests/${encodeURIComponent(requestId)}/comments` },
      opts,
    );
  }

  /** POST /v1/organizations/:orgId/arc/requests/:requestId/comments */
  comment(orgId: string, requestId: string, body: CreateArcCommentRequest, opts: RequestOptions = {}): Promise<ArcCommentResponse> {
    return this.transport.request<ArcCommentResponse>(
      { method: "POST", path: `${org(orgId)}/requests/${encodeURIComponent(requestId)}/comments`, body },
      opts,
    );
  }

  /** GET /v1/organizations/:orgId/arc/requests/:requestId/votes — every vote and the tally. */
  listVotes(orgId: string, requestId: string, opts: RequestOptions = {}): Promise<ListArcVotesResponse> {
    return this.transport.request<ListArcVotesResponse>(
      { method: "GET", path: `${org(orgId)}/requests/${encodeURIComponent(requestId)}/votes` },
      opts,
    );
  }

  /** PUT /v1/organizations/:orgId/arc/requests/:requestId/votes/me — the caller's own vote; a re-vote replaces. */
  vote(orgId: string, requestId: string, body: PutArcVoteRequest, opts: RequestOptions = {}): Promise<ArcVoteResponse> {
    return this.transport.request<ArcVoteResponse>(
      { method: "PUT", path: `${org(orgId)}/requests/${encodeURIComponent(requestId)}/votes/me`, body },
      opts,
    );
  }

  /** POST /v1/organizations/:orgId/arc/requests/:requestId/decision — renders, stores and emails the letter. */
  decide(orgId: string, requestId: string, body: CreateArcDecisionRequest, opts: RequestOptions = {}): Promise<ArcDecisionResponse> {
    return this.transport.request<ArcDecisionResponse>(
      { method: "POST", path: `${org(orgId)}/requests/${encodeURIComponent(requestId)}/decision`, body },
      opts,
    );
  }

  /** GET /v1/organizations/:orgId/arc/requests/:requestId/decision */
  getDecision(orgId: string, requestId: string, opts: RequestOptions = {}): Promise<ArcDecisionResponse> {
    return this.transport.request<ArcDecisionResponse>(
      { method: "GET", path: `${org(orgId)}/requests/${encodeURIComponent(requestId)}/decision` },
      opts,
    );
  }
}
