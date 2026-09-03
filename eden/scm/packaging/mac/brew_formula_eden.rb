# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed according to the terms of the
# GNU General Public License version 2.

# Template for the sapling-eden formula, filled in by prepare_formula_eden.py
# and pushed to lucasingels/homebrew-tap by
# .github/workflows/sapling-eden-macos-arm64-release.yml. See
# eden-homebrew-packaging-plan.md ("Phase 3 -- the formula") for the design
# this follows.
#
# Unlike the plain `sapling` formula, this does not build anything: the
# workflow builds with getdeps and assembles a self-contained prefix
# (eden/scm/packaging/mac/assemble_eden_prefix.sh) ahead of time, uploads it
# as a tarball to a GitHub release, and this formula just downloads,
# verifies, and installs it. `install` only takes libexec/* from that
# tarball and writes its own bin/sl + bin/eden wrappers (using opt_libexec,
# a path that survives upgrades) -- the tarball's own bin/ wrappers use
# relative-path resolution meant for running the assembled prefix standalone
# (see assemble_eden_prefix.sh), which doesn't hold once bin/sl is a
# Homebrew-managed symlink into a versioned Cellar keg.
class SaplingEden < Formula
  desc "Sapling source control client with EdenFS (sl worktree support)"
  homepage "https://sapling-scm.com"
  license "GPL-2.0-or-later"
  # These fields are intended to be populated by prepare_formula_eden.py
  url "%URL%"
  version "%VERSION%"
  sha256 "%SHA256%"

  # The plain `sapling` formula also installs bin/sl; only one can be linked
  # at a time (`brew unlink sapling && brew install sapling-eden`).
  conflicts_with "sapling"

  # Runtime deps of edenfs/edenfsctl.real/sl themselves: getdeps built them
  # with --allow-system-packages, so they link straight against these kegs'
  # absolute /opt/homebrew/opt/<pkg>/lib/... paths (plan decision #3) rather
  # than bundling copies. This list was read off `otool -L` on the actual
  # shipped binaries (edenfs, edenfs_privhelper, sl, and the thrift-python /
  # folly-python extensions) -- keep it in sync if that set changes.
  depends_on "boost"
  depends_on "fmt"
  depends_on "gflags"
  depends_on "glog"
  depends_on "icu4c@78"
  depends_on "libevent"
  depends_on "libsodium"
  depends_on "lmdb"
  depends_on "lz4"
  depends_on "openssl@3"
  # sl links python@3.12's framework directly (build.py's interpreter pick);
  # the bundled thrift-python/folly-python runtime under libexec/eden/python
  # is built against python@3.10 specifically (see assemble_eden_prefix.sh).
  # Until those converge on one version (plan decision #4, not done yet),
  # the formula needs both.
  depends_on "python@3.10"
  depends_on "python@3.12"
  depends_on "re2"
  depends_on "snappy"
  depends_on "xxhash"
  depends_on "xz"
  depends_on "zlib"
  depends_on "zstd"
  # No `depends_on "node"`: unlike the plain `sapling` formula,
  # assemble_eden_prefix.sh does not assemble isl-dist.tar.xz yet (tracked
  # as follow-up in the plan), so `sl web` is not expected to work from this
  # formula for now -- only `sl`/`eden`/`sl worktree`.

  def install
    libexec.install Dir["libexec/*"]

    (bin/"sl").write <<~EOS
      #!/bin/sh
      exec "#{opt_libexec}/sl" "$@"
    EOS

    (bin/"eden").write <<~EOS
      #!/bin/sh
      exec "#{Formula["python@3.10"].opt_bin}/python3.10" "#{opt_libexec}/eden/edenfsctl.real/__main__.py" "$@"
    EOS
  end

  def caveats
    <<~EOS
      EdenFS's privhelper needs to run setuid-root to mount filesystems.
      Run this once after install, and again after every
      `brew upgrade sapling-eden` (a fresh keg resets ownership/perms):

        sudo chown root:wheel #{opt_libexec}/eden/edenfs_privhelper
        sudo chmod 4755 #{opt_libexec}/eden/edenfs_privhelper

      If you skip this, `eden start` falls back to wrapping the whole
      daemon in `sudo` and will prompt for your password every time it
      starts -- upstream's own dev-machine behavior, just less convenient.

      Do not start the daemon with `brew services`: it must run as your
      user, not root -- only the privhelper above needs elevated
      privileges. `eden start` is not a login item either; run it yourself
      or from your shell profile.
    EOS
  end

  test do
    system bin/"sl", "--version"
    system bin/"eden", "--version"
    assert_match "worktree", shell_output("#{bin}/sl worktree --help")
  end
end
