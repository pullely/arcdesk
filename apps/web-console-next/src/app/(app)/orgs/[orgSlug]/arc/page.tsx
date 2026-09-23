"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { ClipboardCheck } from "lucide-react";
import { OrgScope } from "@/components/shell/org-scope";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { CopyButton } from "@/components/ui/copy-button";
import { Input } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { useToast } from "@/components/ui/toast";
import { wrap } from "@/lib/api";
import type { PublicArcBoard, PublicArcRequest, PutArcBoardRequest, ArcState } from "@saas/contracts/arc";
import { ARC_REQUEST_CATEGORY_LABELS, ARC_STATES } from "@saas/contracts/arc";

const STATUS: Record<string, { label: string; variant: "default" | "secondary" | "warning" | "success" | "destructive" }> = {
  incomplete: { label: "Waiting for documents", variant: "warning" },
  under_review: { label: "Under review", variant: "default" },
  approved: { label: "Approved", variant: "success" },
  approved_with_conditions: { label: "Approved with conditions", variant: "success" },
  denied: { label: "Denied", variant: "destructive" },
  withdrawn: { label: "Withdrawn", variant: "secondary" },
};

export default function ArcPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} orgSlug={slug} orgName={org.name} />}</OrgScope>;
}

function Inner({ orgId, orgSlug, orgName }: { orgId: string; orgSlug: string; orgName: string }) {
  const { client } = useSession();
  const board = useApiQuery(qk.arcBoard(orgId), () => wrap(async () => (await client.arc.getBoard(orgId)).board));
  const hasBoard = !!board.data;
  const requests = useApiQuery(
    qk.arcRequests(orgId),
    () => wrap(async () => (await client.arc.listRequests(orgId)).requests),
    { enabled: hasBoard },
  );
  const [editing, setEditing] = React.useState(false);

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Review board</h1>
        <p className="text-sm text-muted-foreground">
          Architectural requests from homeowners. The decision clock starts only when a request&apos;s
          required documents are all in.
        </p>
      </header>

      {board.loading ? (
        <Card>
          <CardHeader>
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-3 w-72 mt-2" />
          </CardHeader>
        </Card>
      ) : board.error && board.error.code !== "not_found" ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-destructive">{board.error.code}</CardTitle>
            <CardDescription>{board.error.message}</CardDescription>
          </CardHeader>
        </Card>
      ) : !board.data || editing ? (
        <BoardForm
          orgId={orgId}
          initial={board.data}
          defaults={{ associationName: orgName, publicSlug: orgSlug }}
          onDone={() => {
            setEditing(false);
            board.reload();
          }}
          onCancel={board.data ? () => setEditing(false) : undefined}
        />
      ) : (
        <BoardSummary board={board.data} onEdit={() => setEditing(true)} />
      )}

      {hasBoard && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Requests</CardTitle>
            <CardDescription>Newest first.</CardDescription>
          </CardHeader>
          <CardContent>
            {requests.loading ? (
              <Skeleton className="h-24 w-full" />
            ) : requests.error ? (
              <p className="text-sm text-destructive">{requests.error.message}</p>
            ) : (requests.data ?? []).length === 0 ? (
              <div className="flex flex-col items-center py-10 text-center text-sm text-muted-foreground">
                <ClipboardCheck className="h-8 w-8 mb-3 text-primary" />
                No requests yet. Share the form link with homeowners.
              </div>
            ) : (
              <RequestsTable requests={requests.data ?? []} />
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function BoardSummary({ board, onEdit }: { board: PublicArcBoard; onEdit: () => void }) {
  const { target } = useSession();
  const formUrl = `${target.url}${board.formUrlPath}`;
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">{board.associationName}</CardTitle>
            <CardDescription>
              {board.state === "OTHER" ? "Other state" : board.state} · {board.reviewDays}-day review period ·
              reminders to {board.contactEmail}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={board.formEnabled ? "success" : "secondary"}>
              {board.formEnabled ? "Form open" : "Form closed"}
            </Badge>
            <Button variant="outline" size="sm" onClick={onEdit}>
              Edit
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">Homeowner form:</span>
          <a className="font-mono text-xs underline break-all" href={formUrl} target="_blank" rel="noreferrer">
            {formUrl}
          </a>
          <CopyButton value={formUrl} label="Copy link" />
        </div>
      </CardContent>
    </Card>
  );
}

function BoardForm({
  orgId,
  initial,
  defaults,
  onDone,
  onCancel,
}: {
  orgId: string;
  initial: PublicArcBoard | null;
  defaults: { associationName: string; publicSlug: string };
  onDone: () => void;
  onCancel: (() => void) | undefined;
}) {
  const { client } = useSession();
  const { toast } = useToast();
  const [form, setForm] = React.useState<PutArcBoardRequest>({
    associationName: initial?.associationName ?? defaults.associationName,
    publicSlug: initial?.publicSlug ?? defaults.publicSlug,
    state: initial?.state ?? "CA",
    reviewDays: initial?.reviewDays ?? 30,
    contactEmail: initial?.contactEmail ?? "",
    escalationEmail: initial?.escalationEmail ?? null,
    formEnabled: initial?.formEnabled ?? true,
  });
  const [busy, setBusy] = React.useState(false);
  const set = <K extends keyof PutArcBoardRequest>(k: K, v: PutArcBoardRequest[K]) => setForm((f) => ({ ...f, [k]: v }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const r = await wrap(async () => (await client.arc.putBoard(orgId, form)).board);
    setBusy(false);
    if (!r.ok) {
      toast({ kind: "error", title: "Could not save the board", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: initial ? "Board updated" : "Review board opened" });
    onDone();
  }

  const field = "block text-sm font-medium mt-3 mb-1";
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{initial ? "Edit the review board" : "Open your review board"}</CardTitle>
        <CardDescription>
          {initial
            ? "Changes apply to requests submitted from now on."
            : "One step: this publishes the homeowner form with a starter document checklist."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="max-w-lg">
          <label className={field} htmlFor="arc-name">Association name</label>
          <Input id="arc-name" value={form.associationName} onChange={(e) => set("associationName", e.target.value)} required />
          <label className={field} htmlFor="arc-slug">Form address</label>
          <Input id="arc-slug" value={form.publicSlug} onChange={(e) => set("publicSlug", e.target.value.toLowerCase())} required />
          <label className={field} htmlFor="arc-state">State (selects the deadline rules)</label>
          <select
            id="arc-state"
            className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            value={form.state}
            onChange={(e) => set("state", e.target.value as ArcState)}
          >
            {ARC_STATES.map((s) => (
              <option key={s} value={s}>{s === "OTHER" ? "Other" : s}</option>
            ))}
          </select>
          <label className={field} htmlFor="arc-days">Review period in your CC&amp;Rs (days)</label>
          <Input
            id="arc-days"
            type="number"
            min={1}
            max={365}
            value={form.reviewDays}
            onChange={(e) => set("reviewDays", Number(e.target.value))}
          />
          <label className={field} htmlFor="arc-contact">Committee contact email (reminders go here)</label>
          <Input id="arc-contact" type="email" value={form.contactEmail} onChange={(e) => set("contactEmail", e.target.value)} required />
          <label className={field} htmlFor="arc-esc">Escalation email (optional — the last reminders add it)</label>
          <Input
            id="arc-esc"
            type="email"
            value={form.escalationEmail ?? ""}
            onChange={(e) => set("escalationEmail", e.target.value || null)}
          />
          <label className="mt-3 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.formEnabled ?? true} onChange={(e) => set("formEnabled", e.target.checked)} />
            The homeowner form is open
          </label>
          <div className="mt-5 flex gap-2">
            <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
            {onCancel && (
              <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function RequestsTable({ requests }: { requests: PublicArcRequest[] }) {
  return (
    <Table>
      <THead>
        <TR>
          <TH>Ref</TH>
          <TH>Request</TH>
          <TH>Applicant</TH>
          <TH>Status</TH>
          <TH>Submitted</TH>
        </TR>
      </THead>
      <TBody>
        {requests.map((r) => {
          const s = STATUS[r.status] ?? { label: r.status, variant: "secondary" as const };
          return (
            <TR key={r.id}>
              <TD className="font-mono text-xs">{r.reference}</TD>
              <TD>
                <div className="font-medium">{r.title}</div>
                <div className="text-xs text-muted-foreground">
                  {ARC_REQUEST_CATEGORY_LABELS[r.category] ?? r.category} · {r.propertyAddress}
                </div>
              </TD>
              <TD className="text-sm">{r.applicantName}</TD>
              <TD>
                <Badge variant={s.variant}>{s.label}</Badge>
              </TD>
              <TD className="text-xs text-muted-foreground">{r.submittedAt.slice(0, 10)}</TD>
            </TR>
          );
        })}
      </TBody>
    </Table>
  );
}
