#!/usr/bin/env bash
# Recreate a throwaway database with the Supabase shim and all migrations.
# Usage: TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/grocery_voice_test scripts/prepare-test-db.sh
set -euo pipefail

url="${TEST_DATABASE_URL:-postgres://postgres:postgres@localhost:5432/grocery_voice_test}"
db="${url##*/}"
admin_url="${url%/*}/postgres"
root="$(cd "$(dirname "$0")/.." && pwd)"

psql "$admin_url" -v ON_ERROR_STOP=1 -q -c "drop database if exists \"$db\" with (force);" -c "create database \"$db\";"
psql "$url" -v ON_ERROR_STOP=1 -q -f "$root/tests/integration/supabase-shim.sql"
for f in "$root"/supabase/migrations/*.sql; do
  psql "$url" -v ON_ERROR_STOP=1 -q -f "$f"
done
echo "Prepared $url"
