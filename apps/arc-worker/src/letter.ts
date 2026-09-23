import {
  ARC_APPEAL_LANGUAGE,
  ARC_DECISION_OUTCOME_LABELS,
  ARC_REQUEST_CATEGORY_LABELS,
  arcRequestReference,
  type ArcDecisionOutcome,
  type ArcRequestCategory,
  type ArcState,
  type ArcVoteTally,
} from "@saas/contracts/arc";
import type { ArcBoard, ArcRequest } from "@saas/db/arc";
import { renderPdf, type PdfBlock } from "./pdf.js";

export interface LetterInput {
  board: ArcBoard;
  request: ArcRequest;
  outcome: ArcDecisionOutcome;
  conditions: string | null;
  rationale: string | null;
  tally: ArcVoteTally;
  decidedAt: string;
}

function longDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso.slice(0, 10)
    : d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

/** The appeal paragraph: the state's statutory route, then the association's own words. */
export function appealParagraphs(board: ArcBoard): string[] {
  const out: string[] = [];
  const statutory = ARC_APPEAL_LANGUAGE[board.state as ArcState] ?? null;
  if (statutory) out.push(`${statutory.text} (${statutory.citation}.)`);
  if (board.appealText) out.push(board.appealText);
  if (out.length === 0) {
    out.push(
      "If you disagree with this decision, write to the association at the contact address below and ask how it may be appealed under the association's governing documents.",
    );
  }
  return out;
}

/** The letter as blocks — separated from rendering so tests can read it as text. */
export function letterBlocks(input: LetterInput): PdfBlock[] {
  const { board, request, outcome, conditions, rationale, tally, decidedAt } = input;
  const reference = arcRequestReference(request.number);
  const blocks: PdfBlock[] = [
    { text: board.associationName, bold: true, size: 16, after: 2 },
    { text: "Architectural Review — Decision Letter", size: 11, after: 18 },
    { text: longDate(decidedAt), after: 12 },
    { text: `${request.applicantName}\n${request.propertyAddress}`, after: 14 },
    { text: `Re: ${reference} — ${request.title}`, bold: true, after: 4 },
    {
      text: `${ARC_REQUEST_CATEGORY_LABELS[request.category as ArcRequestCategory] ?? request.category}, submitted ${longDate(request.submittedAt)}${request.clockStartedAt ? `, complete ${longDate(request.clockStartedAt)}` : ""}.`,
      after: 14,
    },
    { text: `Decision: ${ARC_DECISION_OUTCOME_LABELS[outcome]}`, bold: true, size: 13, after: 10 },
  ];
  if (conditions) {
    blocks.push({ text: "Conditions of approval", bold: true, after: 2 });
    blocks.push({ text: conditions, after: 12 });
  }
  if (rationale) {
    blocks.push({ text: outcome === "denied" ? "Reasons for this decision" : "Notes from the committee", bold: true, after: 2 });
    blocks.push({ text: rationale, after: 12 });
  }
  const votes = `Approve ${tally.approve} · Approve with conditions ${tally.approve_with_conditions} · Deny ${tally.deny} · Abstain ${tally.abstain}`;
  blocks.push({ text: "Committee vote", bold: true, after: 2 });
  blocks.push({ text: votes, after: 12 });
  blocks.push({ text: "Your right to appeal", bold: true, after: 2 });
  for (const p of appealParagraphs(board)) blocks.push({ text: p, after: 8 });
  blocks.push({ text: `Contact: ${board.contactEmail}`, after: 18 });
  blocks.push({
    text: `This letter is the association's record of decision on ${reference}. Issued through Arcdesk.`,
    size: 9,
  });
  return blocks;
}

export function renderLetter(input: LetterInput): Uint8Array {
  return renderPdf(letterBlocks(input), {
    title: `${input.board.associationName} — ${arcRequestReference(input.request.number)} decision`,
  });
}
