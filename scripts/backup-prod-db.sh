#!/usr/bin/env bash
# Full pre-migration safety backup (schema + data) of a remote Postgres database.
#
# The connection string is entered interactively (hidden input) rather than read from .env,
# so a live prod connection string never has to sit uncommented in a file on disk.
set -euo pipefail

echo "This creates a full backup (schema + data) of a remote Postgres database via the Supabase CLI."
echo "Paste the DB connection string (input hidden), then press enter:"
read -rs DB_URL
echo

if [[ -z "$DB_URL" ]]; then
  echo "No connection string entered, aborting." >&2
  exit 1
fi

if [[ ! "$DB_URL" =~ ^postgres(ql)?:// ]]; then
  echo "That doesn't look like a postgres connection string (expected it to start with postgres:// or postgresql://), aborting." >&2
  exit 1
fi

OUT_DIR="backups"
mkdir -p "$OUT_DIR"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
SCHEMA_FILE="$OUT_DIR/prod_backup_${TIMESTAMP}_schema.sql"
DATA_FILE="$OUT_DIR/prod_backup_${TIMESTAMP}_data.sql"

echo "Dumping schema to $SCHEMA_FILE ..."
npx supabase db dump --db-url "$DB_URL" -f "$SCHEMA_FILE"

# federal_farm_plots is a large, static, non-user reference dataset (national parcel registry) —
# excluded here too, same as the routine `db:backup` script, since it isn't at risk from this
# migration and just adds size/time.
echo "Dumping data to $DATA_FILE ..."
npx supabase db dump --db-url "$DB_URL" --data-only --exclude=public.federal_farm_plots -f "$DATA_FILE"

echo
echo "Done."
echo "  Schema: $SCHEMA_FILE"
echo "  Data:   $DATA_FILE"
echo
echo "To restore (only if something goes wrong — this is destructive):"
echo "  psql \"<connection string>\" -f $SCHEMA_FILE"
echo "  psql \"<connection string>\" -f $DATA_FILE"
