CREATE TYPE "seed_quantity_kind" AS ENUM('weight', 'count');--> statement-breakpoint
CREATE TYPE "sowing_unit" AS ENUM('kg_per_ha', 'g_per_m2', 'seeds_per_ha', 'seeds_per_m2', 'plants_per_ha', 'plants_per_m2', 'kg', 'g', 'seeds', 'plants');--> statement-breakpoint
CREATE TABLE "seeds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"farm_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"crop_id" uuid,
	"quantity_kind" "seed_quantity_kind" NOT NULL,
	"default_amount" real,
	"default_unit" "sowing_unit"
);
--> statement-breakpoint
ALTER TABLE "seeds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sowing_presets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"farm_id" uuid NOT NULL,
	"name" text NOT NULL,
	"crop_id" uuid NOT NULL,
	"seed_id" uuid,
	"unit" "sowing_unit" NOT NULL,
	"amount" real NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sowing_presets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sowings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"farm_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"created_by" uuid,
	"date" date NOT NULL,
	"plot_id" uuid NOT NULL,
	"crop_id" uuid NOT NULL,
	"seed_id" uuid,
	"unit" "sowing_unit" NOT NULL,
	"amount" real NOT NULL,
	"total_base_amount" real NOT NULL,
	"base_amount_per_hectare" real NOT NULL,
	"geometry" geometry(MultiPolygon,4326) NOT NULL,
	"size" integer NOT NULL,
	"additional_notes" text
);
--> statement-breakpoint
ALTER TABLE "sowings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "seeds" ADD CONSTRAINT "seeds_farm_id_farms_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "seeds" ADD CONSTRAINT "seeds_crop_id_crops_id_fkey" FOREIGN KEY ("crop_id") REFERENCES "crops"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "sowing_presets" ADD CONSTRAINT "sowing_presets_farm_id_farms_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sowing_presets" ADD CONSTRAINT "sowing_presets_crop_id_crops_id_fkey" FOREIGN KEY ("crop_id") REFERENCES "crops"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sowing_presets" ADD CONSTRAINT "sowing_presets_seed_id_seeds_id_fkey" FOREIGN KEY ("seed_id") REFERENCES "seeds"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sowings" ADD CONSTRAINT "sowings_farm_id_farms_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sowings" ADD CONSTRAINT "sowings_created_by_profiles_id_fkey" FOREIGN KEY ("created_by") REFERENCES "profiles"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "sowings" ADD CONSTRAINT "sowings_plot_id_plots_id_fkey" FOREIGN KEY ("plot_id") REFERENCES "plots"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sowings" ADD CONSTRAINT "sowings_crop_id_crops_id_fkey" FOREIGN KEY ("crop_id") REFERENCES "crops"("id");--> statement-breakpoint
ALTER TABLE "sowings" ADD CONSTRAINT "sowings_seed_id_seeds_id_fkey" FOREIGN KEY ("seed_id") REFERENCES "seeds"("id");--> statement-breakpoint
CREATE POLICY "only farm members" ON "seeds" AS PERMISSIVE FOR ALL TO "authenticated" USING ("seeds"."farm_id" = (select farm_id())) WITH CHECK ("seeds"."farm_id" = (select farm_id()));--> statement-breakpoint
CREATE POLICY "only farm members" ON "sowing_presets" AS PERMISSIVE FOR ALL TO "authenticated" USING ("sowing_presets"."farm_id" = (select farm_id())) WITH CHECK ("sowing_presets"."farm_id" = (select farm_id()));--> statement-breakpoint
CREATE POLICY "only farm members" ON "sowings" AS PERMISSIVE FOR ALL TO "authenticated" USING ("sowings"."farm_id" = (select farm_id())) WITH CHECK ("sowings"."farm_id" = (select farm_id()));