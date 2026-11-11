
ALTER TABLE "federal_farm_plots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "federal_farm_plots_geometries_idx" ON "federal_farm_plots" USING gist ("geometry");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "federal_farm_id_idx" ON "federal_farm_plots" USING gin ("farm_id" gin_trgm_ops);--> statement-breakpoint
CREATE POLICY "authenticated users can read" ON "federal_farm_plots" AS PERMISSIVE FOR SELECT TO "authenticated" USING (true);