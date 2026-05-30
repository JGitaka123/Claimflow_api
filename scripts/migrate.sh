#!/usr/bin/env bash
set -euo pipefail

# ClaimFlow Database Migration Runner
# Usage: DATABASE_URL="postgres://..." bash scripts/migrate.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATIONS_DIR="${SCRIPT_DIR}/../migrations"

# Load .env if present
if [ -f "${SCRIPT_DIR}/../.env" ]; then
  export $(grep -v '^#' "${SCRIPT_DIR}/../.env" | xargs)
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL is not set"
  echo "Usage: DATABASE_URL=\"postgres://user:pass@host:5432/db\" bash scripts/migrate.sh"
  exit 1
fi

echo "=== ClaimFlow Database Migration ==="
echo "Target: ${DATABASE_URL%%@*}@***"
echo ""

# Create schema_migrations tracking table
psql "${DATABASE_URL}" -c "
CREATE TABLE IF NOT EXISTS schema_migrations (
    filename    TEXT PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
" 2>/dev/null

# Apply each migration in order
for migration_file in $(ls "${MIGRATIONS_DIR}"/*.sql | sort); do
  filename=$(basename "${migration_file}")

  # Check if already applied
  already_applied=$(psql "${DATABASE_URL}" -tAc "SELECT COUNT(*) FROM schema_migrations WHERE filename = '${filename}';")

  if [ "${already_applied}" -eq "0" ]; then
    echo "Applying: ${filename}..."
    psql "${DATABASE_URL}" -f "${migration_file}"
    psql "${DATABASE_URL}" -c "INSERT INTO schema_migrations (filename) VALUES ('${filename}');"
    echo "  ✓ Applied"
  else
    echo "Skipping: ${filename} (already applied)"
  fi
done

echo ""
echo "=== Migration complete ==="
total=$(psql "${DATABASE_URL}" -tAc "SELECT COUNT(*) FROM schema_migrations;")
echo "Total migrations applied: ${total}"
