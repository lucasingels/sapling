#!/bin/bash
# Verifies that the OSS build (sl_oss feature, no eden) does not pull in
# edenfs-client or fbthrift. Run from the repo root.
set -e

SCRIPT_DIR=$(dirname "$0")
REPO_ROOT=$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)

echo "Checking OSS dependency tree for forbidden crates..."

FORBIDDEN=$(cargo tree \
  --manifest-path "$REPO_ROOT/eden/scm/exec/hgmain/Cargo.toml" \
  --no-default-features \
  --features sl_oss \
  2>&1 | grep -E "sapling-edenfs-client|fbthrift" || true)

if [ -n "$FORBIDDEN" ]; then
  echo "ERROR: Forbidden crates found in OSS build:"
  echo "$FORBIDDEN"
  exit 1
fi

echo "OK: No forbidden crates in OSS build."
