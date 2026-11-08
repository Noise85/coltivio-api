-- Setup script for test database (runs on supabase/postgres image before migrations)

-- Create app roles for RLS-aware connections (APP_DATABASE_URL)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app') THEN
    CREATE ROLE app WITH LOGIN PASSWORD 'postgres';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'rls_client') THEN
    CREATE ROLE rls_client WITH LOGIN PASSWORD 'rls' NOINHERIT;
  END IF;
END $$;

-- Grant authenticated role so these can SET ROLE authenticated
GRANT authenticated TO app;
GRANT authenticated TO rls_client;
GRANT anon TO rls_client;

-- Grant schema access to authenticated role
GRANT USAGE ON SCHEMA public TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;

-- Ensure search_path includes extensions (for PostGIS, pg_trgm)
ALTER ROLE app SET search_path TO public, extensions;
ALTER ROLE rls_client SET search_path TO "$user", public, extensions;
ALTER ROLE authenticated SET search_path TO public, extensions;

-- Enable PostGIS and pg_trgm, then set search_path so geometry type is visible
CREATE EXTENSION IF NOT EXISTS postgis SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
SET search_path TO public, extensions;

-- Create federal_farm_plots table (normally populated by ogr2ogr, but migrations reference it)
CREATE TABLE IF NOT EXISTS public.federal_farm_plots (
  id integer PRIMARY KEY,
  farm_id text NOT NULL,
  local_id text,
  usage integer NOT NULL,
  size integer NOT NULL,
  cut_date date,
  canton text NOT NULL,
  geometry geometry(MultiPolygon,4326) NOT NULL
);
CREATE INDEX IF NOT EXISTS "federal_farm_plots_geometries_idx" ON federal_farm_plots USING gist (geometry);

-- App-specific function: farm_id() reads from pg session setting
CREATE OR REPLACE FUNCTION public.farm_id() RETURNS uuid AS $$
  SELECT NULLIF(current_setting('request.farm_id', true), '')::uuid;
$$ LANGUAGE sql STABLE SET search_path = '';

-- Trigger: auto-create profile row when GoTrue inserts into auth.users
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name)
  VALUES (NEW.id, NEW.email, NEW.raw_user_meta_data->>'full_name');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Keeps profiles in sync with auth.users. Supabase changes the address only once the new one is confirmed,
-- so it stays verified; clearing verification_handled_at lets the API finish the change.
CREATE OR REPLACE FUNCTION public.update_profile()
RETURNS trigger
SET search_path = ''
AS $$
BEGIN
  UPDATE public.profiles
  SET (email, full_name) = (NEW.email, NEW.raw_user_meta_data->>'full_name')
  WHERE id = NEW.id;

  IF NEW.email IS DISTINCT FROM OLD.email THEN
    UPDATE public.profiles
    SET email_verified = true, verification_handled_at = NULL
    WHERE id = NEW.id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Wire the trigger (function body resolves profiles at runtime, after migrations)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'on_auth_user_created'
  ) THEN
    CREATE TRIGGER on_auth_user_created
      AFTER INSERT ON auth.users
      FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'update_profile'
  ) THEN
    CREATE TRIGGER update_profile
      AFTER UPDATE ON auth.users
      FOR EACH ROW EXECUTE PROCEDURE public.update_profile();
  END IF;
END $$;
