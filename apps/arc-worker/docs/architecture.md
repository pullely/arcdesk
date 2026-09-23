# arc-worker — architecture

```
homeowner ──► api-edge ──(no actor; IP rate limit)──► arc-worker ──► D1 (arc_*)
committee ──► api-edge ──(resolveActor)────────────► arc-worker ──► membership-worker (context)
                                                                 ├─► policy-worker (authorize)
                                                                 ├─► R2 ARC_DOCS (plans)
                                                                 └─► notifications-worker (email)
```

- Reachable only over the `ARC_WORKER` service binding (`workers_dev: false`).
- Authenticated routes run membership authorization-context then policy
  authorize; a deny is `404`, never `403`.
- The public lane never sees actor headers. The homeowner's credential is a
  32-byte status token; only its SHA-256 is stored.
- Documents are read whole (≤ 20 MB), hashed, and put under
  `orgs/{org}/requests/{request}/{document}` — a key no second upload can reuse.
- D1 has no interactive transactions: the clock start is a single conditional
  statement, and audit appends are best-effort after the write they describe.
