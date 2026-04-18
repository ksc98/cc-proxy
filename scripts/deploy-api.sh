#!/usr/bin/env bash
# Deploy the API worker with routes supplied at the CLI from $DOMAINS
# (space-separated list, first = primary). Routes live outside wrangler.toml
# so the committed config is valid TOML everywhere — including CF Workers
# Builds' preview-version uploads on feature branches.
#
# Callers:
#   - `just deploy-api` (local dev)
#   - Cloudflare Workers Builds (CI). Dashboard Deploy command:
#       . "$HOME/.cargo/env" && ./scripts/deploy-api.sh
#     with DOMAINS set as a plain-text variable on the Worker.

set -euo pipefail

cd "$(dirname "$0")/.."

: "${DOMAINS:?set DOMAINS (space-separated list, first = primary)}"

route_args=()
for d in $DOMAINS; do
    route_args+=(--route "$d/v1/*" --route "$d/_cm/*")
done

npx --yes wrangler@latest deploy "${route_args[@]}"
