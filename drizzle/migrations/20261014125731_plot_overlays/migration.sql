CREATE TABLE "plot_overlays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"farm_id" uuid NOT NULL,
	"name" text NOT NULL,
	"local_id" text,
	"usage" integer NOT NULL,
	"usage_name" text,
	"size" integer NOT NULL,
	"geometry" geometry(MultiPolygon,4326) NOT NULL,
	"external_id" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plot_overlays_farm_external_id_unique" UNIQUE("farm_id","external_id")
);
--> statement-breakpoint
ALTER TABLE "plot_overlays" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "plot_overlays_geometries_idx" ON "plot_overlays" USING gist ("geometry");--> statement-breakpoint
ALTER TABLE "plot_overlays" ADD CONSTRAINT "plot_overlays_farm_id_farms_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "only farm members" ON "plot_overlays" AS PERMISSIVE FOR ALL TO "authenticated" USING ("plot_overlays"."farm_id" = (select farm_id())) WITH CHECK ("plot_overlays"."farm_id" = (select farm_id()));