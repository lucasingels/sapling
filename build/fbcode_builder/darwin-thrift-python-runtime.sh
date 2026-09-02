#!/bin/sh
# Make the getdeps-built thrift-python runtime (fbthrift-python wheel, which
# bundles folly's python package) importable by the pinned brew python on
# macOS, so eden's CMake tree can find it and edenfsctl.real can run.
#
# Idempotent: re-run after every `mise run build-eden-python`. Invoked by
# `mise run install-eden-python-runtime`; see eden-oss-build-notes.md
# ("The thrift-python runtime port").
#
# Layout (the only sound one, see the notes): the PLAIN wheel, no vendored
# dylibs. The extension modules were linked with rpaths pointing at
#   $GETDEPS_SCRATCH/installed/fbthrift-python/lib  (libthrift_python_cpp)
#   $GETDEPS_SCRATCH/installed/folly-python/lib     (libfolly, libfolly_python_cpp)
# (fbthrift-python-darwin.patch / folly-python-darwin.patch), so nothing has
# to be symlinked into /opt/homebrew/lib and DYLD_LIBRARY_PATH is not needed.
set -eu

SCRATCH="${GETDEPS_SCRATCH:-$HOME/.local/share/getdeps/sapling}"
PY="${Python3_EXECUTABLE:-/opt/homebrew/opt/python@3.10/bin/python3.10}"
TOOLS="$SCRATCH/py310-tools"   # pip/setuptools/wheel for a pip-less brew python
INSTALLED="$SCRATCH/installed"

die() { echo "error: $*" >&2; exit 1; }

[ -x "$PY" ] || die "python not found: $PY"
[ -d "$TOOLS/pip" ] || die "pip tooling missing: $TOOLS (see mise.local.toml build-eden-python)"

wheel=""
for w in "$INSTALLED"/fbthrift-python/share/thrift/wheels/thrift-*.whl; do
  [ -f "$w" ] && wheel="$w"
done
[ -n "$wheel" ] || die "no thrift wheel under $INSTALLED/fbthrift-python/share/thrift/wheels (run: mise run build-eden-python)"

for lib in fbthrift-python/lib/libthrift_python_cpp.dylib folly-python/lib/libfolly_python_cpp.dylib; do
  [ -e "$INSTALLED/$lib" ] || die "runtime dylib missing: $INSTALLED/$lib"
done

site=$("$PY" -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])')
echo "installing $(basename "$wheel") into $site"

# Stale July layout: a hand-copied folly package + a .pth pointing into a
# purged scratch shadow the wheel's bundled folly package. Remove them.
rm -f "$site/folly-python.pth"
if [ -d "$site/folly" ] && [ ! -f "$site/folly/__init__.py" ]; then
  rm -rf "$site/folly"
fi

# The wheel ships thrift.python, thrift.py3, apache.thrift.metadata and folly.
# --force-reinstall keeps this idempotent across rebuilds of the same version.
PYTHONPATH="$TOOLS" "$PY" -m pip install --no-deps --force-reinstall --no-warn-script-location -q "$wheel"

# -I: getdeps puts a legacy `thrift` package on PYTHONPATH and a cwd with a
# thrift/ dir shadows the wheel; the probe must see exactly what CMake sees.
cd /
"$PY" -I -c '
import folly.iobuf, folly.executor, thrift.python.types, thrift.python.serializer, thrift.python.client
import os, thrift.python
print("thrift-python runtime ok:", os.path.dirname(list(thrift.python.__path__)[0]))
print("folly:", os.path.dirname(folly.iobuf.__file__))
'
