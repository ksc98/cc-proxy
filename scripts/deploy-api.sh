#!/usr/bin/env bash
# Expand __PROXY_ROUTES__ in wrangler.toml into one `{pattern, zone_name}`
# pair per domain in $DOMAINS (space-separated; first = primary), then
# deploy the API worker from the generated file. The generated file is
# dropped on exit so the tree stays clean.
#
# Callers:
#   - `just deploy-api` (local dev)
#   - Cloudflare Workers Builds (CI). Dashboard build command should be:
#       . "$HOME/.cargo/env" && ./scripts/deploy-api.sh
#     with DOMAINS set as a plain-text variable on the Worker.

set -euo pipefail

cd "$(dirname "$0")/.."

: "${DOMAINS:?set DOMAINS (space-separated list, first = primary)}"

routes=""
for d in $DOMAINS; do
    routes+="  { pattern = \"${d}/v1/*\", zone_name = \"${d}\" },"$'\n'
    routes+="  { pattern = \"${d}/_cm/*\", zone_name = \"${d}\" },"$'\n'
done
routes="${routes%$'\n'}"

awk -v r="$routes" '$0 == "__PROXY_ROUTES__" { print r; next } { print }' \
    wrangler.toml > wrangler.deploy.toml
trap 'rm -f wrangler.deploy.toml' EXIT

npx --yes wrangler@latest deploy -c wrangler.deploy.toml
