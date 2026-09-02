#!/bin/bash
# Assembles a self-contained EdenFS + eden-enabled `sl` install prefix from a
# getdeps build, in (most of) the layout eden-homebrew-packaging-plan.md
# describes:
#
#   bin/sl                          wrapper -> libexec/sl
#   bin/eden                        wrapper -> python3 libexec/eden/bin/edenfsctl.real/__main__.py
#   libexec/sl                      eden-enabled sl (features: eden, sl_oss)
#   libexec/eden/bin/edenfs
#   libexec/eden/bin/edenfs_privhelper
#   libexec/eden/bin/eden_apfs_mount_helper
#   libexec/eden/bin/edenfsctl.real/   (dir; TYPE-dir python executable)
#   libexec/eden/lib/*.dylib        runtime deps fixup-dyn-deps bundles
#
# (edenfs/edenfsctl.real/etc. sit under libexec/eden/bin/, not directly under
# libexec/eden/, because `getdeps.py fixup-dyn-deps` always writes a bin/+lib/
# pair into the output dir it's given -- see the `fixup-eden` mise task. The
# CLI's self-locating path defaults (eden/fs/cli/daemon_util.py,
# eden/fs/cli/util.py get_hg_binary, eden/fs/cli/daemon.py
# get_edenfsctl_cmd, eden/scm/lib/edenfs-client/src/utils.rs
# find_sibling_eden_binary) all walk upward from their own location looking
# for these siblings, so they don't hardcode this exact nesting depth.)
#
# Usage:
#   ./eden/scm/packaging/mac/assemble_eden_prefix.sh <output-prefix-dir>
#
# Prereqs (see eden-oss-build-notes.md and mise.local.toml):
#   mise run build-eden && mise run build-sl-eden
#   mise run build-eden-python && mise run install-eden-python-runtime
#
# Known gap (tracked in eden-homebrew-packaging-plan.md): the thrift-python C
# extensions backing edenfsctl.real still carry LC_RPATH entries into
# $GETDEPS_SCRATCH/installed/{fbthrift,folly}-python/lib (see
# darwin-thrift-python-runtime.sh) rather than into this prefix, and the
# runtime dylibs under libexec/eden/lib/ are bundled wholesale rather than
# declared as Homebrew depends_on. So the assembled tree is not yet fully
# relocatable off this machine's getdeps scratch -- that's Phase 2/3 work,
# not this script's job. This script's job is proving out the *path
# discovery* defaults (Phase 1) end to end.
#
# lib/isl-dist.tar.xz (ISL) is intentionally not assembled here; that's
# unchanged from the existing sapling formula and out of scope for this
# eden-specific script.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../../../.." && pwd)
GETDEPS_SCRATCH=${GETDEPS_SCRATCH:-$HOME/.local/share/getdeps/sapling}
# Must match whatever brew python the thrift-python runtime wheel was
# installed into (mise run install-eden-python-runtime). Pinned to 3.10 here
# because that's what actually builds today; switching the whole toolchain to
# python@3.12 is a separate, not-yet-done Phase 2/3 decision (see the plan).
PYTHON_BIN=${PYTHON_BIN:-/opt/homebrew/opt/python@3.10/bin/python3.10}
PREFIX=${1:?"usage: $0 <output-prefix-dir>"}

die() {
  echo "error: $*" >&2
  exit 1
}

[ -x "$PYTHON_BIN" ] || die "python interpreter not found: $PYTHON_BIN"

EDEN_BUILD="$GETDEPS_SCRATCH/build/eden"
SL_INSTALLED="$GETDEPS_SCRATCH/installed/sapling"
[ -x "$SL_INSTALLED/bin/sl" ] || die "$SL_INSTALLED/bin/sl not found (run: mise run build-sl-eden)"
[ -d "$EDEN_BUILD/eden/fs/cli/edenfsctl.real" ] ||
  die "edenfsctl.real build tree not found under $EDEN_BUILD (run: mise run build-eden-python)"

case "$PREFIX" in
  /*) ;;
  *) PREFIX="$PWD/$PREFIX" ;;
esac

rm -rf "$PREFIX"
mkdir -p "$PREFIX/bin"

echo "==> eden binaries + runtime dylibs (fixup-dyn-deps)"
(
  cd "$REPO_ROOT"
  env -u PYTHON -u PYTHON3 -u PYTHON_SYS_EXECUTABLE \
    ./build/fbcode_builder/getdeps.py fixup-dyn-deps \
    --scratch-path "$GETDEPS_SCRATCH" \
    --allow-system-packages --no-tests \
    --src-dir=. --src-dir=sapling:. \
    eden "$PREFIX/libexec/eden"
)

echo "==> edenfsctl.real (build-tree dir; TYPE dir only installs __main__.py)"
rm -rf "$PREFIX/libexec/eden/bin/edenfsctl.real"
cp -R "$EDEN_BUILD/eden/fs/cli/edenfsctl.real" "$PREFIX/libexec/eden/bin/edenfsctl.real"

echo "==> sl"
cp "$SL_INSTALLED/bin/sl" "$PREFIX/libexec/sl"

cat >"$PREFIX/bin/sl" <<'WRAP'
#!/bin/sh
exec "$(cd "$(dirname "$0")" && pwd)/../libexec/sl" "$@"
WRAP
chmod +x "$PREFIX/bin/sl"

cat >"$PREFIX/bin/eden" <<WRAP
#!/bin/sh
exec "$PYTHON_BIN" "\$(cd "\$(dirname "\$0")" && pwd)/../libexec/eden/bin/edenfsctl.real/__main__.py" "\$@"
WRAP
chmod +x "$PREFIX/bin/eden"

echo "==> strip + codesign"
strip -x "$PREFIX/libexec/eden/bin/edenfs" "$PREFIX/libexec/eden/bin/edenfs_privhelper" \
  "$PREFIX/libexec/eden/bin/eden_apfs_mount_helper" 2>/dev/null || true
codesign -s - -f \
  "$PREFIX/libexec/eden/bin/edenfs" \
  "$PREFIX/libexec/eden/bin/edenfs_privhelper" \
  "$PREFIX/libexec/eden/bin/eden_apfs_mount_helper" \
  "$PREFIX/libexec/eden/lib"/*.dylib \
  "$PREFIX/libexec/sl" \
  2>/dev/null || true

echo "Assembled: $PREFIX"
echo "One-time setuid step still required:"
echo "  sudo chown root:wheel $PREFIX/libexec/eden/bin/edenfs_privhelper"
echo "  sudo chmod 4755 $PREFIX/libexec/eden/bin/edenfs_privhelper"
