# cloudflare-r2

Provisions one private Cloudflare R2 bucket per environment,
`arcdesk-arc-docs-stage` and `arcdesk-arc-docs-prod`, holding every plan a
homeowner uploads with an architectural request and (from AD2) every decision
letter.

- **Consumed by:** `apps/arc-worker`, bound as `ARC_DOCS` by bucket name.
- **Credential:** a brokered `CLOUDFLARE_R2_TOKEN` (scope template `r2-data`),
  not the deploy token.
- **Adoption:** `terraform/adopt.tf` imports a bucket Cloudflare already has but
  state does not track, so a lost state write cannot wedge the apply.
- `dev` is verify-only and provisions nothing.
