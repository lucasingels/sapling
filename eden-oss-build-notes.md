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

## The thrift-python runtime port (for edenfsctl.real)

The Python CLI needs the thrift-python runtime (`thrift.python.*` +
`folly.iobuf` C extensions), which upstream only ever built on Linux
(`builder = nop` elsewhere in the fbthrift-python/folly-python manifests).
Ported to macOS over ~34 iterations; status: **the runtime imports and works**
with the plain wheel plus one shared dylib path:

- Working proof:
  `DYLD_LIBRARY_PATH=<installed>/folly-python/lib:<build>/fbthrift-python/lib`
  `PYTHONPATH=<thrift-wheel-target>:<folly-python build lib.macosx dir>`
  → `import folly.iobuf, thrift.python.types` succeeds.
- **Do NOT use the delocated/self-contained wheel**: vendored copies of
  gflags/folly inside the wheel dual-register against the folly package's
  copies (and delocate also vendored libpython itself → segfault). One shared
  set of dylibs, no vendoring, is the only sound layout here.
- Environment (all machine-local): brew cython (CLI) + a cp310 site dir at
  scratchpad/cython310 with Cython/setuptools/pip/delocate injected via
  PYTHONPATH; `Python3_EXECUTABLE` pinned to brew python@3.10;
  `-DGLOG_USE_GLOG_EXPORT` in CMAKE_C/CXX_FLAGS; brew python@3.10's broken
  pyexpat repointed at brew expat (bottle bug: system libexpat lacks
  `XML_SetAllocTrackerActivationThreshold`, silently breaking
  `platform.mac_ver()`).
- Manifest fixes (committed-able, in our repo): fbthrift-python deps gained
  libevent-python; libevent-python builds from source on darwin (brew libevent
  has no CMake config); both wheel manifests enabled on darwin.
- Fetched-checkout patches (folly + fbthrift, all upstreamable):
  - folly: real source root BEFORE cybld staging dir (case-insensitive FS
    resolves `folly/Executor.h` to folly-python's `executor.h`).
  - fbthrift: pxd hint for `<prefix>/include`; streaming api-header OUTPUT
    paths + degenerate self-symlink mappings fixed (self-link destroyed the
    generated header → ELOOP masquerading as file-not-found); sink.pyx output
    renamed (case-collision with handwritten Sink.cpp, which is itself renamed
    SinkImpl.cpp for the build_ext pass); api step made rerun-safe; Libiberty
    optional (mac libiberty lacks the demanglers); whole-archive linking via
    `$<LINK_LIBRARY:WHOLE_ARCHIVE,...>` with rpcmetadata/thriftmetadata
    demoted to on-demand (duplicate generated symbols);
    `-undefined dynamic_lookup` + `-headerpad_max_install_names`; libpython
    suffix handling (.dylib); aio/unwind Linux-only in setup.py; auditwheel →
    delocate on darwin.
- Cython 3.2 idempotency bug patched in our vendored copy (refuses to
  overwrite its own api headers).

**DONE (2026-07-30 evening): `edenfsctl.real --version` and `--help` work.**
The wiring that finished the job:

- `add_fbthrift_python_library` calls for eden.thrift (NAMESPACE
  eden.fs.service, SERVICES EdenService), eden_config.thrift, overlay.thrift
  (NAMESPACE facebook.eden), and fb303_core.thrift (absolute path from the
  installed fb303; module extended to accept absolute thrift files and extra
  include dirs). The CLI needs exactly two thrift-python modules:
  eden.fs.service.eden and facebook.eden.overlay.
- `edenfsctl.real` switched to `add_fb_thrift_python_executable` (dir-type;
  C extensions cannot load from zipapps); the bundler now also symlinks
  thrift/py3 (async_client imports it at init).
- FBPythonBinary.cmake honors `Python3_EXECUTABLE` from the environment:
  CMP0074 is OLD here so `Python3_ROOT_DIR` env is ignored, FindPython3
  otherwise prefers the newest python (3.14) over the pinned 3.10, and
  getdeps deletes CMakeCache.txt on reconfigure so cache pinning cannot work.
- The runtime discovery probes in FBThriftPythonLibrary.cmake run `python -I`
  (getdeps puts a legacy thrift package on PYTHONPATH, and the build dir cwd
  contains a `thrift/` directory — both shadow the wheel) and derive
  site-packages from `thrift.python.__path__` (the wheel's `thrift` is a
  namespace package; `thrift.__file__` is None).
- Machine state the runtime relies on (redo after scratch wipes):
  the plain wheel pip-installed into brew python@3.10; folly's python package
  copied to `installed/folly-python/lib/python3.10/site-packages` with a
  `folly-python.pth` in brew 3.10's site-packages pointing at it; runtime
  dylibs (folly-python + fbthrift-python lib/) symlinked into
  `/opt/homebrew/lib` (dyld resolves @rpath references via python's own
  rpath; the extensions were linked without headerpad so their load commands
  cannot be rewritten). **Superseded 2026-09-02**: the extensions now carry
  rpaths into the scratch and `mise run install-eden-python-runtime` does the
  install — see the dated subsection below.

### 2026-09-02: the patches are patch files now (re-derived after the scratch purge)

The July fetched-checkout edits only existed inside `$TMPDIR` and were lost with it; they were re-derived from the prose above and now live in the repo, applied by getdeps itself:

- `build/fbcode_builder/patches/folly-python-darwin.patch` (wired via `patchfile =` in `manifests/folly-python`) and `build/fbcode_builder/patches/fbthrift-python-darwin.patch` (`manifests/fbthrift-python`). Both start with a header block that explains every hunk; `git apply` ignores the preamble. getdeps applies a patch from the checkout root once per checkout (`.getdeps_patched` sentinel), and since `folly`/`folly-python` (and `fbthrift`/`fbthrift-python`) share a checkout the patchfile hangs off the `-python` manifests. Proven: checkouts reset to clean, sentinels removed, `build/` + `installed/` for both projects deleted, `mise run build-eden-python` → `Patching folly-python with folly-python-darwin.patch ...`, `Patching fbthrift-python with fbthrift-python-darwin.patch ...`, exit 0 (the whole `-python` chain rebuilt in ~4 minutes thanks to sccache).
- Everything darwin-specific is behind `if(APPLE)` / `sys.platform == "darwin"`; the remaining hunks (interpreter pinning, include order, Sink staging rename, rerun-safety, `Extension` hashability) are no-ops or plain bug fixes on Linux, so both patches are upstream candidates as they stand.
- Also enabled on darwin: `fizz-python`, `mvfst-python`, `wangle-python` (static PIC, they end up inside `libthrift_python_cpp.dylib`). The July prose did not mention them, but they are `builder = nop` off Linux upstream and fbthrift's CMake does `find_package(mvfst CONFIG REQUIRED)`; brew has no mvfst, and brew's fizz/wangle kegs are built against brew's folly, so linking them against our shared folly-python would be an ABI gamble. Cost: ~10 minutes of extra build the first time.

What differed from the July prose, per project:

- folly (`folly/python/CMakeLists.txt`): the include-order fix (real folly root BEFORE cybld, case-insensitive `folly/Executor.h` vs `executor.h`) is the one item the notes described and it is still needed. New: setup.py is run with `${Python3_EXECUTABLE}` instead of PATH's `python3`, and on APPLE the build_ext/bdist_wheel passes get `LDFLAGS=-Wl,-headerpad_max_install_names -Wl,-rpath,<prefix>/lib` so `folly.iobuf`/`folly.executor` find `@rpath/libfolly*.dylib` without any environment. Upstream folly meanwhile grew a wheel + `pip install --prefix` install step, so `installed/folly-python/lib/python3.10/site-packages/folly` now appears by itself; the July hand copy and `folly-python.pth` are obsolete.
- fbthrift (`thrift/lib/python/CMakeLists.txt`, `thrift/lib/python/test/CMakeLists.txt`, `thrift/lib/setup.py`): pxd hint for `<prefix>/include`, Libiberty optional (APPLE: none), `Sink.cpp` staged as `SinkImpl.cpp` (and `Sink.h` as `SinkImpl.h` — `sink.pyx` has a `cdef public api` function so Cython emits `sink.h` too), `$<LINK_LIBRARY:WHOLE_ARCHIVE,...>` per archive with `rpcmetadata`/`thriftmetadata` on demand, `-undefined dynamic_lookup` + `-headerpad_max_install_names` for both the dylib and the extensions, `.dylib`-aware `--libpython` parsing (and no libpython link on darwin at all), `aio`/`unwind` Linux-only: all as described. Differences: (1) no delocate — the APPLE branch installs the PLAIN wheel from `dist/` to `share/thrift/wheels` and skips auditwheel; `test/CMakeLists.txt` (built unconditionally, even with tests off) globbed `dist_self_contained/` and is pointed at `dist/` on APPLE. (2) The "streaming api-header OUTPUT paths + self-symlink mappings" item is gone: the Jul 27 fbthrift rev already has correct paths. (3) New, twice: the wheel step copies folly's python package (with `executor.h`, `iobuf.h`, ...) into `cybld/folly`, so on the second `ninja` run `<folly/Executor.h>` resolved to `cybld/folly/executor.h` — for `thrift_python_cpp` both cybld and `FOLLY_INCLUDE_DIR` are now SYSTEM includes with folly BEFORE (the compiler searches every `-I` before any `-isystem`, and folly's dir is already `-isystem` via the imported target, so a plain `-I` could never win), and `CYTHON_INCLUDE_PATH` lists `FOLLY_INCLUDE_DIR` first while setup.py moves `"."` last on darwin. (4) `setup.py`: recent setuptools makes `Extension` unhashable; the test-extension filter used sets (TypeError on every platform). (5) The extension link `-Wl,-rpath` entries are `<prefix>/lib` and `<folly prefix>/lib`; the extensions link only `libthrift_python_cpp` directly, whose own rpaths come from fbthrift's `CMAKE_INSTALL_RPATH_USE_LINK_PATH`.

Cython: `py310-tools` had Cython 3.3.0, which crashes on `thrift/py3/converter.pyx` (`TypeError: sequence item 0: expected str instance, NoneType found` in `ExprNodes.generate_sequence_as_array_code`). Downgraded to 3.2.9 (`pip install --target py310-tools --upgrade Cython==3.2.9`, then delete the stale `cython-3.3.0.dist-info`). The "idempotency bug" is real in 3.2.9 and the code is identical in 3.3.0: for modules whose api header pulls in utility code, the file starts with `/* EnumClassDecl.proto */` instead of `/* Generated by Cython x.y.z */`, and the next run refuses to overwrite it ("The output file already exists and does not look like it was generated by Cython: python_async_processor_api.h"). Instead of patching Cython, `setup.py` now removes such stale `*_api.h` files (only regular files that lack the marker) before both the `--api-only` and the `cythonize` pass, and the `--api-only` pass finally fails loudly on Cython errors instead of leaving stale headers behind. Verified by deleting one api header and re-running the `thrift_python_types_bindings` target with the non-marker headers in place.

Runtime install, replacing the July `/opt/homebrew/lib` symlinks and `.pth`: `mise run install-eden-python-runtime` → `build/fbcode_builder/darwin-thrift-python-runtime.sh`. It pip-installs the plain wheel (which bundles `folly.iobuf`/`folly.executor` — upstream copies folly's package into the wheel now) into brew python@3.10's site-packages with `--force-reinstall`, removes the stale July `folly/` dir and `folly-python.pth`, and probes `python3.10 -I -c 'import folly.iobuf, thrift.python.types'`. Nothing else is needed: the extension modules carry `LC_RPATH` entries for `$GETDEPS_SCRATCH/installed/fbthrift-python/lib` and `.../folly-python/lib`, `libthrift_python_cpp.dylib` has the same two, and every other dependency resolves by absolute brew path. Consequence: the runtime is bound to the scratch path; move the scratch and re-run `build-eden-python` + `install-eden-python-runtime`. (The `/opt/homebrew/lib/libfolly*`/`libthrift*` symlinks found on this machine are brew's own `folly`/`fbthrift` kegs, not July leftovers; nothing dangling was left to remove.)

Verification (2026-09-02):

```
$ /opt/homebrew/opt/python@3.10/bin/python3.10 -I -c 'import folly.iobuf, thrift.python.types; print("ok")'
ok
$ mise run build-eden-python        # clean checkouts, build/ + installed/ of both projects deleted first
Patching folly-python with folly-python-darwin.patch in .../repos/github.com-facebook-folly.git
Patching fbthrift-python with fbthrift-python-darwin.patch in .../repos/github.com-facebook-fbthrift.git
exit=0
$ mise run install-eden-python-runtime
installing thrift-0.0.1-cp310-cp310-macosx_26_0_arm64.whl into /opt/homebrew/lib/python3.10/site-packages
thrift-python runtime ok: /opt/homebrew/lib/python3.10/site-packages/thrift
folly: /opt/homebrew/lib/python3.10/site-packages/folly
$ mise run build-eden                # exit 0; CMake log:
-- Found thrift-python runtime: /opt/homebrew/lib/python3.10/site-packages
-- Found folly-python runtime: /opt/homebrew/lib/python3.10/site-packages
$ $GETDEPS_SCRATCH/build/eden/eden/fs/cli/edenfsctl.real/__main__.py --version
Installed: 20260902-131848
Running:   Unknown (EdenFS does not appear to be running)
$ $GETDEPS_SCRATCH/build/eden/eden/fs/cli/edenfsctl.real/__main__.py --help
usage: edenfsctl [-h] [--config-dir CONFIG_DIR] [--etc-eden-dir ETC_EDEN_DIR]
                 [--home-dir HOME_DIR] [--version] [--debug]
                 COMMAND ...
```

Note on getdeps logs: getdeps' own `Building X...` lines are block-buffered when stdout is a file and appear at the very end of the log, after all subprocess output — the log is not out of order, python is.

## Scratch relocation (2026-09-02)

The July build lived in the getdeps default scratch, `$TMPDIR/fbcode_builder_getdeps-<munged>` (`getdeps/buildopts.py`: no `mkscratch` → `tempfile.gettempdir()`). macOS purges files under `$TMPDIR` after ~3 idle days, and by 2026-09-02 the whole scratch was gone: eden-enabled `sl`, `edenfsctl.real`, the thrift-python wheels, and the folly/fbthrift fetched-checkout patches (which only ever existed as edits inside those checkouts — see "Loose ends"). Survivors: `built-eden/` (daemon + privhelper + apfs helper + dylibs via `fixup-eden`), the sccache, and the mise tasks.

Every getdeps task now passes `--scratch-path "$GETDEPS_SCRATCH"` with `GETDEPS_SCRATCH=~/.local/share/getdeps/sapling` (set in `mise.local.toml`). Side benefits: the path has no symlinked components (`/var` → `/private/var` did), which matters because `PrivHelperImpl.cpp` refuses to start edenfs when `executablePath() != realpath(executablePath())`. Python build tooling for the wheel builds (Cython, setuptools, pip, wheel, delocate; brew python@3.10 ships without pip) lives in `$GETDEPS_SCRATCH/py310-tools` and is put on `PYTHONPATH` by `build-eden-python`.

getdeps keys git checkouts by URL (`<scratch>/repos/github.com-facebook-folly.git`), so `folly`/`folly-python` and `fbthrift`/`fbthrift-python` share one checkout and one `.getdeps_patched` sentinel. A manifest `patchfile = <name>.patch` (applied with `git apply --ignore-space-change` from `build/fbcode_builder/patches/`, `builder.py _apply_patchfile`) is the durable way to carry the darwin python patches; attach them to the `-python` manifests.

Note also: the `eden` manifest lists `sapling` only under `[dependencies.test=on]`, so with `--no-tests` the eden build does NOT produce `sl`. `mise run build-sl-eden` builds it separately into the same scratch (`make getdepsbuild` → `build.py` with getdeps features `eden sl_oss`).

## EdenFS bring-up on macOS from the OSS build (recipe, from source reading 2026-09-02)

All file references are in this repo. Nothing below was run yet.

**Binary discovery.** The Python CLI's defaults are Meta's install layout, so set: `EDENFS_SERVER_PATH=<eden-prefix>/bin/edenfs` (`eden/fs/cli/daemon_util.py` `find_daemon_binary`, else tries `../libexec/eden/edenfs`, buck-out paths, `../edenfs`), `EDENFS_PRIVHELPER_PATH=<eden-prefix>/bin/edenfs_privhelper` (`daemon.py` hardcodes `/usr/local/libexec/eden/edenfs_privhelper` and always passes `--privhelper_path`, bypassing the daemon's sane sibling lookup), `EDENFS_CLI_PATH=<wrapper>` (the daemon runs `<edenfsctl> redirect fixup --mount <p>` on every mount, `EdenMount.cpp`; failure is non-fatal but noisy; default is a sibling `edenfsctl` next to `edenfsctl.real`), and `EDEN_HG_BINARY=<sapling-prefix>/bin/sl` (the CLI resolves clone revisions and runs `hg debugedenrunpostupdatehook`; the daemon itself never shells out to sl). `EDEN*` env vars pass through the daemon env whitelist; `DYLD_LIBRARY_PATH` does not (use `fixup-dyn-deps` or `eden start --preserved-vars DYLD_LIBRARY_PATH`). The daemon replaces PATH with `/opt/facebook/hg/bin:/usr/local/bin:/bin:/usr/bin`.

**edenfsctl.real install quirk.** `add_fb_thrift_python_executable` is `TYPE dir`; `install_fb_python_executable` installs only `__main__.py` into `<prefix>/bin`, so run the build-tree directory: `<scratch>/build/eden/eden/fs/cli/edenfsctl.real/__main__.py`. Wrap it in `~/bin/edenfsctl`.

**Privilege.** `daemon.py prepare_edenfs_privileges`: if the privhelper is root-owned with setuid, the daemon runs as the user and the privhelper self-elevates; otherwise the whole `edenfs` command is wrapped in `/usr/bin/sudo`. `PrivHelperImpl.cpp` additionally refuses symlinked edenfs/privhelper paths and non-root-owned privhelpers unless owned by the same uid as edenfs. Recipe: `sudo chown root:wheel edenfs_privhelper && sudo chmod 4755 edenfs_privhelper` on a non-`nosuid` filesystem. `eden start --foreground` gives the best error messages.

**Mount protocol.** NFS: `eden clone --nfs` defaults to true on Apple Silicon (`main.py is_apple_silicon`), `experimental:enable-nfs-server` defaults to true on Apple (`EdenConfig.h`). The privhelper calls `mount("nfs", ...)` directly with hardcoded XDR args (`PrivHelperServer.cpp`, `args_version = 88`, may drift with macOS releases); no rpcbind/mountd needed by default. FUSE would need real macFUSE (`/Library/Filesystems/macfuse.fs/.../mount_macfuse`); the getdeps `osxfuse` manifest is headers-only. `eden_apfs_mount_helper` is only for APFS bind redirections (must be setuid at `/usr/local/libexec/eden/eden_apfs_mount_helper`, `redirect.py`); dmg/symlink redirections need Meta's `mkscratch`. Simplest: no redirections; set `[redirections] darwin-redirection-type = "symlink"`.

**Config.** CLI: `~/.edenrc`, `/etc/eden/edenfs.rc`, `/etc/eden/config.d/*.toml` (daemon does NOT read `config.d`). State dir: CLI default `~/local/.eden` (passed as `--edenDir`, wins over the daemon's `~/.eden`). No `hg.binary`-style key exists. Sapling side (`~/Library/Preferences/sapling/sapling.conf`): `[edenfs] command = <edenfsctl>` and `legacy_command = <edenfsctl>` — no defaults, `edenfs_client::build_eden_command_type` aborts without them; `eden_clone` uses `legacy_command`, `eden remove` uses `command` (with `EDENFSCTL_ONLY_RUST=1`, ignored by the Python CLI).

**Cloning.** `sl clone --eden` aborts with `--git` (`cmdclone/src/lib.rs`) and only handles mononoke/eager URLs, so: (1) `sl clone --git <url> <backing>` → native `.sl` repo with `.sl/store` (required: `util.get_hg_repo` sniffs `.hg`/`.sl` + `store`; a dotgit repo is classified `git` → `GitBackingStore` → "support for Git was not enabled"); (2) `eden clone --nfs <backing> <mount>` (auto-starts the daemon; `.sl/requires` of the mount gains `eden`); (3) inside the mount, `sl worktree add <dest>` — `cmdworktree` aborts unless requirements contain `eden`, then calls `clone::eden_clone` = `<legacy_command> clone <backing> <dest> [-r hex | --allow-empty-repo]`.

**Ordered sequence**
```sh
EDEN_INST=$GETDEPS_SCRATCH/installed/eden; SL_INST=$GETDEPS_SCRATCH/installed/sapling
EDEN_BUILD=$GETDEPS_SCRATCH/build/eden
sudo chown root:wheel $EDEN_INST/bin/edenfs_privhelper && sudo chmod 4755 $EDEN_INST/bin/edenfs_privhelper
printf '#!/bin/sh\nexec %s/eden/fs/cli/edenfsctl.real/__main__.py "$@"\n' "$EDEN_BUILD" > ~/bin/edenfsctl && chmod +x ~/bin/edenfsctl
export EDENFS_SERVER_PATH=$EDEN_INST/bin/edenfs EDENFS_PRIVHELPER_PATH=$EDEN_INST/bin/edenfs_privhelper \
       EDENFS_CLI_PATH=~/bin/edenfsctl EDEN_HG_BINARY=$SL_INST/bin/sl
# ~/.edenrc: [redirections] darwin-redirection-type = "symlink"   (NFS is the macOS default since upstream 3448caede55; no [clone] default-mount-protocol needed)
# sapling.conf: [edenfs] command = ~/bin/edenfsctl ; legacy_command = ~/bin/edenfsctl
edenfsctl start --foreground   # first run; then: edenfsctl start && edenfsctl doctor
$SL_INST/bin/sl clone --git <url> ~/repos/<name>-backing && ls -d ~/repos/<name>-backing/.sl/store
edenfsctl clone --nfs ~/repos/<name>-backing ~/work/<name> && grep eden ~/work/<name>/.sl/requires
cd ~/work/<name> && $SL_INST/bin/sl worktree add ~/work/<name>-wt2
```

**Unverified:** whether `hg debugedenrunpostupdatehook` exists in the OSS `sl`; NFS XDR `args_version` vs. current macOS; whether the daemon accepts `~/.local/share/...` for the privhelper setuid bit (`nosuid` check: `mount | grep " on / "`); overlay type `legacy` behaviour at scale (`lmdb`/`sqlite` are alternatives).

## The 5-7 s Thrift reply latency (2026-09-02): fbthrift reply queue vs. libevent

First real daemon run on macOS. `eden start` worked (privhelper setuid root, NFS default) but `eden status` said "Thrift server does not appear to be running" because the CLI's 3 s health check timed out: **every** Thrift request took 5-7.5 s, over Rocket, Header, and the legacy py client alike, while `eden=DBG9` logging showed the handler starting 8 ms after the request and finishing in 1.6 ms. Pipelining a second request on the same connection flushed the first reply instantly, so replies were parked on the IO thread waiting for *any* wakeup.

Cause (reproduced with folly alone, `<scratch>/futex-test/latency5..8.cpp`): fbthrift's per-IO-thread reply queue (`IOWorkerContext::init`) is an `EventBaseAtomicNotificationQueue` started with `startConsumingInternal`, i.e. its pipe is an `EVLIST_INTERNAL` libevent event. Stock libevent (2.1.12/2.1.13 and master) only ends an `EVLOOP_ONCE` iteration after a *non-internal* callback ran (`event_process_active_single_queue` skips internal callbacks when counting), so after the pipe fires libevent runs the callback and goes straight back to `kevent()`; `folly::EventBase::loopMain` never regains control, `runLoopCallbacks()` never runs, the queue is never re-armed (`runLoopCallback` → `arm()`), producers then get `push() == false` and stop writing the pipe, and the reply waits for an unrelated event on that IO thread (here a ~5 s jittered timer). folly's own queue is immune because `applyLoopKeepAlive` re-registers it as a normal event under `loopForever`; on busy servers the next incoming request masks it, which is why nobody notices upstream. Not fork-, nice-, resource-pool- or Rocket-related (all bisected out).

Fix: `build/fbcode_builder/patches/fbthrift-darwin.patch` section (A) changes `IOWorkerContext::init` to `startConsuming(&evb)`. The patch also carries the thrift-python darwin build fixes (B) and is referenced from **both** `manifests/fbthrift` and `manifests/fbthrift-python`, because they share one checkout and one `.getdeps_patched` sentinel (only one patchfile can ever apply per checkout, so it has to be the same file on both). Upstreamable as a folly fix too (make `EventBaseAtomicNotificationQueue::execute` re-arm immediately) or a libevent fix; the fbthrift one-liner is the smallest.

Also learned on the way: `edenfs_privhelper` runs setuid and dyld refuses `@executable_path`/`@loader_path` in setuid binaries ("security policy does not allow @ path expansion"), so `fixup-eden` now writes absolute paths into `built-eden/lib` for every bundled dylib and keeps an existing root-owned privhelper across refreshes; the CLI's `check_health` swallows `TransportError` into the lockfile fallback, which is why the symptom looked like "thrift not running".

## First working `sl worktree` on macOS (2026-09-02, evening)

After the reply-latency fix, `eden clone ~/code/core-backing ~/code/core-eden` still failed twice before working:

1. **"Manifest node could not be found for commitId"** — the daemon's embedded Sapling backing store could not read the git-backed backing repo. `eden/scm/lib/backingstore/Cargo.toml` depended on `sapling-constructors` with `default-features = false`, and the constructors crate's default `git` feature is what registers the git commit-graph (`sapling-commits-git`) and git object store (`sapling-gitstore`) constructors; `lib/commands` (the `sl` binary) enables it explicitly, the backing store did not, so `factory::call_constructor` fell back to the hg store. Fixed by adding `features = ["git"]`. The vendored libgit2 this pulls in needs `-liconv` on macOS (`git_fs_path_iconv` undefined at link), added in `eden/scm/lib/backingstore/CMakeLists.txt` under `if(APPLE)`.
2. **`sl debugedenrunpostupdatehook` → "repository not found"** — the mount worked (NFS, `Nfsd3`), but the CLI created a `.hg` dot dir: `EdenCheckout.hg_dot_path` sniffs the (not yet existing) checkout path and defaults to `.hg`, while our `sl` is built with `sl_oss` and only knows `.sl`. `hg_util.sniff_dot_dir` honours `SL_REPO_IDENTITY`/`HGIDENTITY`, so `~/bin/edenfsctl` exports both as `sl`. (A CLI-side fix — default a new checkout's dot dir to the backing repo's — would be the upstreamable version.)

Then: `sl worktree add ~/code/core-eden-wt1 --label agent-test` (needs `[worktree] enabled = true`, set in `~/Library/Preferences/sapling/sapling.conf`) created a linked worktree in ~1 s; `sl worktree list` shows main + linked, `eden list` shows both mounts, `sl status`/`sl log` work in both. `[nfs] allow-apple-double = false` in `~/.edenrc` hides the `._*` files macOS writes over NFS (they showed up as untracked).

Runtime layout that is now live: daemon + privhelper from `built-eden/` (privhelper root-owned setuid, absolute dylib paths), CLI = `~/bin/edenfsctl` (wrapper around `<scratch>/build/eden/eden/fs/cli/edenfsctl.real/__main__.py` pinning `EDENFS_SERVER_PATH`, `EDENFS_PRIVHELPER_PATH`, `EDENFS_CLI_PATH`, `EDEN_HG_BINARY`, `SL_REPO_IDENTITY`, `HGIDENTITY`), eden-enabled `sl` at `<scratch>/installed/sapling/bin/sl`, backing repo `~/code/core-backing` (native `.sl`, default path = Gerrit), state in `~/local/.eden`.

## Loose ends

- Commit the 2026-09-02 changes (fbthrift-darwin.patch + manifests, backingstore git feature + iconv, thrift-python wheel patches/runtime script, notes). Upstream candidates: the fbthrift reply-queue fix (or a folly `EventBaseAtomicNotificationQueue::execute` re-arm), the backingstore `git` feature + iconv, a CLI fix so a new checkout's dot dir follows the backing repo.
- The Homebrew `sl` (0.3.3) has no `eden` feature and therefore no `sl worktree`; ISL's `WorktreeSection` gates on `isEdenFs`. Decide whether the fork's release should ship the eden-enabled `sl` (and how to distribute edenfs + privhelper, which needs root at install time).
- `mise run fixup-eden` re-creates `built-eden/`; it now preserves a root-owned privhelper, but a *changed* privhelper still needs `sudo chown root:wheel && chmod 4755` once. A stray root-owned copy sits at `/tmp/edenfs_privhelper.keep` (sudo rm).
- py310-tools (Cython 3.2.9 pin, pip, setuptools, wheel) and the thrift wheel rpaths are bound to `$GETDEPS_SCRATCH`; re-run `build-eden-python` + `install-eden-python-runtime` after moving the scratch.
- `sapling` is only a `test=on` dependency of the `eden` manifest; `mise run build-sl-eden` builds the eden-enabled `sl` separately.
- Consider enabling `edenfs_linux.yml` (and a macOS variant) on push/cron on the fork so the CMake path stops rotting silently; mirror Cargo.lock rev pins in the getdeps manifests.
- `eden start` inherits the launching shell's nice level; started from an automation shell the daemon ran at nice 5-10 and its `setpriority` calls fail (harmless warnings).
