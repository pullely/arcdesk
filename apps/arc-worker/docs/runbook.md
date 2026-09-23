# arc-worker — runbook

- **Health:** `GET /health` on the worker (via a service binding) reports which
  bindings are configured: database, documents (R2), membership, policy,
  notifications.
- **A form answers 404:** the board's `form_enabled` is off, or the slug is
  wrong. `GET /v1/organizations/{org}/arc/board` shows both.
- **Uploads answer 503:** the `ARC_DOCS` binding is missing — the
  `cloudflare-r2` component has not applied in that environment, or the
  brokered `CLOUDFLARE_R2_TOKEN` is missing. Re-run the R2 component's apply.
- **A complete request shows no clock:** the upload that completed it failed
  after its document insert. The next upload, or the clock's nightly pass
  (AD3), starts it; nothing else is needed.
- **The homeowner lost their link:** it cannot be recovered (only its hash is
  stored). The board can see the request in the console and contact them.
