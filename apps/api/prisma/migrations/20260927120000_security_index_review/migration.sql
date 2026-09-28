-- Session 12 (D7) — query-driven index review.
-- Every statement here is justified by a named row in
-- docs/performance/index-review.md. Generated offline with
-- `prisma migrate diff` (Prisma-expressible part) plus hand-written SQL for
-- the partial/expression indexes Prisma has no primitive for — the same
-- method as the Session 11 migration.

-- DropIndex
-- Pure duplicate: "ContentAccess_contentId_userId_key" is a btree on
-- ("contentId", "userId"), whose leading column already serves every
-- contentId-only lookup this single-column index could.
DROP INDEX "ContentAccess_contentId_idx";

-- CreateIndex
-- Reference images by profile: every POST /api/generations, GET
-- /api/onboarding/profile and the admin approval queue. Postgres does not
-- index foreign keys by itself.
CREATE INDEX "ReferenceImage_modelProfileId_idx" ON "ReferenceImage"("modelProfileId");

-- Forensic trace lookup (closes the Session 09 Open Item). Partial: only the
-- two serve actions carry a traceCode, so the one index AuditLog gains covers
-- exactly the rows an investigation can match. Query shape it serves:
--   SELECT * FROM "AuditLog"
--   WHERE "action" IN ('content.served', 'generation.image_served')
--     AND "metadata"->>'traceCode' = $1;
CREATE INDEX "AuditLog_traceCode_idx" ON "AuditLog" (("metadata"->>'traceCode'))
  WHERE "action" IN ('content.served', 'generation.image_served');

-- Storage-cleanup sweep, pass 2: COMPLETED images past expiresAt that still
-- hold an object. Rows leave the index as the sweep nulls their key.
CREATE INDEX "GenerationJob_cleanup_expiresAt_idx" ON "GenerationJob" ("expiresAt")
  WHERE "status" = 'COMPLETED' AND "storageKey" IS NOT NULL;

-- Storage-cleanup sweep, pass 1: soft-deleted Content still holding an object,
-- walked by id (keyset). Normally empty or near-empty.
CREATE INDEX "Content_cleanup_pending_idx" ON "Content" ("id")
  WHERE "deletedAt" IS NOT NULL AND "storageKey" IS NOT NULL;
