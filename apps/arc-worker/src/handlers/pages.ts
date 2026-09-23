import { ARC_REQUEST_CATEGORY_LABELS, type ArcPublicBoard, type ArcPublicStatus } from "@saas/contracts/arc";
import type { Env } from "../env.js";
import { openDb } from "../context.js";
import { escapeHtml as e, htmlResponse } from "../http.js";
import { toArcPublicBoard } from "../present.js";
import { buildStatus, EXTRA_DOCUMENT_KEY, loadByToken, loadOpenBoard } from "./public.js";

// The homeowner's two pages. Plain server-rendered HTML and a few lines of
// inline script, no framework and no build step: the form has to work on any
// phone, from a link in a newsletter, for someone who will use it once.

const STYLE = `
:root{--bg:#f6f5f1;--card:#fff;--ink:#1d2a2a;--muted:#5d6b6b;--line:#dcdfd8;--accent:#2f6b5a;--warn:#a4541a}
@media (prefers-color-scheme:dark){:root{--bg:#141a19;--card:#1d2524;--ink:#e8ecea;--muted:#9aa8a5;--line:#2e3a38;--accent:#6fbf9f;--warn:#e19a5e}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:640px;margin:0 auto;padding:24px 16px 64px}h1{font-size:1.5rem;margin:0 0 4px}h2{font-size:1.1rem;margin:24px 0 8px}
.muted{color:var(--muted)}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:20px;margin-top:16px}
label{display:block;font-weight:600;margin:14px 0 4px}input,select,textarea{width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink);font:inherit}
textarea{min-height:96px}button{margin-top:18px;padding:12px 18px;border:0;border-radius:8px;background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer}
button[disabled]{opacity:.6}ul.check{list-style:none;padding:0;margin:0}ul.check li{padding:10px 0;border-top:1px solid var(--line)}ul.check li:first-child{border-top:0}
.ok{color:var(--accent);font-weight:600}.todo{color:var(--warn);font-weight:600}.pill{display:inline-block;padding:2px 10px;border-radius:999px;border:1px solid var(--line);font-size:.9rem}
.err{color:var(--warn)}code{word-break:break-all}`;

function page(title: string, body: string, script = ""): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${e(title)}</title><style>${STYLE}</style></head>
<body><main>${body}<p class="muted" style="margin-top:32px;font-size:.85rem">Arcdesk — architectural review for homeowner associations.</p></main>${script ? `<script>${script}</script>` : ""}</body></html>`;
}

const STATUS_LABELS: Record<string, string> = {
  incomplete: "Waiting for documents",
  under_review: "Under review",
  approved: "Approved",
  approved_with_conditions: "Approved with conditions",
  denied: "Denied",
  withdrawn: "Withdrawn",
};

// Shared by both pages: upload a file against a checklist key with the token.
const UPLOAD_SCRIPT = `
async function arcUpload(token, key, input, out){
  const f = input.files && input.files[0]; if(!f) return;
  out.textContent = "Uploading…"; input.disabled = true;
  try{
    const r = await fetch("/v1/public/arc/requests/"+encodeURIComponent(token)+"/documents/"+encodeURIComponent(key)+"?filename="+encodeURIComponent(f.name),{method:"PUT",headers:{"content-type":f.type||"application/octet-stream"},body:f});
    const j = await r.json().catch(()=>({}));
    if(!r.ok){ out.textContent = (j.error&&j.error.message)||("Upload failed ("+r.status+")"); input.disabled=false; return; }
    location.reload();
  }catch(err){ out.textContent = "Upload failed — check your connection and try again."; input.disabled=false; }
}`;

function renderForm(board: ArcPublicBoard): string {
  const options = board.categories.map((c) => `<option value="${e(c.key)}">${e(c.label)}</option>`).join("");
  const checklistJson = JSON.stringify(board.checklist).replace(/</g, "\\u003c");
  const body = `
<h1>${e(board.associationName)}</h1>
<p class="muted">Architectural review request. The committee's decision clock starts once every required document below is uploaded.</p>
<form id="f" class="card" novalidate>
  <label for="category">What are you changing?</label><select id="category" name="category">${options}</select>
  <label for="title">Short description</label><input id="title" name="title" maxlength="160" required placeholder="e.g. Rooftop solar, 12 panels, south roof">
  <label for="description">Details (optional)</label><textarea id="description" name="description" maxlength="5000"></textarea>
  <label for="propertyAddress">Property address</label><input id="propertyAddress" name="propertyAddress" maxlength="300" required>
  <label for="applicantName">Your name</label><input id="applicantName" name="applicantName" maxlength="160" required>
  <label for="applicantEmail">Your email</label><input id="applicantEmail" name="applicantEmail" type="email" maxlength="254" required>
  <h2>Documents you will need</h2><ul class="check" id="needed"></ul>
  <p class="muted">You upload these on the next page.</p>
  <button id="go" type="submit">Submit request</button> <span id="msg" class="err"></span>
</form>`;
  const script = `
const CHECKLIST = ${checklistJson}; const SLUG = ${JSON.stringify(board.publicSlug)};
const cat = document.getElementById("category"), needed = document.getElementById("needed");
function renderNeeded(){ const c = cat.value; needed.innerHTML = "";
  CHECKLIST.filter(i => i.categories.length===0 || i.categories.includes(c)).forEach(i => {
    const li = document.createElement("li"); li.textContent = i.label + (i.required ? "" : " (optional)"); needed.appendChild(li); }); }
cat.addEventListener("change", renderNeeded); renderNeeded();
document.getElementById("f").addEventListener("submit", async (ev) => { ev.preventDefault();
  const go = document.getElementById("go"), msg = document.getElementById("msg"); go.disabled = true; msg.textContent = "";
  const data = Object.fromEntries(new FormData(ev.target).entries());
  try{ const r = await fetch("/v1/public/arc/boards/"+encodeURIComponent(SLUG)+"/requests",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(data)});
    const j = await r.json().catch(()=>({}));
    if(!r.ok){ const f = j.error && j.error.details && j.error.details.fields; msg.textContent = f ? Object.entries(f).map(([k,v])=>k+": "+v.join(", ")).join("; ") : ((j.error&&j.error.message)||"Something went wrong"); go.disabled=false; return; }
    location.href = j.data.statusUrlPath;
  }catch(err){ msg.textContent = "Could not reach the server — try again."; go.disabled=false; } });`;
  return page(`${board.associationName} — architectural request`, body, script);
}

function renderStatus(status: ArcPublicStatus, token: string): string {
  const open = status.status === "incomplete" || status.status === "under_review";
  const items = status.checklist
    .map((c) => {
      const mark = c.satisfied ? `<span class="ok">✓ received</span>` : c.required ? `<span class="todo">needed</span>` : `<span class="muted">optional</span>`;
      const upload = open
        ? `<div><input type="file" accept="application/pdf,image/png,image/jpeg" data-key="${e(c.key)}"><small class="err" data-out="${e(c.key)}"></small></div>`
        : "";
      return `<li><div>${e(c.label)} — ${mark}</div>${upload}</li>`;
    })
    .join("");
  const docs = status.documents
    .map((d) => `<li>${e(d.filename)} <span class="muted">(${Math.max(1, Math.round(d.byteSize / 1024))} KB, ${e(d.uploadedAt.slice(0, 10))})</span></li>`)
    .join("");
  const clock = status.clockStartedAt
    ? `<p>Complete since <strong>${e(status.clockStartedAt.slice(0, 10))}</strong>${status.decisionDueOn ? ` — decision due by <strong>${e(status.decisionDueOn)}</strong>` : ""}.</p>`
    : `<p class="todo">The committee's clock has not started: upload every document marked “needed”.</p>`;
  const body = `
<h1>${e(status.reference)} · ${e(status.associationName)}</h1>
<p class="muted">${e(ARC_REQUEST_CATEGORY_LABELS[status.category] ?? status.category)} at ${e(status.propertyAddress)}</p>
<div class="card"><p><span class="pill">${e(STATUS_LABELS[status.status] ?? status.status)}</span> ${e(status.title)}</p>${clock}
<p class="muted">Keep this page's address: it is your only link to this request.</p></div>
<div class="card"><h2 style="margin-top:0">Checklist</h2><ul class="check">${items || "<li class='muted'>No documents required.</li>"}</ul>
${open ? `<h2>Anything else</h2><input type="file" accept="application/pdf,image/png,image/jpeg" data-key="${EXTRA_DOCUMENT_KEY}"><small class="err" data-out="${EXTRA_DOCUMENT_KEY}"></small>` : ""}</div>
<div class="card"><h2 style="margin-top:0">Uploaded</h2><ul class="check">${docs || "<li class='muted'>Nothing yet.</li>"}</ul></div>`;
  const script = `${UPLOAD_SCRIPT}
const TOKEN = ${JSON.stringify(token)};
document.querySelectorAll("input[type=file][data-key]").forEach(inp => inp.addEventListener("change", () =>
  arcUpload(TOKEN, inp.dataset.key, inp, document.querySelector('[data-out="'+inp.dataset.key+'"]'))));`;
  return page(`${status.reference} — ${status.associationName}`, body, script);
}

function notFoundPage(): Response {
  return htmlResponse(page("Not found", `<h1>Not found</h1><p class="muted">This link is not (or no longer) valid. Check the address with your association.</p>`), 404);
}

export async function handleFormPage(env: Env, slug: string): Promise<Response> {
  const db = openDb(env);
  if (!db) return htmlResponse(page("Unavailable", "<h1>Temporarily unavailable</h1>"), 503);
  try {
    const board = await loadOpenBoard(db, slug);
    if (!board) return notFoundPage();
    const items = await db.arc.listChecklist(board.id, false);
    return htmlResponse(renderForm(toArcPublicBoard(board, items)));
  } catch {
    return htmlResponse(page("Unavailable", "<h1>Temporarily unavailable</h1>"), 503);
  } finally {
    await db.dispose();
  }
}

export async function handleStatusPage(env: Env, token: string): Promise<Response> {
  const db = openDb(env);
  if (!db) return htmlResponse(page("Unavailable", "<h1>Temporarily unavailable</h1>"), 503);
  try {
    const found = await loadByToken(db, token);
    if (!found) return notFoundPage();
    return htmlResponse(renderStatus(await buildStatus(db, found.board, found.request), token));
  } catch {
    return htmlResponse(page("Unavailable", "<h1>Temporarily unavailable</h1>"), 503);
  } finally {
    await db.dispose();
  }
}
