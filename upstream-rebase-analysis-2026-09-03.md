# Upstream diff analysis, 2026-09-03 (pre-rebase)

Comparison of the fork against `facebook/sapling` `main` **without merging anything** — only `git fetch upstream main` was run; `HEAD` stayed at `e9b310b241d` and the working tree stayed clean, because the eden build in progress must not be disturbed.

- merge-base: `a4ae4e2dde2` ("smartlog: don't crash on transient Phabricator network errors", 2026-07-27)
- upstream head at time of analysis: `fb5342b8ca2` ("Bump getdeps cabal to 3.10.3.0", 2026-09-03)
- range: 940 commits, 2083 files, +77k/−28k

Every fix recorded in `eden-oss-build-notes.md` was checked individually against upstream. Reproduce with `git fetch upstream main && git diff a4ae4e2dde2..upstream/main -- <path>`.

## Fixed upstream — fork patches that can be dropped on rebase

- **`worktree.enabled` config gate removed** (`05a48716697` "worktree: remove config gate": *"This was initially added as an easy failsafe for when the feature was first introduced. It is widely used now so lets delete this config."*). Our `eden/scm/lib/commands/commands/cmdworktree/src/lib.rs` patch (which flipped the gate's default to `true` on the grounds that the command only exists under the `eden` feature) is superseded — delete the patch and take upstream's removal. Consequence: `[worktree] enabled = true` in `~/Library/Preferences/sapling/sapling.conf` becomes a no-op. Note the `eden` requirement gate itself is untouched (`lib.rs:67` still `if !repo.requirements.contains("eden")`).
- **termwiz `^0.23` vs 0.24.0** — upstream deleted the `version` field from the git dep in `eden/fs/cli_rs/edenfs-commands/Cargo.toml` entirely, which fixes the resolution failure at the source and is strictly better than our `"0.24"` bump. Take theirs.
- **`edenfsctl/Cargo.toml` dual `path` + `git` dep** — upstream dropped the dangling `path` key from `fbinit`. Only a partial fix: `eden/fs/cli_rs/edenfs-client/Cargo.toml` still declares both `path` and `git` for `fbinit`, `futures_stats`, `fb303_core_clients` and `fbinit-tokio`, so that half of our fix is still required.
- **RocksDB and Snappy dropped from EdenFS** (`85408f30ee2` "cmake: remove rocksdb build deps"). `rocksdb` is gone from `build/fbcode_builder/manifests/eden`, and the whole synthesized `snappy::snappy` target block is deleted from `CMake/EdenConfigChecks.cmake`. One fewer heavy getdeps dependency. Remaining `rocksdb` references upstream are vestigial (docs, thrift counter names, `debug.py`).

## macOS is now NFS-only — the significant architectural change

`3448caede55` "macOS: default all clones to NFS", then FUSE was removed from the mac path entirely: `88f1494bff6` (FuseChannel protocol support), `08a046124e6` (privhelper mount implementation), `af8444fdfc7` (privhelper FUSE setup requests), `66eca4078be` (unused osxfuse ABI header), `ce9194f3a6c` (legacy migration/restarter/fixture code), docs in `bdfa6251fb7`. There is no `__APPLE__` left anywhere under `eden/fs/fuse`.

Two consequences for this fork:

- `~/.edenrc` `[clone] default-mount-protocol = "NFS"` is now the upstream default and can be dropped.
- **osxfuse is vestigial and its dependency can go.** `manifests/eden` still lists `osxfuse` under `[dependencies.os=darwin]`, but its only consumer is an *optional* `find_path(OSXFUSE_INCLUDE_DIR NAMES "fuse_ioctl.h")` in the root `CMakeLists.txt`, guarded by `if (OSXFUSE_INCLUDE_DIR)`. Removing that one manifest dep line lets us delete our `build/fbcode_builder/manifests/osxfuse` patch (the sha256 + `macfuse-osxfuse-3.8.3/` dirname fix for the osxfuse→macfuse repo rename) outright.

Other macOS-relevant work that landed, all of it useful to our bring-up:

- `9242086f640` "service: disclaim TCC responsibility when daemonizing on macOS" and `773d0fa65bb` "privhelper: disclaim TCC responsibility when spawning the privhelper".
- `2cca588da2e` "spawn-ext: avoid pre_exec and fork() on macOS".
- `b4fa713091c` / `c92aaddce56` allocator: jemalloc on mac with capped arenas; `1898756384f` bumps tikv-jemallocator 0.6.1 → 0.7.0.
- `4508b0f0ec9` "pathauditor: check Apple NFD case folding".
- `9ba9b21f6b6` "server: do not crash if nfsstat is not waited"; `6b18e94e9ca` NFS GC invalidation EPERM logged once as actionable.
- NFS gained AUTH_SYS credential parsing and root/wheel access modes (`66a128bb8ce`, `65d0ce5ed9e`, `544ea10b377`, `613135f9f4e`, `7c8dd58586f`). Config-gated, but worth watching given our mount is local NFS.
- The privhelper gained a full self-restart/relaunch mechanism plus genuine deadlock fixes on connection loss (~30 commits, +3079/−719 across 14 files). Relevant because ours runs setuid root.
- `1568c1678e5` "macOS: stop building universal binaries" — Intel macOS is sunset. BUCK-only, so no effect on our CMake path, but it confirms arm64-only is the supported direction for the bottle.

## Not fixed upstream — every other fork patch still required

- **getdeps openssl, both bugs** (`builder.py` setting `OPENSSL_ROOT_DIR` to a non-existent dir without checking, and `buildopts.py` hardcoding the no-longer-existing `openssl@1.1` formula) are untouched. Upstream's only change to those two files was stripping `# pyre-fixme` comments — which sit directly on our patch hunks, so expect mechanical (not semantic) conflicts there.
- **`RustStaticLibrary.cmake` `PACKAGE` argument** for the `sapling-` crate-rename split — file unchanged upstream.
- **backingstore `iobuf`** — upstream still uses the fbsource-only `iobuf` crate (`type IOBuf = iobuf::IOBuf`, `blob.into_iobuf()`), so our opaque-cxx-type + `sapling_iobuf_from_bytes` shim is still needed. Worse, upstream *added* FFI surface on top (`e447cf34e37` hgcache stats, `a2adc0e5729` glob fetches out of walk detection): +241/−8 in `ffi.rs`, so the shim must be re-applied over moved code. This is the single largest build-side conflict.
- **`thrift_thriftclients`** is still fbsource-only and still consumed by `edenfs-client` — our `EDEN_HAVE_RUST_THRIFT_CLIENTS` gating and the `ENOTSUP` `listRedirections` stub stay.
- **`EdenServer.cpp` missing `PrettyPrinters.h`** include — still missing upstream.
- Also untouched, so all still needed: `privhelper/priority/` glob, `fscatalog_dev/CMakeLists.txt`, telemetry `StackTraceUploader`/`ThrowTraceCapture` stubs, `-framework SystemConfiguration` on `edenfs_ffi`, `blake3/pure` feature unification, `BUILD_TESTS` gating, and the backingstore nghttp2 + `iconv` link fixes.
- **Nothing at all moved on thrift-python/darwin.** `build/fbcode_builder/patches/` upstream still holds only the six original patches (no darwin ones), and `manifests/{fbthrift,fbthrift-python,folly-python,fizz-python,mvfst-python,wangle-python,libevent-python}` plus `FBPythonBinary.cmake` / `FBThriftPythonLibrary.cmake` are byte-identical to base. The entire thrift-python runtime port remains fork-only.
- **No sapling-side fix for the 5–7 s Thrift reply latency.** `fbthrift-darwin.patch` section (A) is still the only thing addressing it.

## Highest-priority follow-up: pin the getdeps revs

`eden/scm/Cargo.lock` is **gitignored** (`eden/scm/.gitignore:79`), so the three-way rev alignment we did lives only as an untracked working-tree file and is in no commit. Current state is self-consistent — the lock and the getdeps scratch checkouts match exactly:

| dep | Cargo.lock | `<scratch>/repos/` HEAD |
|---|---|---|
| fbthrift | `1f7c13e5` | `1f7c13e5` |
| rust-shed | `049c30f4` | `049c30f4` |
| fb303 | `26f84914` | `26f84914` |

But the manifests fetch `branch = main` with no `rev`, and fbthrift `main` is now roughly five weeks ahead of `1f7c13e5`. Any getdeps refetch would reintroduce the E0405 `ThriftStruct` skew *and* very likely break `fbthrift-darwin.patch`, which carries nine hunks in `thrift/lib/python/CMakeLists.txt` plus edits to `thrift/lib/setup.py` and `thrift/lib/python/test/CMakeLists.txt`.

getdeps supports an explicit revision in the `[git]` section (`build/fbcode_builder/getdeps/manifest.py:74` declares `"rev": OPTIONAL`; `:622` reads it and passes it to `GitFetcher`). Adding `rev = <sha>` to `manifests/fbthrift`, `manifests/fbthrift-python`, `manifests/rust-shed` and `manifests/fb303` is a four-line change that makes the alignment durable and the patch stable. This should happen before the next rebase or refetch.

**Update, same day — done:** landed as `4c90403936c` "eden: pin fbthrift/fbthrift-python/rust-shed/fb303 to the Cargo.lock revs", committed alongside this analysis. All four pins were verified to match both `eden/scm/Cargo.lock` and the current `<scratch>/repos/` HEADs exactly, so the alignment is now recorded in version control rather than only in the gitignored lock file.

## ISL

The worktree UI matured considerably: `e2e86c6fb72` WorktreeButton in the TopBar, `451cba80e0d` command-palette entries, `65a1396249d` sibling worktree checkouts surfaced in the commit list and smartlog, `c8636bb42cc` / `195539a05cb` focus-mode hiding, `d638ac4326e` Basecamp tiles for worktree opens.

**But the worktree UI cannot appear in an OSS build.** `useWorktreesEnabled()` in `addons/isl/src/WorktreeSection.tsx` is now:

```ts
const worktreesEnabled = useFeatureFlagSync(Internal.featureFlags?.Worktrees);
return worktreesEnabled && info?.isEdenFs === true && info?.codeReviewSystem.type !== 'github';
```

`Internal.featureFlags?.Worktrees` is `undefined` in OSS, and `featureFlagLoadable(undefined)` returns `atom(Promise.resolve(false))`, so `useFeatureFlagSync` yields `false` unconditionally. This is a *new* gate on top of the pre-existing `isEdenFs` and non-github conditions. If the fork wants the worktree UI, it has to force that flag.

Gerrit-related rebase conflict hotspots (upstream churn in files our Gerrit work touched): `Commit.tsx` (+227/−44), `isl-server/src/Repository.ts` (+69/−14), `CodeReviewInfo.ts` (+58/−6), `DiffBadge.tsx` (+47/−28), `types.ts` (+25/−5). Of note, `40f12c73aa7` "Don't let a one-diff fetch stand in for the whole smartlog" and `c8553821e07` "Only fetch a signal count for diffs that can show one" both land in `CodeReviewInfo.ts`, where the Gerrit provider lives.

## Rebase conflict surface, ranked

Files this fork modified that upstream also changed, worst first by upstream churn:

| upstream churn | file | our change |
|---|---|---|
| +506/−131 | `eden/fs/service/EdenServer.cpp` | one-line `PrettyPrinters.h` include (low risk despite the churn) |
| +313/−447 | `eden/fs/service/EdenServiceHandler.cpp` | `#ifdef` around `listRedirections` |
| +241/−8 | `eden/scm/lib/backingstore/src/ffi.rs` | OSS `IOBuf` shim — **highest real risk** |
| +227/−44 | `addons/isl/src/Commit.tsx` | Gerrit submit button |
| +176/−45 | `eden/fs/cli/daemon.py` | self-locating packaging |
| +69/−14 | `addons/isl-server/src/Repository.ts` | Gerrit provider |
| +61/−19 | `eden/fs/cli/doctor/check_filesystems.py` | packaging |
| +58/−6 | `addons/isl/src/codeReview/CodeReviewInfo.ts` | Gerrit provider |
| +47/−28 | `addons/isl/src/codeReview/DiffBadge.tsx` | Gerrit badges |
| +19/−21 | `eden/fs/cli_rs/edenfs-client/Cargo.toml` | drop `path` keys (still needed) |
| +1/−28 | `CMake/EdenConfigChecks.cmake` | abseil/cpptoml/buck-hdrs; upstream's delta is the snappy/rocksdb removal, different region |
| +0/−18, +0/−9 | `getdeps/builder.py`, `getdeps/buildopts.py` | openssl fixes; upstream delta is pyre-comment stripping on the same hunks |

## Status after the 2026-09-04 merge

Upstream `main` (`8ffaf78f65f`, 973 commits) was merged with `git merge` on branch `merge-upstream-2026-09-04`; the pre-merge fork tip is tag `backup/pre-merge-2026-09-04`. Of the 13 conflicts, every resolution followed this document (see the merge commit message). Done in the follow-up commits: the osxfuse dependency and manifest patch are gone; the ISL worktree UI is forced on for OSS via `failsafeFeatureFlagLoadable()`; the Gerrit provider imports `JSX` from `react` (React 19 types) and satisfies oxlint's `curly` rule; the draft submit button keeps the provider verb.

Verified: every fork hunk in the 24 files both sides touched is present after the merge (the IOBuf shim, `EDEN_HAVE_REDIRECT_FFI` guard, openssl fixes, Gerrit surface); no dual `path` + `git` Cargo deps remain; `tsc` for isl, isl-server, shared, components is clean; Gerrit tests pass. Not verified: the eden getdeps build itself.

Pins: fbthrift (`1f7c13e5`), rust-shed (`049c30f4`) and fb303 (`26f84914`) are ~40 days behind their mains (385/96/70 commits). `fbthrift-darwin.patch` still applies cleanly at the pin; on current fbthrift `main` only one context line drifted (`thrift/lib/setup.py`, commit `7d760f14482f`), which `git apply --3way` resolves. Nothing in upstream sapling's range needs newer revs, so the pins were left alone.
