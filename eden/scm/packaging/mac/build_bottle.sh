#!/bin/bash
# Builds a Homebrew bottle for sapling (binary: sl)
# Usage: build_bottle.sh [version]
#   version defaults to the contents of the SAPLING_VERSION file at the repo
#   root; pass an argument to override it.
# Example: build_bottle.sh        # uses SAPLING_VERSION
#          build_bottle.sh 0.3.1  # explicit override

set -e

SCRIPT_DIR=$(dirname "$0")
REPO_ROOT=$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)

# Default the version to the SAPLING_VERSION file; an explicit argument wins.
VERSION=${1:-$(<"$REPO_ROOT/SAPLING_VERSION")}
if [ -z "$VERSION" ]; then
  echo "error: no version supplied and $REPO_ROOT/SAPLING_VERSION is missing or empty" >&2
  exit 1
fi

brew tap lucasingels/tap "https://x-access-token:${GH_TOKEN}@github.com/lucasingels/homebrew-tap" 2>/dev/null || true

"$SCRIPT_DIR/prepare_formula.py" \
  -t aarch64-apple-darwin \
  -r "$VERSION" \
  -b sl \
  -o "$(brew --repository lucasingels/tap)/Formula/sapling.rb"

cd "$(brew --repository lucasingels/tap)"
git add Formula/sapling.rb
git commit -m "Add sapling formula" 2>/dev/null || true

cd "$REPO_ROOT"
HOMEBREW_NO_INSTALL_FROM_API=1 HOMEBREW_FAIL_LOG_LINES=100 \
  brew install --build-bottle lucasingels/tap/sapling || \
  brew link --overwrite lucasingels/tap/sapling

BOTTLE_ROOT_URL="https://github.com/lucasingels/sapling/releases/download/v${VERSION}"
# Modern Homebrew splits bottling into two steps: first build the bottle tarball
# plus its JSON metadata, then merge the generated bottle block into the formula.
# (`--write` is only valid together with `--merge`, which takes the JSON file.)
brew bottle --json --no-rebuild --root-url "$BOTTLE_ROOT_URL" lucasingels/tap/sapling
brew bottle --merge --write --no-commit sapling--*.bottle.json

# `brew bottle` writes the tarball with a double dash (sapling--<version>…), but
# Homebrew downloads bottles with a single dash (sapling-<version>…). Rename
# before uploading so the published asset matches the URL Homebrew derives from
# the formula's root_url; the sha256 is unaffected by the rename.
RAW_BOTTLE=$(ls "sapling--$VERSION"*.bottle.tar.gz)
BOTTLE_FILE=${RAW_BOTTLE/sapling--/sapling-}
mv "$RAW_BOTTLE" "$BOTTLE_FILE"

cd "$(brew --repository lucasingels/tap)"
git add Formula/sapling.rb
git commit -m "sapling $VERSION"
git push

cd "$REPO_ROOT"
# Pin the tag to the commit that was built. Without --target, gh tags the
# default branch's HEAD, which may have moved on since this run started.
TARGET_SHA="${GITHUB_SHA:-$(git rev-parse HEAD)}"
gh release create "v${VERSION}" \
  --repo lucasingels/sapling \
  --target "$TARGET_SHA" \
  --title "Sapling v${VERSION}" \
  --generate-notes \
  "$BOTTLE_FILE" \
  2>/dev/null || \
gh release upload "v${VERSION}" \
  --repo lucasingels/sapling \
  --clobber \
  "$BOTTLE_FILE"

echo "Bottle built and uploaded: $BOTTLE_FILE"
echo "Formula pushed to lucasingels/tap"
