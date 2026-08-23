CREATE TABLE "webhook_events" (
	"task_id" text PRIMARY KEY NOT NULL,
	"event" text NOT NULL,
	"webhook_id" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "webhooks" ADD COLUMN "user_id" text;--> statement-breakpoint
CREATE INDEX "webhook_events_claim_idx" ON "webhook_events" USING btree ("next_attempt_at","received_at");