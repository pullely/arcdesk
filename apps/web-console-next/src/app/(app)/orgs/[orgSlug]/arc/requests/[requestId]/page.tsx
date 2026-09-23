"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { OrgScope } from "@/components/shell/org-scope";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/input";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { useToast } from "@/components/ui/toast";
import { wrap } from "@/lib/api";
import type { ArcDecisionOutcome, ArcVote, GetArcRequestResponse } from "@saas/contracts/arc";
import { ARC_DECISION_OUTCOME_LABELS, ARC_REQUEST_CATEGORY_LABELS } from "@saas/contracts/arc";

const VOTE_LABELS: Record<ArcVote, string> = {
  approve: "Approve",
  approve_with_conditions: "Approve with conditions",
  deny: "Deny",
  abstain: "Abstain",
};

export default function ArcRequestPage() {
  const params = useParams<{ orgSlug: string; requestId: string }>();
  const slug = params?.orgSlug ?? "";
  const requestId = params?.requestId ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} orgSlug={slug} requestId={requestId} />}</OrgScope>;
}

/** Download a file behind the bearer token (a plain <a href> would not carry it). */
function useAuthedDownload() {
  const { target, token } = useSession();
  return React.useCallback(
    async (path: string, filename: string) => {
      const res = await fetch(`${target.url}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
      if (!res.ok) return false;
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      return true;
    },
    [target, token],
  );
}

function Inner({ orgId, orgSlug, requestId }: { orgId: string; orgSlug: string; requestId: string }) {
  const { client } = useSession();
  const detail = useApiQuery(qk.arcRequest(orgId, requestId), () => wrap(async () => client.arc.getRequest(orgId, requestId)));

  if (detail.loading) return <Skeleton className="h-40 w-full" />;
  if (detail.error || !detail.data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-destructive">{detail.error?.code ?? "not_found"}</CardTitle>
          <CardDescription>{detail.error?.message ?? "Request not found"}</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  return <Detail orgId={orgId} orgSlug={orgSlug} requestId={requestId} data={detail.data} reload={detail.reload} />;
}

function Detail({
  orgId,
  orgSlug,
  requestId,
  data,
  reload,
}: {
  orgId: string;
  orgSlug: string;
  requestId: string;
  data: GetArcRequestResponse;
  reload: () => void;
}) {
  const { request, checklist, documents } = data;
  const download = useAuthedDownload();
  const open = request.status === "under_review";
  const decided = !["incomplete", "under_review"].includes(request.status);
  const base = `/v1/organizations/${orgId}/arc/requests/${requestId}`;

  return (
    <div className="space-y-5">
      <header>
        <Link href={`/orgs/${orgSlug}/arc`} className="text-xs text-muted-foreground hover:underline">
          ← Review board
        </Link>
        <h1 className="text-xl font-semibold tracking-tight mt-1">
          {request.reference} · {request.title}
        </h1>
        <p className="text-sm text-muted-foreground">
          {ARC_REQUEST_CATEGORY_LABELS[request.category] ?? request.category} at {request.propertyAddress} — {request.applicantName} (
          {request.applicantEmail})
        </p>
        <p className="text-sm mt-1">
          {request.clockStartedAt ? (
            <>Complete since {request.clockStartedAt.slice(0, 10)}{request.decisionDueOn ? ` · decision due ${request.decisionDueOn}` : ""}</>
          ) : (
            <span className="text-warning-foreground">Waiting for required documents — the clock has not started.</span>
          )}
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Documents</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {checklist.map((c) => (
            <div key={c.key} className="flex items-center justify-between gap-2">
              <span>{c.label}</span>
              <Badge variant={c.satisfied ? "success" : c.required ? "warning" : "secondary"}>
                {c.satisfied ? "received" : c.required ? "needed" : "optional"}
              </Badge>
            </div>
          ))}
          {documents.length > 0 && <hr className="my-2" />}
          {documents.map((d) => (
            <div key={d.id} className="flex items-center justify-between gap-2">
              <span className="truncate">{d.filename}</span>
              <Button variant="outline" size="sm" onClick={() => void download(`${base}/documents/${d.id}`, d.filename)}>
                Download
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>

      <Comments orgId={orgId} requestId={requestId} />
      <Votes orgId={orgId} requestId={requestId} open={open} />
      {decided ? (
        <DecisionView orgId={orgId} requestId={requestId} reference={request.reference} />
      ) : (
        <DecisionForm orgId={orgId} requestId={requestId} open={open} onDecided={reload} />
      )}
    </div>
  );
}

function Comments({ orgId, requestId }: { orgId: string; requestId: string }) {
  const { client } = useSession();
  const { toast } = useToast();
  const comments = useApiQuery(qk.arcComments(orgId, requestId), () =>
    wrap(async () => (await client.arc.listComments(orgId, requestId)).comments),
  );
  const [body, setBody] = React.useState("");
  const [toApplicant, setToApplicant] = React.useState(false);
  async function post() {
    const r = await wrap(async () => client.arc.comment(orgId, requestId, { body, visibility: toApplicant ? "applicant" : "committee" }));
    if (!r.ok) return toast({ kind: "error", title: "Comment failed", description: r.error.message });
    setBody("");
    comments.reload();
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Comments</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {(comments.data ?? []).map((c) => (
          <div key={c.id} className="border-l-2 pl-3">
            <div>{c.body}</div>
            <div className="text-xs text-muted-foreground">
              {c.createdAt.slice(0, 16).replace("T", " ")} · {c.visibility === "applicant" ? "shown to the homeowner" : "committee only"}
            </div>
          </div>
        ))}
        <Textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Add a comment" />
        <div className="flex items-center justify-between">
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={toApplicant} onChange={(e) => setToApplicant(e.target.checked)} />
            Show to the homeowner
          </label>
          <Button size="sm" disabled={!body.trim()} onClick={() => void post()}>
            Comment
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Votes({ orgId, requestId, open }: { orgId: string; requestId: string; open: boolean }) {
  const { client } = useSession();
  const { toast } = useToast();
  const votes = useApiQuery(qk.arcVotes(orgId, requestId), () => wrap(async () => client.arc.listVotes(orgId, requestId)));
  const [vote, setVote] = React.useState<ArcVote>("approve");
  const [conditions, setConditions] = React.useState("");
  async function cast() {
    const r = await wrap(async () =>
      client.arc.vote(orgId, requestId, { vote, conditions: vote === "approve_with_conditions" ? conditions : null }),
    );
    if (!r.ok) return toast({ kind: "error", title: "Vote failed", description: r.error.message });
    toast({ kind: "success", title: "Vote recorded" });
    votes.reload();
  }
  const t = votes.data?.tally;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Committee vote</CardTitle>
        {t && (
          <CardDescription>
            Approve {t.approve} · With conditions {t.approve_with_conditions} · Deny {t.deny} · Abstain {t.abstain}
          </CardDescription>
        )}
      </CardHeader>
      {open && (
        <CardContent className="space-y-2 text-sm">
          <select className="h-9 w-full rounded-md border bg-background px-3" value={vote} onChange={(e) => setVote(e.target.value as ArcVote)}>
            {(Object.keys(VOTE_LABELS) as ArcVote[]).map((v) => (
              <option key={v} value={v}>{VOTE_LABELS[v]}</option>
            ))}
          </select>
          {vote === "approve_with_conditions" && (
            <Textarea value={conditions} onChange={(e) => setConditions(e.target.value)} placeholder="Conditions" />
          )}
          <Button size="sm" onClick={() => void cast()}>Cast or change my vote</Button>
        </CardContent>
      )}
    </Card>
  );
}

function DecisionForm({ orgId, requestId, open, onDecided }: { orgId: string; requestId: string; open: boolean; onDecided: () => void }) {
  const { client } = useSession();
  const { toast } = useToast();
  const [outcome, setOutcome] = React.useState<ArcDecisionOutcome>("approved");
  const [conditions, setConditions] = React.useState("");
  const [rationale, setRationale] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  if (!open) return null;
  async function decide() {
    setBusy(true);
    const r = await wrap(async () =>
      client.arc.decide(orgId, requestId, {
        outcome,
        conditions: outcome === "approved_with_conditions" ? conditions : null,
        rationale: rationale || null,
      }),
    );
    setBusy(false);
    if (!r.ok) return toast({ kind: "error", title: "Decision not recorded", description: r.error.message });
    toast({ kind: "success", title: "Decision recorded", description: "The letter is in the archive and on its way to the homeowner." });
    onDecided();
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Record the decision</CardTitle>
        <CardDescription>Final: renders the decision letter with the appeal language, archives it and emails the homeowner.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <select className="h-9 w-full rounded-md border bg-background px-3" value={outcome} onChange={(e) => setOutcome(e.target.value as ArcDecisionOutcome)}>
          {(Object.keys(ARC_DECISION_OUTCOME_LABELS) as ArcDecisionOutcome[]).map((o) => (
            <option key={o} value={o}>{ARC_DECISION_OUTCOME_LABELS[o]}</option>
          ))}
        </select>
        {outcome === "approved_with_conditions" && (
          <Textarea value={conditions} onChange={(e) => setConditions(e.target.value)} placeholder="Conditions of approval" />
        )}
        <Textarea
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
          placeholder={outcome === "denied" ? "Reasons for the denial (required)" : "Notes (optional)"}
        />
        <Button disabled={busy} onClick={() => void decide()}>{busy ? "Recording…" : "Record decision"}</Button>
      </CardContent>
    </Card>
  );
}

function DecisionView({ orgId, requestId, reference }: { orgId: string; requestId: string; reference: string }) {
  const { client } = useSession();
  const download = useAuthedDownload();
  const decision = useApiQuery(qk.arcDecision(orgId, requestId), () =>
    wrap(async () => (await client.arc.getDecision(orgId, requestId)).decision),
  );
  const d = decision.data;
  if (!d) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Decision: {ARC_DECISION_OUTCOME_LABELS[d.outcome]}</CardTitle>
        <CardDescription>
          {d.decidedAt.slice(0, 10)} · letter {d.letterEmailedAt ? "emailed" : "not emailed"} · SHA-256 {d.letterSha256.slice(0, 12)}…
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {d.conditions && <p><strong>Conditions:</strong> {d.conditions}</p>}
        {d.rationale && <p><strong>{d.outcome === "denied" ? "Reasons" : "Notes"}:</strong> {d.rationale}</p>}
        <Button variant="outline" size="sm" onClick={() => void download(d.letterPath, `${reference}-decision.pdf`)}>
          Download the letter
        </Button>
      </CardContent>
    </Card>
  );
}
