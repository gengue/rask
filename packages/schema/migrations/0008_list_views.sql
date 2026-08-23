CREATE TABLE "list_views" (
	"id" text PRIMARY KEY NOT NULL,
	"list_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"orderindex" integer,
	"is_default" boolean DEFAULT false NOT NULL,
	"group_field" text,
	"show_closed" boolean DEFAULT false NOT NULL,
	"public_url" text,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "list_views_list_idx" ON "list_views" USING btree ("list_id","orderindex");