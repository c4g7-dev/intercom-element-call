#!/usr/bin/env bash
# Builds the embedded package (@element-hq/element-call-embedded) that Element
# Web consumes, into embedded/web (package.json + dist), and prints its path.
# Nothing is published.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="$(node -p "require('./embedded/web/package.json').version")"
export VITE_APP_VERSION="${VITE_APP_VERSION:-embedded-v${VERSION}}"
# The stock script asks for a 16 GB heap; 4 GB is plenty for this build
node --max-old-space-size=4096 node_modules/vite/bin/vite.js build \
  --config vite-embedded.config.js "$@"

rm -rf embedded/web/dist
cp -r dist embedded/web/dist
echo "$(pwd)/embedded/web"
