#!/bin/sh
# Install the newest Sapling ISL VS Code extension from this fork's releases.
#
#   curl -fsSL https://raw.githubusercontent.com/lucasingels/sapling/main/vscode.sh | sh
#
# The extension is sideloaded from a .vsix rather than installed from a
# marketplace, so it does not auto-update. Re-run this to update.
set -eu

repo="${SAPLING_REPO:-lucasingels/sapling}"

# The releases API returns newest first, so the first extension-v* .vsix is the
# current one. grep/sed rather than jq, so this needs nothing but curl.
url=$(curl -fsSL "https://api.github.com/repos/$repo/releases" \
  | grep -o '"browser_download_url": *"[^"]*/extension-v[^"]*\.vsix"' \
  | head -n 1 \
  | sed 's/.*"\(https[^"]*\)"/\1/')
[ -n "$url" ] || { echo "no extension-v* release with a .vsix in $repo" >&2; exit 1; }

# $VSCODE wins; otherwise the first editor CLI on PATH.
cli="${VSCODE:-}"
if [ -z "$cli" ]; then
  for candidate in code cursor code-insiders codium; do
    if command -v "$candidate" >/dev/null 2>&1; then
      cli="$candidate"
      break
    fi
  done
fi
[ -n "$cli" ] || {
  echo "no editor CLI found (tried code, cursor, code-insiders, codium)" >&2
  echo "in VS Code run: Shell Command: Install 'code' command in PATH" >&2
  exit 1
}

# Keep the .vsix name: given a path ending in anything else,
# --install-extension reads it as an extension id and fails.
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT INT TERM
vsix="$dir/${url##*/}"

echo "downloading ${url##*/}"
curl -fsSL -o "$vsix" "$url"
"$cli" --install-extension "$vsix" --force
"$cli" --list-extensions --show-versions 2>/dev/null | grep -i '^meta\.sapling-scm@' || true
