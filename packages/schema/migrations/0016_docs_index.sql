CREATE TABLE "docs" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"name" text NOT NULL,
	"parent_id" text,
	"parent_type" integer,
	"date_updated" timestamp with time zone,
	"archived" boolean DEFAULT false NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "docs_parent_idx" ON "docs" USING btree ("parent_type","parent_id");