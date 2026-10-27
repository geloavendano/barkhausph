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

echo "build-site: published $(find dist -type f | wc -l | tr -d ' ') files to dist/"
