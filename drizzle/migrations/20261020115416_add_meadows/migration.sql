CREATE TABLE "meadows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"farm_id" uuid NOT NULL,
	"name" text NOT NULL,
	"geometry" geometry(MultiPolygon,4326) NOT NULL,
	"size" integer NOT NULL,
	"additional_notes" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meadows_id_farm_id_unique" UNIQUE("id","farm_id")
);
--> statement-breakpoint
ALTER TABLE "meadows" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "outdoor_shedules" ADD COLUMN "meadow_id" uuid;--> statement-breakpoint
CREATE INDEX "meadow_geometries_idx" ON "meadows" USING gist ("geometry");--> statement-breakpoint
CREATE INDEX "outdoor_schedules_meadow_id_idx" ON "outdoor_shedules" ("meadow_id");--> statement-breakpoint
ALTER TABLE "meadows" ADD CONSTRAINT "meadows_farm_id_farms_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "outdoor_shedules" ADD CONSTRAINT "outdoor_schedules_meadow_farm_fk" FOREIGN KEY ("meadow_id","farm_id") REFERENCES "meadows"("id","farm_id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "only farm members" ON "meadows" AS PERMISSIVE FOR ALL TO "authenticated" USING ("meadows"."farm_id" = (select farm_id())) WITH CHECK ("meadows"."farm_id" = (select farm_id()));