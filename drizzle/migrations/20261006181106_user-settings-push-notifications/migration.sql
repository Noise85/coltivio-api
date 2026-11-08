CREATE TABLE "push_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"token" text NOT NULL UNIQUE,
	"platform" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_used_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "push_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "task_due_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"task_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"due_date" date NOT NULL,
	"sent_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "task_due_notifications_task_id_user_id_due_date_unique" UNIQUE("task_id","user_id","due_date")
);
--> statement-breakpoint
ALTER TABLE "task_due_notifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "user_settings" (
	"user_id" uuid PRIMARY KEY,
	"task_push_notifications" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "push_tokens" ADD CONSTRAINT "push_tokens_user_id_profiles_id_fkey" FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "task_due_notifications" ADD CONSTRAINT "task_due_notifications_task_id_tasks_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "task_due_notifications" ADD CONSTRAINT "task_due_notifications_user_id_profiles_id_fkey" FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_profiles_id_fkey" FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "user can manage own push tokens" ON "push_tokens" AS PERMISSIVE FOR ALL TO "authenticated" USING ("push_tokens"."user_id" = (select auth.uid())) WITH CHECK ("push_tokens"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "user can manage own settings" ON "user_settings" AS PERMISSIVE FOR ALL TO "authenticated" USING ("user_settings"."user_id" = (select auth.uid())) WITH CHECK ("user_settings"."user_id" = (select auth.uid()));