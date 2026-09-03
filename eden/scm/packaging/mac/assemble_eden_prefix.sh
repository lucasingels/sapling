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
#   libexec/eden/lib/*.dylib        edenfs/edenfsctl's own deps fixup-dyn-deps bundles
#   libexec/eden/python/lib/*.dylib libthrift_python_cpp/libfolly_python_cpp/libfolly (private, no brew formula)
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
# edenfsctl.real ships its folly/thrift.python/thrift.py3 bindings as
# symlinks into brew python's site-packages (where `mise run
# install-eden-python-runtime` put them) rather than bundling them, and every
# compiled extension under there -- plus the ones already bundled inside
# edenfsctl.real/thrift/python/ -- carries an LC_RPATH into
# $GETDEPS_SCRATCH/installed/{fbthrift,folly}-python/lib. Both are
# machine-local and would break on any other machine (a CI runner, an end
# user's Mac). This script dereferences those symlinks into real copies,
# bundles just the 3 private runtime libraries those extensions need
# (libthrift_python_cpp.dylib, libfolly_python_cpp.dylib, libfolly.dylib --
# see the "bundling the private thrift-python/folly-python runtime libs"
# step below for why NOT fixup-dyn-deps here), and rewrites every
# extension's rpath to point at that bundle. Every *other* (Homebrew-backed)
# dependency is deliberately left as the absolute /opt/homebrew/... path
# these files already carry (plan decision #3: those are depends_on, not
# bundled).
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

echo "==> dereferencing folly/thrift.python/thrift.py3 symlinks into real copies"
for rel in folly thrift/python thrift/py3; do
  link="$PREFIX/libexec/eden/bin/edenfsctl.real/$rel"
  if [ -L "$link" ]; then
    target=$(readlink "$link")
    rm "$link"
    cp -R "$target" "$link"
  fi
done
find "$PREFIX/libexec/eden/bin/edenfsctl.real" -name "__pycache__" -type d -exec rm -rf {} + 2>/dev/null || true

echo "==> bundling the private thrift-python/folly-python runtime libs"
# libthrift_python_cpp.dylib, libfolly_python_cpp.dylib and libfolly.dylib
# are getdeps-private build products with no Homebrew formula of their own,
# so (unlike edenfs/sl's own deps, which stay as absolute /opt/homebrew/...
# references satisfied by the formula's depends_on -- plan decision #3) they
# have to be bundled somewhere. Deliberately NOT using fixup-dyn-deps here:
# it would also bundle every *Homebrew* library these 3 pull in (glog,
# openssl, icu, ...), producing a second copy of each that lives at a
# different path than the one the thrift.python/folly extension .so files
# below still reference directly -- two distinct files backing "the same"
# library loaded into one process, which made glog/gflags abort on duplicate
# flag registration when this was tried. Copying just these 3 and adding a
# self-referential @loader_path rpath (so they can still find each other)
# leaves every Homebrew dependency resolving to the one, single absolute
# keg path every other component already uses.
PY_LIB_DIR="$PREFIX/libexec/eden/python/lib"
mkdir -p "$PY_LIB_DIR"
copy_runtime_lib() {
  local dir="$1" name="$2" real
  real=$(readlink "$dir/$name.dylib")
  cp -P "$dir/$name.dylib" "$dir/$real" "$PY_LIB_DIR/"
}
copy_runtime_lib "$GETDEPS_SCRATCH/installed/fbthrift-python/lib" libthrift_python_cpp
copy_runtime_lib "$GETDEPS_SCRATCH/installed/folly-python/lib" libfolly_python_cpp
copy_runtime_lib "$GETDEPS_SCRATCH/installed/folly-python/lib" libfolly
chmod u+w "$PY_LIB_DIR"/*.dylib
for lib in "$PY_LIB_DIR"/*.dylib; do
  [ -L "$lib" ] && continue
  install_name_tool -add_rpath "@loader_path" "$lib" 2>/dev/null || true
  codesign -s - -f "$lib" 2>/dev/null || true
done

echo "==> relocating the thrift-python/folly-python extensions (rpaths)"
# A file may carry either or both of these two old rpaths. dyld hard-errors
# ("duplicate LC_RPATH") on two identical entries, so convert at most one to
# the new value and delete the other rather than rewriting both to it.
FBTHRIFT_PY_LIB="$GETDEPS_SCRATCH/installed/fbthrift-python/lib"
FOLLY_PY_LIB="$GETDEPS_SCRATCH/installed/folly-python/lib"
find "$PREFIX/libexec/eden/bin/edenfsctl.real" -name "*.so" -print0 |
  while IFS= read -r -d '' so; do
    reldir=$("$PYTHON_BIN" -c 'import os,sys; print(os.path.relpath(sys.argv[1], sys.argv[2]))' \
      "$PY_LIB_DIR" "$(dirname "$so")")
    if install_name_tool -rpath "$FBTHRIFT_PY_LIB" "@loader_path/$reldir" "$so" 2>/dev/null; then
      install_name_tool -delete_rpath "$FOLLY_PY_LIB" "$so" 2>/dev/null || true
    else
      install_name_tool -rpath "$FOLLY_PY_LIB" "@loader_path/$reldir" "$so" 2>/dev/null || true
    fi
    codesign -s - -f "$so" 2>/dev/null || true
  done

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
