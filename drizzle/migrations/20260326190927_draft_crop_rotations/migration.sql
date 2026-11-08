CREATE TABLE "crop_rotation_draft_plan_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"farm_id" uuid NOT NULL,
	"draft_plan_plot_id" uuid NOT NULL,
	"crop_id" uuid NOT NULL,
	"sowing_date" date,
	"from_date" date NOT NULL,
	"to_date" date NOT NULL,
	"recurrence_interval" integer,
	"recurrence_until" date
);
--> statement-breakpoint
ALTER TABLE "crop_rotation_draft_plan_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "crop_rotation_draft_plan_plots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"farm_id" uuid NOT NULL,
	"draft_plan_id" uuid NOT NULL,
	"plot_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crop_rotation_draft_plan_plots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "crop_rotation_draft_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"farm_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crop_rotation_draft_plans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "crop_rotation_draft_plan_entries" ADD CONSTRAINT "crop_rotation_draft_plan_entries_farm_id_farms_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "crop_rotation_draft_plan_entries" ADD CONSTRAINT "crop_rotation_draft_plan_entries_Jso08sQAwgs9_fkey" FOREIGN KEY ("draft_plan_plot_id") REFERENCES "crop_rotation_draft_plan_plots"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "crop_rotation_draft_plan_entries" ADD CONSTRAINT "crop_rotation_draft_plan_entries_crop_id_crops_id_fkey" FOREIGN KEY ("crop_id") REFERENCES "crops"("id");--> statement-breakpoint
ALTER TABLE "crop_rotation_draft_plan_plots" ADD CONSTRAINT "crop_rotation_draft_plan_plots_farm_id_farms_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "crop_rotation_draft_plan_plots" ADD CONSTRAINT "crop_rotation_draft_plan_plots_NNE7OVNGOmQp_fkey" FOREIGN KEY ("draft_plan_id") REFERENCES "crop_rotation_draft_plans"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "crop_rotation_draft_plan_plots" ADD CONSTRAINT "crop_rotation_draft_plan_plots_plot_id_plots_id_fkey" FOREIGN KEY ("plot_id") REFERENCES "plots"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "crop_rotation_draft_plans" ADD CONSTRAINT "crop_rotation_draft_plans_farm_id_farms_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "only farm members" ON "crop_rotation_draft_plan_entries" AS PERMISSIVE FOR ALL TO "authenticated" USING ("crop_rotation_draft_plan_entries"."farm_id" = (select farm_id())) WITH CHECK ("crop_rotation_draft_plan_entries"."farm_id" = (select farm_id()));--> statement-breakpoint
CREATE POLICY "only farm members" ON "crop_rotation_draft_plan_plots" AS PERMISSIVE FOR ALL TO "authenticated" USING ("crop_rotation_draft_plan_plots"."farm_id" = (select farm_id())) WITH CHECK ("crop_rotation_draft_plan_plots"."farm_id" = (select farm_id()));--> statement-breakpoint
CREATE POLICY "only farm members" ON "crop_rotation_draft_plans" AS PERMISSIVE FOR ALL TO "authenticated" USING ("crop_rotation_draft_plans"."farm_id" = (select farm_id())) WITH CHECK ("crop_rotation_draft_plans"."farm_id" = (select farm_id()));