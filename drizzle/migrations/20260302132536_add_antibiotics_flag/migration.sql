ALTER TABLE "drugs" ADD COLUMN "is_antibiotic" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "treatments" ADD COLUMN "is_antibiotic" boolean DEFAULT false NOT NULL;