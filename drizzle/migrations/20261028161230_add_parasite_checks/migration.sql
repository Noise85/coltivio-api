CREATE TYPE "parasite_check_method" AS ENUM('famacha', 'fecal_egg_count');--> statement-breakpoint
CREATE TYPE "parasite_result_grade" AS ENUM('negative', 'low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "parasite_type" AS ENUM('strongyles', 'haemonchus', 'nematodirus', 'trichuris', 'capillaria', 'strongyloides', 'moniezia', 'coccidia', 'liver_fluke', 'small_liver_fluke', 'lungworm', 'other');--> statement-breakpoint
ALTER TYPE "task_link_type" ADD VALUE 'parasite_check';--> statement-breakpoint
CREATE TABLE "parasite_check_animals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"farm_id" uuid NOT NULL,
	"check_id" uuid NOT NULL,
	"animal_id" uuid NOT NULL,
	"famacha_score" integer,
	CONSTRAINT "parasite_check_animals_unique" UNIQUE("check_id","animal_id"),
	CONSTRAINT "parasite_check_animals_famacha_score_range" CHECK ("famacha_score" between 1 and 5)
);
--> statement-breakpoint
ALTER TABLE "parasite_check_animals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "parasite_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"farm_id" uuid NOT NULL,
	"date" date NOT NULL,
	"name" text,
	"method" "parasite_check_method" NOT NULL,
	"lab_name" text,
	"notes" text,
	"previous_check_id" uuid,
	"treatment_id" uuid,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "parasite_checks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "parasite_fec_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"farm_id" uuid NOT NULL,
	"sample_id" uuid NOT NULL,
	"parasite_type" "parasite_type" NOT NULL,
	"count_per_gram" real,
	"grade" "parasite_result_grade",
	CONSTRAINT "parasite_fec_results_unique" UNIQUE("sample_id","parasite_type"),
	CONSTRAINT "parasite_fec_results_count_non_negative" CHECK ("count_per_gram" >= 0),
	CONSTRAINT "parasite_fec_results_count_or_grade" CHECK (num_nonnulls("count_per_gram", "grade") = 1)
);
--> statement-breakpoint
ALTER TABLE "parasite_fec_results" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "parasite_fec_sample_animals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"farm_id" uuid NOT NULL,
	"sample_id" uuid NOT NULL,
	"animal_id" uuid NOT NULL,
	CONSTRAINT "parasite_fec_sample_animals_unique" UNIQUE("sample_id","animal_id")
);
--> statement-breakpoint
ALTER TABLE "parasite_fec_sample_animals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "parasite_fec_samples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"farm_id" uuid NOT NULL,
	"check_id" uuid NOT NULL,
	"label" text
);
--> statement-breakpoint
ALTER TABLE "parasite_fec_samples" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "parasite_check_animals_animal_id_idx" ON "parasite_check_animals" ("animal_id");--> statement-breakpoint
CREATE INDEX "parasite_checks_date_idx" ON "parasite_checks" ("date");--> statement-breakpoint
CREATE INDEX "parasite_fec_sample_animals_animal_id_idx" ON "parasite_fec_sample_animals" ("animal_id");--> statement-breakpoint
CREATE INDEX "parasite_fec_samples_check_id_idx" ON "parasite_fec_samples" ("check_id");--> statement-breakpoint
ALTER TABLE "parasite_check_animals" ADD CONSTRAINT "parasite_check_animals_farm_id_farms_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "parasite_check_animals" ADD CONSTRAINT "parasite_check_animals_check_id_parasite_checks_id_fkey" FOREIGN KEY ("check_id") REFERENCES "parasite_checks"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "parasite_check_animals" ADD CONSTRAINT "parasite_check_animals_animal_id_animals_id_fkey" FOREIGN KEY ("animal_id") REFERENCES "animals"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "parasite_checks" ADD CONSTRAINT "parasite_checks_farm_id_farms_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "parasite_checks" ADD CONSTRAINT "parasite_checks_treatment_id_treatments_id_fkey" FOREIGN KEY ("treatment_id") REFERENCES "treatments"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "parasite_checks" ADD CONSTRAINT "parasite_checks_created_by_profiles_id_fkey" FOREIGN KEY ("created_by") REFERENCES "profiles"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "parasite_checks" ADD CONSTRAINT "parasite_checks_previous_check_id_parasite_checks_id_fkey" FOREIGN KEY ("previous_check_id") REFERENCES "parasite_checks"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "parasite_fec_results" ADD CONSTRAINT "parasite_fec_results_farm_id_farms_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "parasite_fec_results" ADD CONSTRAINT "parasite_fec_results_sample_id_parasite_fec_samples_id_fkey" FOREIGN KEY ("sample_id") REFERENCES "parasite_fec_samples"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "parasite_fec_sample_animals" ADD CONSTRAINT "parasite_fec_sample_animals_farm_id_farms_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "parasite_fec_sample_animals" ADD CONSTRAINT "parasite_fec_sample_animals_CPWtsMxJK0b1_fkey" FOREIGN KEY ("sample_id") REFERENCES "parasite_fec_samples"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "parasite_fec_sample_animals" ADD CONSTRAINT "parasite_fec_sample_animals_animal_id_animals_id_fkey" FOREIGN KEY ("animal_id") REFERENCES "animals"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "parasite_fec_samples" ADD CONSTRAINT "parasite_fec_samples_farm_id_farms_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "parasite_fec_samples" ADD CONSTRAINT "parasite_fec_samples_check_id_parasite_checks_id_fkey" FOREIGN KEY ("check_id") REFERENCES "parasite_checks"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "only farm members" ON "parasite_check_animals" AS PERMISSIVE FOR ALL TO "authenticated" USING ("parasite_check_animals"."farm_id" = (select farm_id())) WITH CHECK ("parasite_check_animals"."farm_id" = (select farm_id()));--> statement-breakpoint
CREATE POLICY "only farm members" ON "parasite_checks" AS PERMISSIVE FOR ALL TO "authenticated" USING ("parasite_checks"."farm_id" = (select farm_id())) WITH CHECK ("parasite_checks"."farm_id" = (select farm_id()));--> statement-breakpoint
CREATE POLICY "only farm members" ON "parasite_fec_results" AS PERMISSIVE FOR ALL TO "authenticated" USING ("parasite_fec_results"."farm_id" = (select farm_id())) WITH CHECK ("parasite_fec_results"."farm_id" = (select farm_id()));--> statement-breakpoint
CREATE POLICY "only farm members" ON "parasite_fec_sample_animals" AS PERMISSIVE FOR ALL TO "authenticated" USING ("parasite_fec_sample_animals"."farm_id" = (select farm_id())) WITH CHECK ("parasite_fec_sample_animals"."farm_id" = (select farm_id()));--> statement-breakpoint
CREATE POLICY "only farm members" ON "parasite_fec_samples" AS PERMISSIVE FOR ALL TO "authenticated" USING ("parasite_fec_samples"."farm_id" = (select farm_id())) WITH CHECK ("parasite_fec_samples"."farm_id" = (select farm_id()));