# EdenFS OSS build on macOS — change log and rationale

Working notes for getting `getdeps build eden` to work on this fork (macOS
arm64, Homebrew, `--allow-system-packages`). State as of 2026-07-30: build 11
in progress; everything through `sl --features eden sl_oss`, edencommon, and
most of EdenFS's C++ compiles.

## Background

fbsource builds EdenFS with Buck2; the OSS getdeps/CMake path has
`workflow_dispatch`-only CI upstream, so nothing exercises it and breakage
accumulates silently. The Buck side cannot be used outside Meta: no
`.buckconfig`/prelude in the export, `fbcode_macros` was never open-sourced,
and the dependency universe (`//folly/...`, `fbsource//third-party/...`)
exists only inside fbsource. The repo *is* an fbsource slice (it carries
`thrift/`, `fb303/`, `watchman/`, `common/` at monorepo paths), but only the
thin parts the cargo build consumes — the C++ universe is what getdeps fetches.

Base commit: `6908186d548` "eden: fix the OSS getdeps/CMake build" (branch
`eden-oss-build-fixes` created this session so it can't be orphaned). It fixed
six earlier breakages: the osxfuse→macfuse manifest rename, the
`eden/fs/store/hg`→`sl` directory rename, two source-less static libs made
INTERFACE, the wezterm-dynamic `[patch]` restoration, and gating
`eden/integration` behind `BUILD_TESTS`.

## The working invocation

```sh
mise exec -- env -u PYTHON -u PYTHON3 -u PYTHON_SYS_EXECUTABLE \
  SCCACHE_CACHE_SIZE=40G RUSTC_BOOTSTRAP=1 \
  ./build.sh --allow-system-packages --no-tests \
    --src-dir=. --src-dir=sapling:. \
    --extra-cmake-defines '{"CMAKE_POLICY_VERSION_MINIMUM": "3.5", "BUILD_TESTS": "OFF"}'
```

Why each piece:

- **`mise exec`** — the mise-managed rust toolchain (cargo) is only on PATH in
  interactive shells; getdeps' cargo builds fail with "No such file: cargo"
  without it.
- **`env -u PYTHON*`** — `mise.local.toml` exports `PYTHON`, `PYTHON3`,
  `PYTHON_SYS_EXECUTABLE` pointing at mise's 3.11; `eden/scm/build.py` and the
  python-binding crates read those from the environment and would link a
  different python than the build's own (brew `python@3.10`, per the getdeps
  manifest). Scrubbing keeps the build self-consistent.
- **`RUSTC_BOOTSTRAP=1`** — `lib/backingstore`/`lib/slex` pull smallvec's
  nightly-only `specialization` feature. getdeps sets this for cargo-builder
  manifests (rust-shed) but the sapling manifest uses the make builder, whose
  path (`Makefile` → `build.py` → cargo) never sets it. The brew formula plugs
  the same gap in its install block.
- **`--allow-system-packages`** — use brew for leaf deps (boost, openssl,
  libevent, re2, cpptoml, python@3.10, …) instead of building them. folly,
  fbthrift, fb303, edencommon, watchman have no `[homebrew]` manifest section
  and always build from pinned source in lockstep — deliberately, that's what
  prevents version skew. Install the packages first with
  `getdeps.py install-system-deps --allow-system-packages --recursive eden`.
- **`--no-tests`** — prunes test-only deps from the getdeps graph (matches CI).
- **`--src-dir=. --src-dir=sapling:.`** — critical and easy to miss: a bare
  `--src-dir=.` only applies to the *named* project (eden; also auto-detected
  via `.projectid`). The `sapling` **dependency** is otherwise fetched fresh
  from upstream GitHub `main`, which does not contain this fork's fixes (and
  currently cannot pass its own OSS eden build). The `sapling:.` form points
  the dependency at the local tree.
- **`--extra-cmake-defines`** — `BUILD_TESTS=OFF` gates `eden/integration`
  (its python unittests need folly/fbthrift python bindings that this build
  doesn't produce); `CMAKE_POLICY_VERSION_MINIMUM=3.5` because brew's CMake 4
  refuses projects declaring `cmake_minimum_required(<3.5)`, which several
  vendored deps still do.
- **sccache** — getdeps auto-detects it on PATH and sets
  `CMAKE_CXX_COMPILER_LAUNCHER` for every C++ dep (builder.py). Not a getdeps
  manifest, so `install-system-deps` can't install it; it comes from brew.
  Made the repeated full-dep rebuilds this session cheap.

## What has to be built, and where it stands

Dependency graph of the `eden` manifest in getdeps' build order. "brew" means
satisfied by `--allow-system-packages` and never compiled; everything else is
built from source into the getdeps scratch (`$TMPDIR/fbcode_builder_getdeps-*`)
and cached until its manifest/config changes.

**Satisfied from Homebrew (not built):** autoconf, automake, boost, bzip2,
cmake, cpptoml, dwarfutils (libdwarf), gflags, glog, googletest, icu4c,
libevent, libffi, libgit2, libsodium, libtool, lz4, ncurses, ninja, openssl@3,
python@3.10, python-setuptools, re2, snappy, xxhash, xz, zlib, zstd — plus
sccache (PATH-detected accelerator, not a dependency).

**Built from source by getdeps (in dependency order):**

| Project | What it is | Status |
|---|---|---|
| lmdb | key-value store (overlay catalogs) | ✅ built |
| osxfuse | FUSE headers only (`builder = nop`, no kext) | ✅ installed |
| blake3 | hash library | ✅ built |
| fmt | formatting library | ✅ built |
| benchmark | google benchmark | ✅ built |
| fast_float | float parsing | ✅ built |
| python-ptyprocess, pexpect, python-filelock, python-psutil, python-toml | python test/tooling libs | ✅ built |
| rocksdb | local store backend | ✅ built |
| liboqs | post-quantum KEMs (fizz dep) | ✅ built (after openssl fix) |
| nghttp2, libcurl | HTTP stack for the backingstore | ✅ built |
| **folly** | Meta's C++ core library | ✅ built (largest single dep) |
| fizz | TLS 1.3 | ✅ built |
| mvfst | QUIC | ✅ built |
| wangle | networking framework | ✅ built |
| **fbthrift** | thrift compiler + C++/Rust runtime | ✅ built (rev `1f7c13e5`, matches Cargo.lock pins) |
| fb303 | service framework (counters/status) | ✅ built |
| rust-shed | Meta's Rust utility crates | ✅ built |
| **sapling** | `sl` with `--features eden sl_oss` (includes `sl worktree`) | ✅ built, from the local tree |
| edencommon | shared EdenFS utilities | ✅ built |
| **eden** | EdenFS itself (daemon, CLI, privhelper) | ✅ **built and runs** (build 23, 2026-07-30): `edenfs`, `edenfs_privhelper`, `eden_apfs_mount_helper`, `edenfsctl.real` in `<scratch>/installed/eden/bin` |

Within the `eden` project the Rust pieces shook out as: `rust_backingstore`
and `rust_edenfs_ffi` build and link into the daemon via cxx bridges; the
Rust `edenfsctl` CLI and `redirect_ffi` are **gated off** (they need the
fbsource-only `thrift_thriftclients` crate) with the Python CLI
(`edenfsctl.real`) as the shipped CLI; `backtrace_ffi` compiles but cannot
be linked (second cxx staticlib per binary duplicates the cxx runtime) and
`manifold_ffi` doesn't compile — both are stubbed behind `#ifdef`s.

## Changes in the working tree (uncommitted)

### Environment alignment

- **`mise.local.toml`** — `cmake = "latest"` (4.2.3) → `"3.31.12"`, the exact
  version the getdeps cmake manifest pins. CMake 4 dropped
  `cmake_minimum_required(<3.5)` compat, which breaks older third-party CMake
  invoked outside getdeps (e.g. `-sys` crate build scripts). Python was
  audited and deliberately *not* changed: the in-tree 3.12/3.13 references are
  runtime version guards, not floors (`pick_python.py` accepts 3.10–3.12; the
  getdeps manifest pins 3.10), and the eden build uses brew's python@3.10
  regardless.

### getdeps fixes (macOS + `--allow-system-packages` path, never CI-exercised)

- **`build/fbcode_builder/getdeps/builder.py`** — the darwin block set
  `OPENSSL_ROOT_DIR` to the openssl dep's *would-be* install dir without
  checking it exists. With system packages the dir doesn't exist (brew
  satisfies openssl), and the bogus explicit `-D` overrides CMake's search
  entirely — liboqs's `find_package(OpenSSL)` failed. Now: only set it if the
  dir exists, else fall back to the env value (the brew keg).
- **`build/fbcode_builder/getdeps/buildopts.py`** — the "try extra hard to
  find openssl" fallback hardcoded `brew --prefix openssl@1.1`, a formula that
  no longer exists. Now resolves the actually-installed package (brew maps the
  `openssl` alias to `openssl@3`), keeping `openssl@1.1` as fallback.

### Rust dependency rev alignment

- **`eden/scm/Cargo.lock`** — three different fbthrift revisions collided:
  upstream's lock is *internally* skewed (runtime crate at `a3d56659`, the
  codegen-support crates `scope`/`cpp`/`thrift`/… at `17c52a0`), while the
  `thrift1` compiler getdeps builds comes from today's fbthrift `main`
  (`1f7c13e5`). New compiler emits `impl ::fbthrift::ThriftStruct`; old
  runtime lacks the trait → E0405. Fix: rewrote every `fbthrift.git` (9),
  `rust-shed.git` (13), and `fb303.git` (2) pin to exactly the revs in
  getdeps' scratch repos (`1f7c13e5` / `049c30f4` / `26f84914`), validated
  with `cargo metadata --locked`. Note: `cargo update -p X --precise` is
  unsuitable — each invocation floats *other* unpinned units to the moving
  `main` HEAD. Durability caveat: a future getdeps fetch of newer `main`
  reintroduces skew; the long-term fix is pinning revs in the getdeps
  manifests too.
- **`eden/fs/cli_rs/{edenfsctl,edenfs-client}/Cargo.toml`** — five dep lines
  (fbinit, fbinit-tokio, futures_stats, fb303_core_clients) declared **both**
  `path` and `git`. cargo refuses the ambiguity outright, and the
  `common/rust/shed` paths are dangling anyway — the OSS export doesn't
  contain them (that's rust-shed's fbsource home). Dropped the `path` keys.
- **`eden/scm/lib/backingstore/{src/ffi.rs,src/ffi.cpp,include/ffi.h,Cargo.toml}`**
  — the blob-fetch cxx bridge was made `folly::IOBuf`-typed using the Rust
  `iobuf` crate (folly bindings), which lives in fbsource and is not in the
  OSS export — so the crate could no longer compile under cargo at all
  (`iobuf` unresolved, `Blob::into_iobuf` is `#[cfg(fbcode_build)]`). Fix:
  declare `folly::IOBuf` as an opaque cxx type and build the buffer on the
  C++ side via a new `sapling_iobuf_from_bytes` helper
  (`folly::IOBuf::copyBuffer`, one copy — the zero-copy path needs the
  internal bindings). Also `Repo::working_copy` is gated behind the repo
  crate's `wdir` feature, which building `-p sapling-backingstore` alone
  (resolver v2, no workspace feature unification) never enables — the
  Cargo.toml dep now requests it explicitly.

### CMake fixes (more BUCK-updated/CMake-missed rot)

- **`build/fbcode_builder/CMake/RustStaticLibrary.cmake`** — the sapling
  crates were renamed with a `sapling-` package prefix while keeping their old
  `[lib]` names (package `sapling-backingstore` still builds
  `libbackingstore.a`). `rust_static_library` used one `CRATE` name for both
  `cargo build -p` and the artifact filename, so `-p backingstore` matched
  nothing. Added a `PACKAGE` argument for the `-p` name, separate from the
  artifact name.
- **`eden/scm/lib/backingstore/CMakeLists.txt`,
  `eden/scm/lib/edenfs_ffi/CMakeLists.txt`** — pass
  `PACKAGE sapling-backingstore` / `PACKAGE sapling-edenfs_ffi`.
- **`CMake/EdenConfigChecks.cmake`** — three additions:
  1. *abseil for re2* (25 compile failures): brew's keg-only re2 headers
     include absl headers; nothing put abseil's include dir on the compile
     line (Linux hides this — everything's in `/usr/include`). Scoped strictly
     to the abseil keg (`/opt/homebrew/opt/abseil/include`, `NO_DEFAULT_PATH`):
     the general `/opt/homebrew/include` also holds a **stale brew folly/glog**
     (watchman deps) that would shadow the getdeps-built folly, because `-I`
     dirs are searched before `-isystem` dirs. (Build 10 failed exactly that
     way before the scoping.)
  2. *cpptoml include surfaced globally*: a couple of test targets include
     `eden/fs/config` headers (→ `cpptoml.h`) without linking the cpptoml
     target.
  3. *BUCK header-map mirror*: BUCK exports
     `include/SaplingBackingStoreError.h` as
     `eden/scm/lib/backingstore/SaplingBackingStoreError.h` via its headers
     map; `eden/fs/utils/EdenError.h` includes it by that name. CMake now
     copies it into a `buck-hdrs/` dir in the build tree with the BUCK layout.
- **`eden/fs/utils/CMakeLists.txt`** — `eden_utils` now links `backingstore`:
  the mirrored header needs the cxxbridge-generated `rust/cxx.h`, which that
  target generates and PUBLIC-exports. Mirrors the BUCK dependency edge; no
  cycle (backingstore doesn't depend on eden_utils).
- **`eden/fs/telemetry/CMakeLists.txt`** — excluded `StackTraceUploader.cpp`
  and `ThrowTraceCapture.cpp` from the source glob. They need cxxbridge
  headers from `eden/fs/rust/{manifold,backtrace}_ffi`, which are BUCK-only
  targets — and Manifold (Meta's blob store) is fb-internal anyway. Nothing
  outside telemetry references their symbols.

### CMake fixes, round two (final-link era, builds 13–22)

- **`CMake/EdenConfigChecks.cmake`** (amended) — the `buck-hdrs` mirror of
  `SaplingBackingStoreError.h` is a *forwarding shim* (`#pragma once` +
  include of the real header), not a copy: `#pragma once` dedupes by file
  identity, and TUs including both paths saw a redefinition. The abseil
  include is scoped to the abseil keg with `NO_DEFAULT_PATH` — the general
  `/opt/homebrew/include` also holds a stale brew folly/glog (watchman deps)
  that would shadow the getdeps folly, since `-I` beats `-isystem`.
- **`eden/fs/service/EdenServer.cpp`** — one-line fix: include
  `PrettyPrinters.h`, which defines `fmt::formatter<MountState>`; BUCK
  supplies it via a dep's exported headers, CMake doesn't.
- **`eden/fs/privhelper/CMakeLists.txt`** — the new `priority/` subdirectory
  (ProcessPriority, per-platform memory priority) was BUCK-only; added to the
  glob (sources self-guard with `#ifdef __linux__`/`__APPLE__`).
- **`eden/fs/inodes/fscatalog_dev/CMakeLists.txt`** (new) — `Overlay` now
  instantiates `FsInodeCatalogDev`/`FsFileContentStoreDev` from a directory
  CMake had never heard of; mirrors the `fscatalog` sibling, linked into
  `eden_inodes`.
- **`eden/scm/lib/edenfs_ffi/CMakeLists.txt`** — link
  `-framework SystemConfiguration` (PUBLIC): the crate bundles `whoami`
  (SCDynamicStoreCopyComputerName) and vendored curl
  (SCDynamicStoreCopyProxies); mirrors the existing Windows Crypt32/Secur32
  block and backingstore's `-framework Security`.
- **All 14 `eden/fs/*/test` subdirectories gated behind `BUILD_TESTS`** —
  extends the base commit's `eden/integration` gating; the unit tests carried
  years of link-list debt (missing eden_config/telemetry/store deps) and are
  pruned in this build anyway.

### The Rust-crate endgame

- **`thrift_thriftclients` does not exist outside fbsource** (autocargo-made
  Rust thrift client for eden.thrift). It poisons everything that depends on
  `edenfs-client`: the Rust `edenfsctl` CLI and `redirect_ffi`. New CMake
  option `EDEN_HAVE_RUST_THRIFT_CLIENTS` (default OFF) gates both;
  `listRedirections` in `EdenServiceHandler.cpp` is `#ifdef`d to return
  `ENOTSUP` without it. The Python CLI (`edenfsctl.real`) installs regardless
  and has its own redirect implementation.
- **`eden/fs/cli_rs/edenfs-commands/Cargo.toml`** — declared
  `termwiz = "0.23"` against a pinned wezterm rev that ships 0.24.0; any
  fresh resolution fails (the Jul 28 Cargo.lock had papered over it). Bumped
  to `"0.24"`.
- **`redirect_ffi` wiring exists but is gated** — CMakeLists +
  `[lib] crate-type = ["lib", "staticlib"]` + `PACKAGE redirect-ffi`, ready
  if the thrift clients ever materialize.
- **One binary, one cxx staticlib.** Every cxx-based Rust staticlib embeds
  the cxx runtime (`_cxxbridge1$rust_vec$…`); `libedenfs_ffi.a` already
  provides those 150 symbols to `edenfs`, so a second cxx archive
  (backtrace_ffi) cannot be linked — BUCK avoids this by linking all Rust as
  one unit. Hence:
  - **`ThrowTraceCapture.cpp`** — `getThrowSiteStackTrace()` returns
    `std::nullopt` unless `EDEN_HAVE_BACKTRACE_FFI` (crate compiles fine;
    wiring kept in-tree for a future dedup solution).
  - **`StackTraceUploader.cpp`** — `uploadToManifold` is a logged no-op
    unless `EDEN_HAVE_MANIFOLD_FFI` (`manifold_ffi` doesn't compile OSS, and
    Manifold is Meta-internal anyway).
- **`eden/scm/lib/{edenfs_ffi,backingstore}/Cargo.toml`** — direct dep
  `blake3 = { version = "1.8.2", features = ["pure"] }` purely for feature
  unification: each crate's vendored C objects otherwise duplicate
  `libblake3.a`'s `_blake3_compress_in_place_portable` in the `edenfs` link
  (they surfaced one at a time, builds 21–22).

## Build-failure timeline (for the archaeology)

| Run | Failure | Root cause | Fix |
|---|---|---|---|
| 1 | liboqs: OpenSSL not found | bogus `OPENSSL_ROOT_DIR` (getdeps bug) | builder.py/buildopts.py |
| 2 | rust-shed: `cargo` missing | mise not active in background shell | `mise exec` wrapper |
| 3–4 | sapling dep: wezterm-dynamic `std` | dep fetched from upstream GitHub, not local tree | `--src-dir=sapling:.` |
| 5 | `#![feature]` on stable | make-builder path lacks `RUSTC_BOOTSTRAP` | env var |
| 6 | E0405 `ThriftStruct` | three-way fbthrift rev skew | Cargo.lock alignment |
| 7 | eden configure: `.py_lib` targets | tests not gated | `--no-tests` (insufficient) |
| 8 | same | gate is `BUILD_TESTS=OFF`, documented in the base commit | `--extra-cmake-defines` |
| 9 | 35 compile/cargo failures | absl/cpptoml headers, BUCK header map, crate renames, git+path deps | CMake + Cargo.toml fixes |
| 10 | `rust/cxx.h`; brew folly shadowing | broad `-I/opt/homebrew/include` | keg-scoped absl, link backingstore |
| 11 | 2 failures: backingstore (iobuf/wdir), edenfsctl (fb303 git+path) | BUCK-only iobuf crate; feature gating; dual dep spec | ffi.rs/ffi.h/ffi.cpp OSS iobuf helper, `wdir` feature, drop `path` key |
| 12 | redefinition of SaplingBackingStoreError | buck-hdrs mirror was a copy; `#pragma once` dedupes by file identity | forwarding shim via `file(GENERATE)` |
| 13 | EdenServiceHandler: redirect_ffi headers missing | BUCK-only crate consumed by core service code | wire redirect_ffi into CMake (later gated) |
| 14 | configure: termwiz ^0.23 vs 0.24.0 at pinned rev | stale version field; old Cargo.lock had masked it | bump to `"0.24"` |
| 15 | 5 link failures: `_SCDynamicStore*` | whoami + vendored curl in libedenfs_ffi.a | `-framework SystemConfiguration` |
| 16 | 11 link failures: ProcessPriority | new `privhelper/priority/` dir not in glob | extend glob |
| 17 | 8 test links + redirect_ffi/edenfsctl cargo | test link-list debt; `thrift_thriftclients` is fbsource-only | gate tests behind BUILD_TESTS; gate Rust CLI/redirect_ffi, `ENOTSUP` for listRedirections |
| 18 | EdenServer.cpp: no fmt formatter for MountState | PrettyPrinters.h include missing (BUCK injects it) | add include |
| 19 | edenfs link: ThrowTrace/StackTraceUploader/FsInodeCatalogDev | telemetry exclusions too aggressive; fscatalog_dev BUCK-only | restore + stub telemetry; wire fscatalog_dev |
| 20 | 150 duplicate `_cxxbridge1$…` symbols | two cxx staticlibs per binary embed the cxx runtime | stub backtrace capture behind `EDEN_HAVE_BACKTRACE_FFI` |
| 21 | duplicate blake3 C symbol (edenfs_ffi) | blake3 crate vendors the same C code libblake3.a provides | `blake3/pure` feature via direct dep |
| 22 | duplicate blake3 C symbol (backingstore) | same, second crate | same fix |
| 23 | **success** — exit 0, all binaries built | — | — |

Runtime note: `edenfs` links lmdb as a shared library that getdeps names
`liblmdb.so` even on macOS and loads with no path — run
`getdeps.py fixup-dyn-deps --strip --src-dir=. --src-dir=sapling:. eden <out-dir>`
(what CI does) or set `DYLD_LIBRARY_PATH` to the lmdb install's `lib/` dir.

## What the OSS build deliberately lacks

- **Rust `edenfsctl`** — the Python CLI (`edenfsctl.real`) is the CLI; the
  Rust wrapper needs `thrift_thriftclients`.
- **`listRedirections` thrift endpoint** — returns `ENOTSUP`; the Python CLI
  implements redirects itself.
- **Throw-site stack traces and Manifold upload in error telemetry** —
  stubbed; both feed Meta-internal Scuba/Manifold pipelines that are inert in
  OSS builds regardless.
- **Blob hashing in the Rust bridges uses blake3's Rust implementation**
  instead of the C/asm one (still NEON on arm64).

## Loose ends

- All working-tree changes above are **uncommitted**; commit once the build is
  green (getdeps fixes, CMake fixes, and Cargo changes are natural upstream
  candidates — upstream `main` cannot pass its own OSS eden build today).
- Capture the invocation as a mise task (`mise run build-eden`).
- Consider enabling `edenfs_linux.yml` (and a macOS variant) on push/cron on
  the fork so the CMake path stops rotting silently.
- Cargo.lock rev pins should eventually be mirrored by rev pins in the getdeps
  manifests so a fresh fetch can't reintroduce skew.
- getdeps scratch lives under `$TMPDIR/fbcode_builder_getdeps-*` (path-keyed
  to this checkout); sccache cache is global (`~/Library/Caches/Mozilla.sccache`).
