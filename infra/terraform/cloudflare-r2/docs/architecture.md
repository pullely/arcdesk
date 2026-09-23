# cloudflare-r2 — architecture

`terraform apply` (on push to main, per environment) → `cloudflare_r2_bucket.arc_docs`
→ bucket `arcdesk-arc-docs-<env>` → bound by `arc-worker` as `ARC_DOCS`.
`arc-worker` declares `dependsOn: cloudflare-r2`, so a run that changes both
applies the bucket before it deploys the binding.
