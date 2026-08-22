CREATE TABLE "checklist_items" (
	"id" text PRIMARY KEY NOT NULL,
	"checklist_id" text NOT NULL,
	"name" text NOT NULL,
	"orderindex" integer,
	"assignee_id" text,
	"resolved" boolean DEFAULT false NOT NULL,
	"parent_item_id" text,
	"date_created" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_checklists" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"name" text NOT NULL,
	"orderindex" integer,
	"creator_id" text,
	"date_created" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "checklist_items" ADD CONSTRAINT "checklist_items_checklist_id_task_checklists_id_fk" FOREIGN KEY ("checklist_id") REFERENCES "public"."task_checklists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_checklists" ADD CONSTRAINT "task_checklists_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "checklist_items_checklist_idx" ON "checklist_items" USING btree ("checklist_id","orderindex");--> statement-breakpoint
CREATE INDEX "task_checklists_task_idx" ON "task_checklists" USING btree ("task_id","orderindex");