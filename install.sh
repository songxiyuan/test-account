#!/usr/bin/env bash
#
# Install the test-account plugin (and the Playwright MCP storage provider it
# needs) into one DSH profile.
#
#   ./install.sh              # installs into the "test-account" profile
#   ./install.sh web          # installs into the existing "web" profile
#   DSH_VERSION=0.1.5-rc.3 ./install.sh ta
#
# The profile is initialized from the shipped "web" template when it does not
# exist yet, so installing into a brand-new profile name is safe.

set -euo pipefail

PROFILE="${1:-test-account}"
DSH_VERSION="${DSH_VERSION:-0.1.5-rc.3}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# `dsh` is not necessarily on PATH when DSH itself is run through npx. An
# existing `dsh` is preferred because it is already the documented 0.1.5 line;
# DSH_BIN overrides both, and the pinned npx fetch is the fallback.
if [[ -n "${DSH_BIN:-}" ]]; then
  read -r -a DSH <<<"$DSH_BIN"
elif command -v dsh >/dev/null 2>&1; then
  DSH=(dsh)
else
  DSH=(npx -y "@deepseek-ai/dsh@${DSH_VERSION}")
fi

echo "==> building workspace packages"
(cd "$ROOT" && pnpm install && pnpm run build)

# Only a missing profile is initialized: `--from-default-profile` refuses a
# shipped template name (`web`, `acp`, `headless`, …) even when that profile
# already exists on disk, so running it unconditionally broke `./install.sh web`.
PROFILE_DIR="${DSH_HOME:-$HOME/.dsh}/profiles/${PROFILE}"
if [[ -f "$PROFILE_DIR/package.json" ]]; then
  echo "==> profile '${PROFILE}' already exists; leaving it untouched"
else
  echo "==> initializing profile '${PROFILE}' from the web template"
  "${DSH[@]}" --profile "$PROFILE" --from-default-profile web --dump-config >/dev/null
fi

# Profiles installed before the 0.1.5 move still carry the 0.1.7 browser-use
# stack. It only exists on the 0.1.6+ line and is no longer in this plugin's
# bundle patch, so drop it to keep the profile on one version line.
if [[ -f "$PROFILE_DIR/package.json" ]] && grep -q 'browser-use' "$PROFILE_DIR/package.json"; then
  echo "==> removing the retired browser-use stack from profile '${PROFILE}'"
  "${DSH[@]}" plugin --profile "$PROFILE" remove \
    '@deepseek-ai/dsh-browser-use' \
    '@deepseek-ai/dsh-experimental-browser-use-runtime' \
    '@songxiyuan/browser-use-playwright-mcp-storage' \
    '@dsh-test-account/browser-use-playwright-mcp-storage'
fi

# The packages used to live under the @dsh-test-account scope. A profile that
# installed them then would keep a dependency whose package name no longer
# exists, so drop those names before adding today's ones.
if [[ -f "$PROFILE_DIR/package.json" ]] && grep -q '@dsh-test-account/' "$PROFILE_DIR/package.json"; then
  echo "==> migrating profile '${PROFILE}' off the retired @dsh-test-account scope"
  "${DSH[@]}" plugin --profile "$PROFILE" remove \
    '@dsh-test-account/test-account' \
    '@dsh-test-account/playwright-mcp-storage'
fi

echo "==> installing plugins into profile '${PROFILE}'"
echo "    (the 'declares no dsh.bundle' warning is expected for the provider;"
echo "     only @songxiyuan/test-account carries the bundle patch)"
"${DSH[@]}" plugin --profile "$PROFILE" add \
  "$ROOT/packages/test-account" \
  "$ROOT/packages/playwright-mcp-storage"

cat <<EOF

==> done

  profile          ${PROFILE}  (~/.dsh/profiles/${PROFILE} unless DSH_HOME says otherwise)
  account store    \${DSH_HOME:-~/.dsh}/test-accounts
  browser provider @songxiyuan/playwright-mcp-storage
                   (@playwright/mcp --caps=storage, one browser per Session)

Start it with (0.1.5 CLI: the app's flags follow the launcher flags):

  ${DSH[*]} --profile ${PROFILE} --port 3081

Then send one message in a Session (the header shortcut only mounts once a
Session has a turn), and use 「测试账号」 from the conversation header or from
the right Sidebar's guide. Saving a login state needs a browser you already
logged into by hand, so the provider ships headless: false.
EOF
