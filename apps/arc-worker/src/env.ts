export interface Env {
  PLATFORM_DB?: D1Database;
  /** Private R2 bucket holding every uploaded plan and, from AD2, every decision letter. */
  ARC_DOCS?: R2Bucket;
  MEMBERSHIP_WORKER?: Fetcher;
  POLICY_WORKER?: Fetcher;
  NOTIFICATIONS_WORKER?: Fetcher;
  ENVIRONMENT: string;
}
