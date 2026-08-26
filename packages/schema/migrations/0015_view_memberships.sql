CREATE TABLE "view_memberships" (
	"view_id" text NOT NULL,
	"user_id" text NOT NULL,
	"task_ids" jsonb NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "view_memberships_view_id_user_id_pk" PRIMARY KEY("view_id","user_id")
);
