# arc-worker — overview

Owns the `arc` bounded context: an association's **review board** (one per
organization — the organization is the association), the **checklist** of
documents a request needs, the homeowner's **request**, and the **documents**
uploaded against it, stored in the private R2 bucket `ARC_DOCS`.

The invariant this worker holds: the decision clock starts on a database fact.
`clock_started_at` is written only by one conditional `UPDATE` that also proves
every required, applicable checklist item has a document — never by the arrival
of an email, never by the submission alone.

## What it serves

| Route | Who |
|---|---|
| `GET/PUT /v1/organizations/{org}/arc/board` | `arc.board.read` / `arc.board.manage` |
| `GET/POST /v1/organizations/{org}/arc/checklist`, `PATCH/DELETE …/{ack}` | `arc.board.read` / `arc.board.manage` |
| `GET /v1/organizations/{org}/arc/requests[/{arq}[/documents/{ard}]]` | `arc.request.read` |
| `GET /v1/public/arc/boards/{slug}`, `POST …/requests` | anyone (rate-limited at the edge) |
| `GET /v1/public/arc/requests/{token}`, `PUT …/documents/{key}` | the holder of the status token |
| `GET /arc/f/{slug}`, `GET /arc/s/{token}` | the homeowner's two HTML pages |
