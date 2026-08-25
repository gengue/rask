CREATE TABLE "comment_mentions" (
	"comment_id" text NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "comment_mentions_comment_id_user_id_pk" PRIMARY KEY("comment_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "assignee_id" text;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "needs_comments" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "comment_mentions" ADD CONSTRAINT "comment_mentions_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comment_mentions_user_idx" ON "comment_mentions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "comments_assignee_idx" ON "comments" USING btree ("assignee_id","date");