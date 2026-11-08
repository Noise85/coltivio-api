CREATE TYPE "task_link_type" AS ENUM('animal', 'plot', 'contact', 'order', 'wiki_entry', 'treatment', 'herd');--> statement-breakpoint
CREATE TYPE "task_status" AS ENUM('todo', 'done');--> statement-breakpoint
CREATE TABLE "task_checklist_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"farm_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"name" text NOT NULL,
	"due_date" date,
	"done" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_checklist_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "task_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"farm_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"link_type" "task_link_type" NOT NULL,
	"linked_id" uuid NOT NULL,
	CONSTRAINT "task_links_unique" UNIQUE("task_id","link_type","linked_id")
);
--> statement-breakpoint
ALTER TABLE "task_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "task_recurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"farm_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"frequency" "frequency" NOT NULL,
	"interval" integer DEFAULT 1 NOT NULL,
	"by_weekday" "weekday"[],
	"by_month_day" integer,
	"until" date,
	"count" integer
);
--> statement-breakpoint
ALTER TABLE "task_recurrences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"farm_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"labels" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" "task_status" DEFAULT 'todo'::"task_status" NOT NULL,
	"assignee_id" uuid,
	"due_date" date,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
ALTER TABLE "tasks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "task_checklist_items_task_id_idx" ON "task_checklist_items" ("task_id");--> statement-breakpoint
CREATE INDEX "task_links_task_id_idx" ON "task_links" ("task_id");--> statement-breakpoint
ALTER TABLE "task_checklist_items" ADD CONSTRAINT "task_checklist_items_farm_id_farms_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "task_checklist_items" ADD CONSTRAINT "task_checklist_items_task_id_tasks_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "task_links" ADD CONSTRAINT "task_links_farm_id_farms_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "task_links" ADD CONSTRAINT "task_links_task_id_tasks_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "task_recurrences" ADD CONSTRAINT "task_recurrences_farm_id_farms_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "task_recurrences" ADD CONSTRAINT "task_recurrences_task_id_tasks_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_farm_id_farms_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_id_profiles_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "profiles"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_profiles_id_fkey" FOREIGN KEY ("created_by") REFERENCES "profiles"("id") ON DELETE SET NULL;--> statement-breakpoint
CREATE POLICY "only farm members" ON "task_checklist_items" AS PERMISSIVE FOR ALL TO "authenticated" USING ("task_checklist_items"."farm_id" = farm_id()) WITH CHECK ("task_checklist_items"."farm_id" = farm_id());--> statement-breakpoint
CREATE POLICY "only farm members" ON "task_links" AS PERMISSIVE FOR ALL TO "authenticated" USING ("task_links"."farm_id" = farm_id()) WITH CHECK ("task_links"."farm_id" = farm_id());--> statement-breakpoint
CREATE POLICY "only farm members" ON "task_recurrences" AS PERMISSIVE FOR ALL TO "authenticated" USING ("task_recurrences"."farm_id" = farm_id()) WITH CHECK ("task_recurrences"."farm_id" = farm_id());--> statement-breakpoint
CREATE POLICY "only farm members" ON "tasks" AS PERMISSIVE FOR ALL TO "authenticated" USING ("tasks"."farm_id" = farm_id()) WITH CHECK ("tasks"."farm_id" = farm_id());