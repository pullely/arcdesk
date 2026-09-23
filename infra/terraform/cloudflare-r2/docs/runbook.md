# cloudflare-r2 — runbook

- **Plan fails with 401/403 from the R2 API:** the brokered `CLOUDFLARE_R2_TOKEN`
  is missing in that environment, or the parent Cloudflare connection lacks
  "Workers R2 Storage Write". Mint it:
  `orun integrations cloudflare secret create CLOUDFLARE_R2_TOKEN --connection <int_…> --template r2-data --env <env>`.
- **Apply fails with "bucket already exists":** state lost track of it; the
  adoption block imports it on the next plan. Re-run the apply.
- **Never delete the bucket:** it is the record of every submitted plan and
  decision letter.
