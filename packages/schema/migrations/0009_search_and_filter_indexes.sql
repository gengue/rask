-- Trigram operator classes for the two index definitions below.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce(description, ''))) STORED;--> statement-breakpoint
-- These three were created by hand against the workspace mirror when they were
-- measured (see "feat(api): tag editing, and indexes that make the list query
-- cheap"), which is why they are IF NOT EXISTS: the database this runs against
-- may already have them, byte for byte, and re-creating them is not worth
-- failing a deploy over.
CREATE INDEX IF NOT EXISTS "tasks_open_by_list_v2_idx" ON "tasks" USING btree ("list_id","due_date","date_updated" DESC NULLS LAST) WHERE deleted_at is null and archived = false and (status_type is null or status_type <> all (array['closed', 'done']));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_name_trgm_idx" ON "tasks" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_custom_id_trgm_idx" ON "tasks" USING gin ("custom_id" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "tasks_search_idx" ON "tasks" USING gin ("search_vector");--> statement-breakpoint
-- Repairs tags written as a jsonb *string* by the code path that predates the
-- custom `jsonb` column type (see packages/schema/src/schema.ts). Reads
-- unwrapped them, so nothing looked wrong; `tags @> '[{"name":"..."}]'` matched
-- none of them, so the tag filter has been quietly blind to 71,498 of the
-- mirror's 147,242 tasks. Pushing that filter into SQL is what makes this
-- worth fixing now rather than leaving to the seatbelt in the column type.
--
-- Ingest cannot repair these on its own: the upsert skips rows whose
-- `date_updated` has not moved, so a resync leaves an untouched task exactly as
-- broken as it was.
UPDATE "tasks" SET "tags" = ("tags" #>> '{}')::jsonb WHERE jsonb_typeof("tags") = 'string';
