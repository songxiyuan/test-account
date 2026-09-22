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
echo "    (the 'declares no dsh.bundle' warnings are expected for the three plain"
echo "     plugins; only @dsh-test-account/test-account carries the bundle patch)"
"${DSH[@]}" plugin --profile "$PROFILE" add \
  "$ROOT/packages/test-account" \
  "$ROOT/packages/browser-use-playwright-mcp-storage" \
  "@deepseek-ai/dsh-browser-use@${DSH_VERSION}" \
  "@deepseek-ai/dsh-experimental-browser-use-runtime@${DSH_VERSION}"

cat <<EOF

==> done

  profile          ${PROFILE}  (~/.dsh/profiles/${PROFILE} unless DSH_HOME says otherwise)
  account store    \${DSH_HOME:-~/.dsh}/test-accounts
  browser provider @dsh-test-account/browser-use-playwright-mcp-storage (--caps=storage)

Start it with:

  npx -y @deepseek-ai/dsh@${DSH_VERSION} --profile ${PROFILE} web --port 3081

Then send one message in a Session (the header shortcut only mounts once a
Session has a turn), and use 「测试账号」 from the conversation header or from
the right Sidebar's guide. Saving a login state needs a browser you already
logged into by hand, so the provider ships headless: false.
EOF
