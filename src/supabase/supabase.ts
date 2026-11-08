import { createClient } from "@supabase/supabase-js";

export const supabase = createClient(process.env.SUPABASE_API_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});

export const WIKI_IMAGES_BUCKET = "wiki-images";
export const wikiStorage = supabase.storage.from(WIKI_IMAGES_BUCKET);

export const ANIMAL_JOURNAL_IMAGES_BUCKET = "animal-journal-images";
export const animalJournalStorage = supabase.storage.from(ANIMAL_JOURNAL_IMAGES_BUCKET);

export const PLOT_JOURNAL_IMAGES_BUCKET = "plot-journal-images";
export const plotJournalStorage = supabase.storage.from(PLOT_JOURNAL_IMAGES_BUCKET);

export const FARM_JOURNAL_IMAGES_BUCKET = "farm-journal-images";
export const farmJournalStorage = supabase.storage.from(FARM_JOURNAL_IMAGES_BUCKET);

export type SupabaseToken = {
  iss?: string;
  sub?: string;
  aud?: string[] | string;
  exp?: number;
  nbf?: number;
  iat?: number;
  jti?: string;
  role?: string;
};
