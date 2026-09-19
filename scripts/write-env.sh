#!/bin/sh
# Cloudflare Pages build step: writes env-staging.js.
#   Preview builds: set STAGING_SUPABASE_URL and STAGING_SUPABASE_ANON_KEY in Cloudflare → Settings →
#   Variables (Preview environment only). staging.sh up keeps them current.
#   Production builds: leave both unset, so env-staging.js stays empty.
set -eu
OUT="env-staging.js"
URL="${STAGING_SUPABASE_URL:-}"
KEY="${STAGING_SUPABASE_ANON_KEY:-}"

if [ -z "$URL" ] && [ -z "$KEY" ]; then
  echo "/* No staging settings in this build. */" > "$OUT"
  echo "write-env: no staging settings (production build)"
  exit 0
fi

# Staging settings on the production branch mean they were added to Cloudflare's Production
# environment by mistake. Stop the build rather than ship them (env.js would ignore them anyway).
if [ "${CF_PAGES_BRANCH:-}" = "main" ]; then
  echo "write-env: staging settings found in a production (main) build; remove them from Cloudflare's Production variables" >&2
  exit 1
fi

# Refuse anything that isn't a plain Supabase address + key, and never production's.
case "$URL" in
  https://*.supabase.co) ;;
  *) echo "write-env: STAGING_SUPABASE_URL is not a Supabase address" >&2; exit 1 ;;
esac
case "$URL" in *dxttnbtfhpanyiyduevn*) echo "write-env: STAGING_SUPABASE_URL points at production" >&2; exit 1 ;; esac
case "$KEY" in *[!A-Za-z0-9._-]*|"") echo "write-env: STAGING_SUPABASE_ANON_KEY looks malformed" >&2; exit 1 ;; esac

printf 'window.BH_STAGING = { supabaseUrl: "%s", supabaseAnonKey: "%s" };\n' "$URL" "$KEY" > "$OUT"
echo "write-env: preview build uses staging at $URL"
