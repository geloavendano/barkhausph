#!/usr/bin/env bash
# Back up everything the release touches, BEFORE any production change. Read-only against production.
# Runbook: docs/decisions/2026-10-26-release-night-runbook.md
#
# Makes, in ~/Backups/barkhaus/<timestamp>-pre-release/ (outside the repo: it holds customer data):
#   repo.bundle            the whole git repo, every branch and tag (git clone repo.bundle to restore)
#   functions-list.txt     which version of each function is live
#   live-functions/        the edge functions AS DEPLOYED (catches dashboard edits that never reached git)
#   live-vs-git.txt        whether each deployed function matches the pre-orders tag
#   secrets.txt            function secret NAMES and digests (never values)
#   db-schema-public.sql   readable schema: tables, RLS policies, functions, triggers
#   db-public.dump         public schema + data (pg_restore format)
#   db-auth.dump           auth users (customer + admin sign-ins), data only
#   db-storage.dump        storage file records (metadata only; the files themselves are not touched tonight)
#   preflight.txt          output of scripts/preflight-production.sql
#   SHA256SUMS             checksums of all of the above
#
# Needs: `brew install libpq` (pg_dump/psql), `supabase login`, and the production database connection
# string (Supabase dashboard → Connect → Session pooler → URI, with the database password filled in).
# The script asks for it without echoing; it is never written to disk.
set -uo pipefail

PROJECT_REF="dxttnbtfhpanyiyduevn"   # production
REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$HOME/Backups/barkhaus/$(date +%Y%m%d-%H%M)-pre-release"
export PATH="/opt/homebrew/opt/libpq/bin:/usr/local/opt/libpq/bin:$PATH"

umask 077
mkdir -p "$OUT"
failures=""
step() { printf '\n── %s\n' "$1"; }
fail() { echo "  FAILED: $1"; failures="$failures [$1]"; }

for tool in git supabase pg_dump pg_restore psql shasum; do
  command -v "$tool" >/dev/null || { echo "Missing $tool. pg_dump/psql: brew install libpq"; exit 1; }
done

if [ -z "${BH_PROD_DB_URL:-}" ]; then
  printf 'Production database URI (Session pooler, password included; input hidden): '
  read -rs BH_PROD_DB_URL; echo
fi
case "$BH_PROD_DB_URL" in
  *"$PROJECT_REF"*) ;;
  *) echo "That URI does not mention the production project ($PROJECT_REF). Stopping."; exit 1 ;;
esac
export PGCONNECT_TIMEOUT=20

step "1. Git: full repo bundle"
git -C "$REPO" fetch -q origin --tags || fail "git fetch"
git -C "$REPO" bundle create "$OUT/repo.bundle" --all >/dev/null 2>&1 && git -C "$REPO" bundle verify "$OUT/repo.bundle" >/dev/null 2>&1 \
  && echo "  ok: repo.bundle (origin/main = $(git -C "$REPO" rev-parse --short origin/main), pre-orders = $(git -C "$REPO" rev-parse --short pre-orders))" \
  || fail "git bundle"

step "2. Edge functions as deployed"
mkdir -p "$OUT/live-functions"
supabase functions list --project-ref "$PROJECT_REF" > "$OUT/functions-list.txt" 2>&1 \
  && echo "  ok: functions-list.txt (deployed versions)" || fail "functions list"
: > "$OUT/live-vs-git.txt"
for fn in $(git -C "$REPO" ls-tree --name-only pre-orders supabase/functions/ | xargs -n1 basename | grep -v '^_'); do
  if supabase functions download "$fn" --project-ref "$PROJECT_REF" --use-api --workdir "$OUT/live-functions" >/dev/null 2>&1; then
    live="$OUT/live-functions/supabase/functions/$fn/index.ts"
    if [ -f "$live" ] && git -C "$REPO" show "pre-orders:supabase/functions/$fn/index.ts" 2>/dev/null | diff -q - "$live" >/dev/null; then
      echo "same as git      $fn" | tee -a "$OUT/live-vs-git.txt"
    else
      echo "DIFFERS FROM GIT $fn   ← review before deploying over it" | tee -a "$OUT/live-vs-git.txt"
    fi
  else
      echo "DOWNLOAD FAILED $fn   ← cannot verify deployed source" | tee -a "$OUT/live-vs-git.txt"
      fail "function download: $fn"
  fi
done

step "3. Function secret names"
supabase secrets list --project-ref "$PROJECT_REF" > "$OUT/secrets.txt" 2>&1 \
  && echo "  ok: $(grep -c '|' "$OUT/secrets.txt") lines (names + digests only)" || fail "secrets list"

step "4. Database"
pg_dump "$BH_PROD_DB_URL" --schema=public --schema-only --no-owner -f "$OUT/db-schema-public.sql" \
  && echo "  ok: db-schema-public.sql" || fail "schema dump"
pg_dump "$BH_PROD_DB_URL" --schema=public -Fc -f "$OUT/db-public.dump" \
  && pg_restore --list "$OUT/db-public.dump" >/dev/null && echo "  ok: db-public.dump (readable)" || fail "public dump"
pg_dump "$BH_PROD_DB_URL" --schema=auth --data-only -Fc -f "$OUT/db-auth.dump" \
  && pg_restore --list "$OUT/db-auth.dump" >/dev/null && echo "  ok: db-auth.dump (readable)" || fail "auth dump"
pg_dump "$BH_PROD_DB_URL" --schema=storage --data-only -Fc -f "$OUT/db-storage.dump" \
  && pg_restore --list "$OUT/db-storage.dump" >/dev/null && echo "  ok: db-storage.dump (readable)" || fail "storage dump"

step "5. Pre-flight checks"
psql "$BH_PROD_DB_URL" -X -v ON_ERROR_STOP=1 -f "$REPO/scripts/preflight-production.sql" > "$OUT/preflight.txt" 2>&1 \
  && cat "$OUT/preflight.txt" || { cat "$OUT/preflight.txt"; fail "preflight"; }

step "6. Checksums"
(cd "$OUT" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 shasum -a 256 > SHA256SUMS) \
  && echo "  ok" || fail "checksums"

printf '\nBackup folder: %s (%s)\n' "$OUT" "$(du -sh "$OUT" | cut -f1)"
if [ -n "$failures" ]; then
  printf 'NOT COMPLETE. Failed:%s\nDo not start the release until these succeed.\n' "$failures"
  exit 1
fi
grep -q "DIFFERS FROM GIT" "$OUT/live-vs-git.txt" \
  && echo "Backup complete, BUT some deployed functions differ from git. Review live-vs-git.txt before deploying." \
  || echo "Backup complete. Deployed functions match git."
