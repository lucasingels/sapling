#!/bin/bash
# Builds a Homebrew bottle for sapling-dev (binary: sld)
# Usage: build_bottle.sh <version>
# Example: build_bottle.sh 0.1.2

set -e

VERSION=${1:?Usage: build_bottle.sh <version>}
SCRIPT_DIR=$(dirname "$0")
REPO_ROOT=$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)

brew tap lucasingels/tap "https://x-access-token:${GH_TOKEN}@github.com/lucasingels/homebrew-tap" 2>/dev/null || true

"$SCRIPT_DIR/prepare_formula.py" \
  -t aarch64-apple-darwin \
  -r "$VERSION" \
  -b sld \
  -o "$(brew --repository lucasingels/tap)/Formula/sapling-dev.rb"

cd "$(brew --repository lucasingels/tap)"
git add Formula/sapling-dev.rb
git commit -m "Add sapling-dev formula" 2>/dev/null || true

cd "$REPO_ROOT"
HOMEBREW_NO_INSTALL_FROM_API=1 HOMEBREW_FAIL_LOG_LINES=100 \
  brew install --build-bottle lucasingels/tap/sapling-dev || \
  brew link --overwrite lucasingels/tap/sapling-dev

BOTTLE_ROOT_URL="https://github.com/lucasingels/sapling/releases/download/v${VERSION}"
brew bottle --write --no-commit --root-url "$BOTTLE_ROOT_URL" lucasingels/tap/sapling-dev

BOTTLE_FILE=$(ls "sapling-dev--$VERSION"*.bottle.tar.gz)

cd "$(brew --repository lucasingels/tap)"
git add Formula/sapling-dev.rb
git commit -m "sapling-dev $VERSION"
git push

cd "$REPO_ROOT"
gh release create "v${VERSION}" \
  --repo lucasingels/sapling \
  --title "Sapling Dev v${VERSION}" \
  --generate-notes \
  "$BOTTLE_FILE" \
  2>/dev/null || \
gh release upload "v${VERSION}" \
  --repo lucasingels/sapling \
  "$BOTTLE_FILE"

echo "Bottle built and uploaded: $BOTTLE_FILE"
echo "Formula pushed to lucasingels/tap"
