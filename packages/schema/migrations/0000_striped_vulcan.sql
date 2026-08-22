CREATE TABLE "comments" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"user_id" text,
	"text" text,
	"resolved" boolean DEFAULT false NOT NULL,
	"reply_count" integer DEFAULT 0 NOT NULL,
	"date" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_field_defs" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"type_config" jsonb,
	"required" boolean DEFAULT false NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "folders" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"name" text NOT NULL,
	"orderindex" integer,
	"hidden" boolean DEFAULT false NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lists" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"folder_id" text,
	"name" text NOT NULL,
	"orderindex" integer,
	"content" text,
	"task_count" integer,
	"archived" boolean DEFAULT false NOT NULL,
	"statuses" jsonb,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_tokens" (
	"user_id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"nonce" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"op" text NOT NULL,
	"entity_id" text,
	"payload" jsonb NOT NULL,
	"client_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spaces" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"name" text NOT NULL,
	"private" boolean DEFAULT false NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"statuses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_cursors" (
	"scope" text NOT NULL,
	"scope_id" text NOT NULL,
	"last_updated_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_full_sync_at" timestamp with time zone,
	"failures" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	CONSTRAINT "sync_cursors_scope_scope_id_pk" PRIMARY KEY("scope","scope_id")
);
--> statement-breakpoint
CREATE TABLE "task_assignees" (
	"task_id" text NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "task_assignees_task_id_user_id_pk" PRIMARY KEY("task_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "task_custom_values" (
	"task_id" text NOT NULL,
	"field_id" text NOT NULL,
	"value" jsonb,
	CONSTRAINT "task_custom_values_task_id_field_id_pk" PRIMARY KEY("task_id","field_id")
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"custom_id" text,
	"list_id" text NOT NULL,
	"folder_id" text,
	"space_id" text,
	"team_id" text,
	"name" text NOT NULL,
	"description" text,
	"text_content" text,
	"status" text,
	"status_color" text,
	"status_type" text,
	"orderindex" text,
	"parent_id" text,
	"priority" smallint,
	"due_date" timestamp with time zone,
	"start_date" timestamp with time zone,
	"date_created" timestamp with time zone,
	"date_updated" timestamp with time zone,
	"date_closed" timestamp with time zone,
	"date_done" timestamp with time zone,
	"creator_id" text,
	"archived" boolean DEFAULT false NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"time_estimate" bigint,
	"points" real,
	"url" text,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text,
	"email" text,
	"color" text,
	"initials" text,
	"profile_picture" text,
	"is_rask_user" boolean DEFAULT false NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"nonce" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_assignees" ADD CONSTRAINT "task_assignees_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_custom_values" ADD CONSTRAINT "task_custom_values_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comments_task_idx" ON "comments" USING btree ("task_id","date");--> statement-breakpoint
CREATE INDEX "folders_space_idx" ON "folders" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "lists_space_idx" ON "lists" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "lists_folder_idx" ON "lists" USING btree ("folder_id");--> statement-breakpoint
CREATE INDEX "outbox_claim_idx" ON "outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "outbox_entity_idx" ON "outbox" USING btree ("entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_client_id_idx" ON "outbox" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "spaces_team_idx" ON "spaces" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "task_assignees_user_idx" ON "task_assignees" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "task_custom_values_field_idx" ON "task_custom_values" USING btree ("field_id");--> statement-breakpoint
CREATE INDEX "tasks_list_idx" ON "tasks" USING btree ("list_id");--> statement-breakpoint
CREATE INDEX "tasks_space_idx" ON "tasks" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "tasks_status_idx" ON "tasks" USING btree ("list_id","status");--> statement-breakpoint
CREATE INDEX "tasks_due_idx" ON "tasks" USING btree ("due_date");--> statement-breakpoint
CREATE INDEX "tasks_updated_idx" ON "tasks" USING btree ("date_updated");--> statement-breakpoint
CREATE INDEX "tasks_parent_idx" ON "tasks" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "tasks_tags_idx" ON "tasks" USING gin ("tags" jsonb_path_ops);