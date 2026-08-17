-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally; live operators create this index concurrently before applying the idempotent migration.
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_ctx_paperclip_issue_idx" ON "heartbeat_runs" USING btree ("company_id",("context_snapshot" -> 'paperclipIssue' ->> 'id'));
