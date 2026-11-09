#!/bin/sh
# Cloudflare Pages build: copies ONLY the public website into dist/ (Cloudflare's output folder).
# The repo also holds edge functions, migrations, admin source and agent notes; none of that is
# published. A file missing from this list shows up as a broken link, never as a leak.
#   Cloudflare settings: build command `sh scripts/build-site.sh`, output directory `dist`.
set -eu
cd "$(dirname "$0")/.."

sh scripts/write-env.sh          # writes env-staging.js (empty on production builds)

rm -rf dist && mkdir dist

# Top-level pages, scripts and site files.
cp ./*.html ./*.js ./*.css favicon.ico robots.txt sitemap.xml _headers _redirects dist/

# Public folders.
for dir in images blog account admin; do
  cp -R "$dir" dist/
done

# docs/ is public on barkhaus.ph today (staff guides). Open question in the hosting decision record:
# remove this line to stop publishing it.
cp -R docs dist/

# Pages meant for Google must never carry a noindex tag. The 27 Oct 2026 release copied the
# staging pages (noindex) over the landing and booking pages and dropped them from search.
for page in dist/index.html dist/booking.html dist/faq.html dist/blog/*.html; do
  if grep -qi '<meta name="robots"[^>]*noindex' "$page"; then
    echo "build-site: $page has a noindex tag but must stay in Google. Remove it." >&2
    exit 1
  fi
done

echo "build-site: published $(find dist -type f | wc -l | tr -d ' ') files to dist/"
