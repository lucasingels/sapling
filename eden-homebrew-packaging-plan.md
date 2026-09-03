# Plan: ship EdenFS + eden-enabled `sl` as one Homebrew install

Status: proposal, 2026-09-02. Companion to `eden-oss-build-notes.md`, which records how the macOS build and bring-up were made to work on one machine. This plan turns that into something `brew install` can deliver.

## Goal

One command, `brew install lucasingels/tap/sapling-eden`, gives a macOS arm64 machine:

- `sl` built with the `eden` feature, so `sl worktree` exists.
- `eden` (the EdenFS CLI) and the `edenfs` daemon, able to `eden clone` a `sl clone --git` backing repo over NFS and create worktrees.
- ISL as today.
- Zero hand-written config: `sl worktree add` works after one documented `sudo` step.

Non-goals for the first release: Linux, Intel Macs, macFUSE, redirections, upstreaming (tracked separately in the notes' "Loose ends").

## Where we start

- The tap formula (`eden/scm/packaging/mac/brew_formula.rb`) builds `sl` from source inside `brew install --build-bottle` on a GitHub `macos-latest` runner, then `build_bottle.sh` bottles it, uploads the bottle to a GitHub release on `lucasingels/sapling`, and pushes the formula to `lucasingels/homebrew-tap`. It ships `libexec/sl`, `libexec/isl-dist.tar.xz` and a `bin/sl` wrapper.
- Locally, everything EdenFS needs now builds via getdeps (`mise run build-eden`, `build-sl-eden`, `build-eden-python`) and runs from `~/.local/share/getdeps/sapling` plus `built-eden/`, held together by a `~/bin/edenfsctl` wrapper that pins six environment variables and by three user config files. Those are the things a package must make unnecessary.
- The fork carries the fixes as commits (`5891b2f1244`, `2e71a6ba7a10`, `ddd0cbc4da33`) and as getdeps patch files under `build/fbcode_builder/patches/`.

## Decisions to take up front

1. **Separate formula first.** Publish `sapling-eden` next to the existing `sapling`; the two conflict on `bin/sl` so a user picks one. The plain formula stays small for people who do not want a filesystem daemon. Merge later once `sapling-eden` has soaked.
2. **Prebuilt tarball, not a source build inside brew.** getdeps needs hours cold and wants a persistent cache; Homebrew's sandboxed `install` is the wrong place for it. The workflow builds with getdeps, assembles a prefix tree, uploads `sapling-eden-<version>-arm64_<macos>.tar.gz` to the release, and the formula's `url` points at it. `brew bottle` and its two-step merge go away.
3. **Runtime libraries from Homebrew, not bundled.** getdeps with `--allow-system-packages` already links against `/opt/homebrew/opt/<pkg>/lib` keg paths, which is exactly how Homebrew binaries are expected to link. Declare them as `depends_on`. This retires the local `fixup-eden` bundling and the absolute-path rewriting.
4. **Python: the formula's python, one version.** thrift-python is a set of C extensions for one interpreter. Pin `depends_on "python@3.12"` and build both the wheel and `edenfsctl.real` against it. (The local setup used 3.10 only because it was installed.)
5. **Setuid privhelper via caveats, sudo fallback as safety net.** Homebrew cannot install setuid-root files. The formula's `caveats` print the one-time `sudo chown root:wheel … && sudo chmod 4755 …` for `libexec/eden/edenfs_privhelper` (needed again after every upgrade). If the user skips it, `eden start` already wraps the daemon in `sudo` and prompts, which is upstream's own dev-machine behaviour. Decided 2026-09-03: ship this (setuid + caveat) for the first release. A `NOPASSWD` `sudoers.d` rule scoped to the *stable* `opt_libexec` privhelper path (which survives `brew upgrade`, unlike the versioned Cellar path, so it would need setting up only once ever instead of after every upgrade) is a real alternative worth offering later as an opt-in for people annoyed by the repeat prompt — noted here, not implemented yet.

## Target layout inside the formula prefix

```
bin/sl                         wrapper: exec libexec/sl --config web.isl-dist-path=… "$@"
bin/eden                       wrapper: exec python3.12 libexec/eden/edenfsctl.real/__main__.py "$@"
libexec/sl                     eden-enabled sl (features: eden, sl_oss)
libexec/eden/edenfs            daemon
libexec/eden/edenfs_privhelper root:wheel 4755 after the caveat step
libexec/eden/eden_apfs_mount_helper   shipped, unused without redirections
libexec/eden/edenfsctl.real/   dir-type Python program (the CLI)
libexec/eden/python/           thrift-python + folly-python runtime (site-packages)
lib/isl-dist.tar.xz
```

Everything the wrappers set today must become a default derived from the binary's own location, so the wrappers shrink to two lines each.

## Phase 1 — make the pieces self-locating (fork code changes, local validation)

All in `~/code/sapling`, each a small commit, each verifiable on this machine by assembling the layout above by hand (`scripts` in `eden/scm/packaging/mac/`) and running from a clean shell with no `EDENFS_*`, `SL_*`, `HG*` variables set.

1. **CLI default paths** (`eden/fs/cli/daemon_util.py`, `daemon.py`, `redirect.py`, `cmd_util.py`, `trace_cmd.py`): resolve `edenfs`, `edenfs_privhelper`, `eden_apfs_mount_helper`, `eden_fsck`, `eden_trace_stream` relative to `edenfsctl.real`'s own directory (`<libexec>/eden/`) before falling back to Meta's `/usr/local/libexec/eden`. `find_daemon_binary` already tries `../libexec/eden/edenfs`; extend the same idea to the privhelper, which today is a hardcoded absolute path that the CLI always passes as `--privhelper_path`.
2. **CLI `edenfsctl` path** (`daemon.py get_edenfsctl_cmd`): default to the sibling `bin/eden` wrapper (walk up from `edenfsctl.real/` to the prefix), because the daemon runs `<edenfsctl> redirect fixup` on every mount.
3. **SCM binary default** (`eden/fs/cli/util.py`, `hg_util.py`): `EDEN_HG_BINARY` default becomes the sibling `libexec/sl`, not `hg`.
4. **Dot dir default** (`eden/fs/cli/config.py EdenCheckout.hg_dot_path`, `hg_util.setup_hg_dir`): a checkout that does not exist yet takes its dot directory from the backing repo (`.sl`), instead of sniffing the empty destination and defaulting to `.hg`. This is what forced `SL_REPO_IDENTITY=sl` in the wrapper.
5. **`sl` built-in config** (`eden/scm/lib/config/loader/src/builtin_static/core.rs`, or the `sl_oss` static config): `edenfs.command` and `edenfs.legacy_command` default to the sibling `eden` when `sl` was built with the `eden` feature; `worktree.enabled = true` by default. Without these `sl worktree add` aborts with "edenfs.legacy_command config is not set".
6. **lmdb from Homebrew** (`build/fbcode_builder/manifests/lmdb`): add a `[homebrew] lmdb` entry so the daemon links `/opt/homebrew/opt/lmdb/lib/liblmdb.dylib` instead of a bare `liblmdb.so` that only `DYLD_LIBRARY_PATH` can satisfy.
7. **Strip and sign**: `edenfs` is 167 MB with debug info; `--strip` in the assembly step brings it to tens of MB. Ad-hoc `codesign -s -` every binary after any `install_name_tool` change (arm64 kills unsigned binaries).
8. **Local assembly script** (`eden/scm/packaging/mac/assemble_eden_prefix.sh`): copies from a getdeps scratch into the layout above, writes the two wrappers, strips, signs. Used both by the workflow and for local verification.

Exit criterion: from a clean shell, `PREFIX/bin/eden start`, `PREFIX/bin/eden clone <backing> <mount>`, `cd <mount> && PREFIX/bin/sl worktree add ../wt` all work with no config files beyond `~/.edenrc` being optional.

## Phase 2 — build it in GitHub Actions

New workflow `.github/workflows/sapling-eden-macos-arm64-release.yml`, same triggers as the existing release workflow (tag push `v*`, manual dispatch with version and force inputs, skip-if-published check).

1. **Toolchain step**: `brew install` the same packages the local machine has (boost, cmake, ninja, glog, gflags, googletest, libevent, libsodium, lmdb, lz4, openssl@3, python@3.12, re2, snappy, xxhash, xz, zstd, cpptoml, libgit2, icu4c, cython, sccache), rustup, and pin cmake via the existing mise/`--extra-cmake-defines CMAKE_POLICY_VERSION_MINIMUM=3.5` trick.
2. **Cache**: `actions/cache` on `<scratch>/installed` and `<scratch>/downloads`, keyed on a hash of `build/fbcode_builder/manifests/**` and `build/fbcode_builder/patches/**`, plus the runner OS image. getdeps skips any project whose `.built-by-getdeps` marker matches, so a warm cache turns a multi-hour build into "build eden + sapling only". Also cache `~/Library/Caches/Mozilla.sccache` for the C++ objects behind the marker.
3. **Build steps**, each the getdeps invocation from `mise.local.toml` with `--num-jobs` set to the runner's core count: `build eden`, `build sapling` (with `--src-dir=.`), `build fbthrift-python` (wheel), then the runtime install script `build/fbcode_builder/darwin-thrift-python-runtime.sh` targeting a private site-packages under the prefix rather than the system python.
4. **Assemble + package**: `assemble_eden_prefix.sh` into `stage/sapling-eden/<version>/`, then `tar czf sapling-eden-<version>-arm64_<macos_codename>.tar.gz`, `shasum -a 256`.
5. **Publish**: `gh release create v<version>` (or upload to the existing release) with the tarball; `prepare_formula.py`-style templating writes `Formula/sapling-eden.rb` into the tap with the URL and sha256; commit and push with `TAP_GITHUB_TOKEN`.
6. **Budget**: first run cold is the risk; expect 2 to 4 hours on the 3-core arm64 runner and stay under the 6-hour job limit by disabling tests everywhere (`--no-tests`, `BUILD_TESTS=OFF`) as locally. If the cold build does not fit, split "warm the cache" (deps only, `getdeps build fbthrift` etc.) into a separate workflow that runs first.

## Phase 3 — the formula

`Formula/sapling-eden.rb` in `lucasingels/homebrew-tap` (templated from a new `eden/scm/packaging/mac/brew_formula_eden.rb`):

- `url`/`sha256` of the tarball, `version`, `conflicts_with "sapling"` (both install `bin/sl`).
- `depends_on` the runtime kegs from Phase 2 step 1 (build tools excluded). Implemented 2026-09-03 as `boost fmt gflags glog icu4c@78 libevent libsodium lmdb lz4 openssl@3 python@3.10 python@3.12 re2 snappy xxhash xz zlib zstd`, read off `otool -L` on the actual shipped binaries (edenfs, edenfs_privhelper, sl, and the thrift-python/folly-python extensions) rather than assumed from the toolchain list — notably both python@3.10 (the pinned thrift-python runtime) *and* python@3.12 (sl's own interpreter pick) are needed until decision #4 is actually done. No `depends_on "node"`/ISL yet: `assemble_eden_prefix.sh` doesn't assemble `isl-dist.tar.xz`, so `sl web` doesn't work from this formula for now -- follow-up, not done.
- `install`: `libexec.install Dir["libexec/*"]`-style copy of the prebuilt tree (not `Dir["*"]` -- the tarball's root also has its own standalone-use `bin/`, which install deliberately ignores), then write `bin/sl` and `bin/eden` wrappers with `opt_libexec` paths so they survive upgrades.
- `caveats`: the setuid command, the note that it is needed after each upgrade, and the daemon lifecycle (`eden start` is not a login item; `brew services` is deliberately not offered because the daemon must not run as root).
- `test do`: `sl --version`, `eden --version`, and `sl worktree --help`.
- `post_install` is not used for the setuid step: Homebrew runs it as the user.

## Phase 4 — validate, document, roll out

1. Fresh-machine test: a second Mac, or a clean user account on this one, `brew install lucasingels/tap/sapling-eden`, follow the caveats, `eden clone` a `sl clone --git` of core, `sl worktree add`, `sl web` in the mount, `brew upgrade` and confirm the setuid step is the only manual repeat.
2. README and `docs/`: install section for the eden variant, the two-directory model (backing repo vs mounts), worktree usage, and troubleshooting (`eden status`, `eden doctor`, logs in `~/local/.eden/logs/edenfs.log`).
3. VS Code extension: confirm ISL's worktree panel appears for an eden checkout with the extension's `sl` pointed at the new binary.
4. Retire the machine-local wiring on this Mac (`~/bin/edenfsctl`, mise tasks stay for development).

## Risks and mitigations

- **Cold build time on the runner.** Mitigate with the two-level cache and the optional cache-warming workflow; keep `--no-tests`.
- **Homebrew runner image drift** (macOS codename, Xcode, SDK). The NFS mount code hardcodes an XDR args version that could change with a macOS release; pin `runs-on` to a specific macOS version and note it in the release name.
- **thrift-python wheel fragility.** Now patch files with a header explaining every hunk; still the most likely thing to break on a new fbthrift rev. Keep `manifests/fbthrift` and `fbthrift-python` pinned to the same rev as `Cargo.lock`.
- **Daemon started as root.** If a user ignores the caveat, `eden start` runs everything under sudo and the state dir becomes root-owned. Make the caveat loud and have `eden doctor` explain the fix; consider refusing to start under sudo unless `--allow-root` is passed.
- **Two formulas conflicting.** `conflicts_with` handles installs; document `brew unlink sapling && brew install sapling-eden`.

## Effort

Phase 1 about a day of focused work plus local testing, Phase 2 one to two days dominated by CI iteration, Phase 3 half a day, Phase 4 half a day plus a soak period. Sequential dependencies: 1 before 2 (the assembly script is shared), 2 before 3 (the formula needs a real tarball URL).

## Open questions

- Keep the name `sapling-eden`, or make EdenFS the default `sapling` formula once stable?
- Where should the backing repo live by default when `sl clone --eden` is eventually wired for git remotes (`sl clone --eden` currently aborts with `--git`)? A `~/.local/share/sapling/backing/<name>` convention plus a fork-side clone command would make the two-directory model invisible.
- Ship `eden_apfs_mount_helper` at all, given redirections are out of scope?
