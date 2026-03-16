#!/bin/bash
# Builds a Homebrew bottle for sapling-dev (binary: sld)
# Usage: build_bottle.sh <version>
# Example: build_bottle.sh 0.1.2

set -e

VERSION=${1:?Usage: build_bottle.sh <version>}
SCRIPT_DIR=$(dirname "$0")
REPO_ROOT=$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)

brew tap-new lucasingels/sapling 2>/dev/null || true

"$SCRIPT_DIR/prepare_formula.py" \
  -t aarch64-apple-darwin \
  -r "$VERSION" \
  -b sld \
  -o "$(brew --repository lucasingels/sapling)/Formula/sapling-dev.rb"

cd "$(brew --repository lucasingels/sapling)"
git add Formula/sapling-dev.rb
git commit -m "Add sapling-dev formula" 2>/dev/null || true

cd "$REPO_ROOT"
HOMEBREW_NO_INSTALL_FROM_API=1 HOMEBREW_FAIL_LOG_LINES=100 \
  brew install --build-bottle lucasingels/sapling/sapling-dev || \
  brew link --overwrite lucasingels/sapling/sapling-dev

brew bottle lucasingels/sapling/sapling-dev

mv "sapling-dev--$VERSION"*.bottle.tar.gz "sapling-dev-$VERSION.arm64.bottle.tar.gz"
echo "Bottle built: sapling-dev-$VERSION.arm64.bottle.tar.gz"
