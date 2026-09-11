-- Session 09 — storage hygiene.
--
-- The daily cleanup sweep (POST /api/admin/storage/cleanup/run) deletes the
-- object behind a soft-deleted Content row and then nulls its storageKey, so a
-- re-run is a fast no-op and the key genuinely no longer exists at rest —
-- "storageKey is never exposed" becomes true of the database, not only of the
-- API. GenerationJob.storageKey was already nullable (Session 08).
ALTER TABLE "Content" ALTER COLUMN "storageKey" DROP NOT NULL;
