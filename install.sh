#!/usr/bin/env bash
#
# Install the test-account plugin (and the browser pieces it needs) into one DSH
# profile.
#
#   ./install.sh              # installs into the "test-account" profile
#   ./install.sh web          # installs into the existing "web" profile
#   DSH_VERSION=0.1.7-alpha.1 ./install.sh ta
#
# The profile is initialized from the shipped "web" template when it does not
# exist yet, so installing into a brand-new profile name is safe.

set -euo pipefail

PROFILE="${1:-test-account}"
DSH_VERSION="${DSH_VERSION:-0.1.7-alpha.1}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# `dsh` is not necessarily on PATH when DSH itself is run through npx.
if [[ -n "${DSH_BIN:-}" ]]; then
  read -r -a DSH <<<"$DSH_BIN"
else
  DSH=(npx -y "@deepseek-ai/dsh@${DSH_VERSION}")
fi

echo "==> building workspace packages"
(cd "$ROOT" && pnpm install && pnpm run build)

echo "==> initializing profile '${PROFILE}' from the web template (no-op if it exists)"
"${DSH[@]}" --profile "$PROFILE" --from-default-profile web --dump-config >/dev/null

echo "==> installing plugins into profile '${PROFILE}'"
"${DSH[@]}" plugin --profile "$PROFILE" add \
  "$ROOT/packages/test-account" \
  "$ROOT/packages/browser-use-playwright-mcp-storage" \
  "@deepseek-ai/dsh-browser-use@${DSH_VERSION}" \
  "@deepseek-ai/dsh-experimental-browser-use-runtime@${DSH_VERSION}"

cat <<EOF

test-account installed into profile: ${PROFILE}

Start it with:

  npx -y @deepseek-ai/dsh@${DSH_VERSION} --profile ${PROFILE} web --port 3081

Then open a Session, expand the right Sidebar and pick 「测试账号」 from the
header shortcut or the Sidebar guide. The first save needs a browser that is
already logged in, so leave the Playwright provider visible
(cordis.patch.yml ships headless: false).
EOF
