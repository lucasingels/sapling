# Analysis: `sl worktree` on plain git worktrees in the OSS build

Status: exploration, 2026-09-04. Companion to `eden-oss-build-notes.md` and `eden-homebrew-packaging-plan.md`, which describe the EdenFS route. This document asks what it would take to get the same `sl worktree` experience (CLI + ISL panel) in the plain Homebrew `sl`, with `git worktree` as the backing mechanism instead of an EdenFS clone.

Everything below was checked against the tree at `12fb88be671` (branch `isl-oss-worktree-ui`) and against the installed Homebrew `sl` 0.3.2, using scratch repos under the job's tmp dir. File references are relative to `eden/scm/` unless they start with `addons/`.

## TL;DR

- Nothing in `sl` knows about git worktrees today. The string `commondir` does not appear anywhere in the tree. `sl` follows a `.git` *file* to `.git/worktrees/<name>` and then treats that directory as a complete git dir, so inside a worktree it silently creates an empty repo (`sl log` blank, `whereami` all zeros).
- The EdenFS coupling in `sl worktree` is shallow: one requirement check, and three subprocess calls (`eden clone`, `eden remove`, `eden redirect fixup`). The registry, locking, labels, list output and the whole ISL server side are backend-agnostic.
- The real work is in the repo/gitcompat layer, not the command: teach `sl` the git dir / common dir split that git itself has. Five files carry the change.
- ISL's server contract already works for non-EdenFS shared checkouts (verified with `sl share`). Only three client-side `isEdenFs === true` gates and the GitHub exclusion stand in the way.
- Rough size: 800 to 1500 lines of Rust plus about 50 lines of TypeScript and new `.t` tests. No daemon, no getdeps, no fbthrift, no setuid helper, no NFS. It would ship in the existing `sapling` formula.
- A side effect worth having on its own: after the repo-layer work, `sl` works inside worktrees that agents create with plain `git worktree add`, which removes the need for the `block-sl-in-git-worktree.sh` hook.

## 1. What a git worktree looks like to `sl` today

Experiment (`wt-exp3`): `git init`, two commits, run `sl log` in the repo so dotgit mode auto-initialises `.git/sl`, then `git worktree add ../wt -b agent`.

| In the main checkout | In the worktree |
|---|---|
| `sl root --dotdir` = `main/.git/sl` | `main/.git/worktrees/wt/sl` |
| `sl log -r 'all()'` shows both commits | empty |
| `sl whereami` = HEAD | `0000000000000000000000000000000000000000` |

Why, step by step:

1. `identity::sniff_dir` accepts a `.git` file starting with `gitdir: ` as a dotgit root (`lib/identity/src/lib.rs:654-661`). Fine.
2. `follow_dotgit_path` (`lib/identity/src/dotgit.rs:15-42`) follows the pointer to `main/.git/worktrees/wt` and appends `sl`. It never reads `commondir`.
3. On every repo open, `maybe_init_inside_dotgit` (`lib/gitcompat/src/init.rs:34-103`) sees no `store/requires` under that dot dir and writes a fresh `requires`, `store/requires` and `store/gitdir = ../..` there. `../..` from `worktrees/wt/sl/store` is `worktrees/wt`, which holds only `HEAD`, `index`, `commondir`, `gitdir`, `logs/`, `refs/bisect`. No objects, no `refs/heads`, no `packed-refs`, no `config`.
4. `BareGit` has a single `git_dir` field (`lib/gitcompat/src/rungit.rs:32-38`). Ref listing reads `git_dir/refs/**` and `git_dir/packed-refs` directly from disk (`lib/gitcompat/src/refs.rs:230,247,273`) and swallows NotFound, so `list_references` returns just `HEAD`. `import_from_git` then rebuilds bookmarks, remotenames and visibleheads "from scratch" from that empty set (`lib/commits/git/src/git.rs:188-346`).
5. Writes go through `git update-ref --stdin` with `--git-dir=<worktree admin dir>`, and git itself resolves `commondir`, so writes land in the right place while reads do not. libgit2 (via `git2` 0.20 / libgit2 1.9) also honours `commondir`, so the object store would resolve correctly. Only the hand-rolled ref reader is wrong.

Two smaller worktree-specific bugs surfaced while reading:

- `git_cmd_impl` pins the subprocess cwd to the repo root only when the git dir's basename is `.git` (`rungit.rs:299-307`). In a worktree the basename is the worktree name, so git falls back to the process cwd as the work tree.
- The git config mtime check reads `<git_dir>/config` (`init.rs:110-112`), which does not exist in a worktree admin dir, so config translation re-runs `git config` on every command.

## 2. `sharedpath` is not a dead end, it has two disagreeing readers

The memory note recorded that adding a `sharedpath` file to a worktree's dot dir ends in `integrity check failed on commit`. Reproduced, and now explained.

The `sharedpath` file conventionally contains the shared **dot dir** (`/repo/.sl`). Rust (`lib/repo/repo-minimal-info/src/lib.rs:94-114`) takes `.parent()` of that value, sniffs the result as a repo root, and appends the identity's dot dir. Python (`sapling/localrepo.py:488-522`) uses the value literally as the shared dot dir and puts the store at `<value>/store`.

For a dotgit main repo the shared dot dir is `main/.git/sl`. Rust cannot accept that value: `.parent()` gives `main/.git`, which does not sniff as a repo, so it aborts with "sharedpath points to nonexistent directory". The value Rust does accept is `main/.git` (parent `main` sniffs as dotgit, then `.git/sl` is appended). But Python takes that literally and creates `main/.git/store` and reads `main/.git/requires`, which does not exist. An empty store-requirements set means `isgitformat()` is false, so the changelog verifies the git commit text with Mercurial's `revlog.hash`, which can never match (`sapling/changelog2.py:473-488`). That is the integrity error. The experiment left the tell-tale `main/.git/store` and `main/.git/blackbox` directories behind.

So the fix is a small one in `read_sharedpath`: when `.parent()` does not sniff, accept the value itself if it is an existing dot dir (contains `requires`). Both sides then agree on `main/.git/sl`.

Even with that fixed, `sharedpath` alone is not enough, because of HEAD (next section).

## 3. The design constraint: HEAD is per worktree, everything else is common

Git splits per-worktree state (`HEAD`, `index`, `refs/bisect`, `refs/worktree/*`, `logs/HEAD`) from common state (`objects`, `refs/**`, `packed-refs`, `config`, `shallow`). `sl` has to make the same split. Today it can only get one side right at a time:

| | git dir = worktree admin dir (no sharedpath) | git dir = common dir (via sharedpath) |
|---|---|---|
| `HEAD`, so `.` and the dirstate parent | correct | main checkout's HEAD |
| `refs/heads`, `refs/remotes`, `packed-refs` | empty | correct |
| objects (libgit2) | correct | correct |
| `index` via `git status` etc. | correct | main checkout's index |
| `shallow`, `config` | missing | correct |

Concretely, the commit graph (`GitSegmentedCommits`) builds its `BareGit` from the store's `gitdir` file (`lib/commits/git/src/factory_impls.rs:72-79`), while the working copy builds its `RepoGit` from `<root>/.git` (`lib/workingcopy/src/workingcopy.rs:354-363`). With a shared store those two resolve different HEADs, and `DotGitFileSystem::create_treestate` force-syncs the dirstate p1 to whichever HEAD it sees (`lib/workingcopy/src/filesystem/dotgit.rs:82-105`), so the two notions of `.` fight.

## 4. What the repo layer needs

This is the substance of the project. Ordered by dependency.

1. **`BareGit` gets a `common_dir`.** `follow_dotgit_path` (or a sibling) returns the admin dir and, if `<admin>/commondir` exists, `common_dir = normalize(admin.join(read(commondir)))`, else the same dir. In `refs.rs`, `HEAD` and git's per-worktree ref namespaces read from `git_dir`; `refs/**`, `packed-refs` read from `common_dir`. `read_git_shallow` (`lib/dag/gitdag/src/gitdag.rs:89-96`) and the config mtime probe move to `common_dir`. Fix the cwd pin in `git_cmd_impl` to apply whenever a root is known. About 150 lines, all in `lib/gitcompat` plus one line in `gitdag`.

2. **`RepoMinimalInfo` becomes worktree-aware.** In the dotgit branch (`repo-minimal-info/src/lib.rs:54-73`): `dot_hg_path` stays `<admin>/sl` (per worktree: dirstate, `bookmarks.current`, wlock, journal, merge state all key off it and are already correct), and `shared_dot_hg_path` becomes `<common>/sl`, so `store_path`, metalog, segments, mutation store, the store lock and `worktrees.json` are shared. `shared_path` (what `sl root --shared` prints) is the common dir's parent, which is the main checkout. Also apply the `read_sharedpath` fix from section 2 and replace the literal `path.join(ident.dot_dir())` in the shared arm with `ident.resolve_full_dot_dir(&path)`. Turn a missing store `requires` into an error when the repo requirements say `store` (`requirements.rs:36-40`), so the next person gets a message instead of an integrity failure. About 60 lines.

3. **`maybe_init_inside_dotgit` initialises the right places.** In a worktree, create or repair `<common>/sl/store` (`requires`, `gitdir = ../..` relative to the common store) and write only the per-worktree pieces into `<admin>/sl` (`requires` = `store dotgit`, empty dirstate, `bookmarks.current`). Whether to also write a `sharedpath` file depends on the Python question below. About 40 lines.

4. **Python path resolution.** `localrepo.py` computes `sharedpath` and the store itself. Two options: have `maybe_init_inside_dotgit` write `sharedpath = <common>/.git/sl` plus `shared` in the worktree's `requires`, which the fixed Rust reader accepts and Python already handles; or make `localrepo` take `sharedpath`/`store_path` from the Rust `RepoMinimalInfo` binding. The first is smaller and keeps `sl share` semantics intact. About 20 lines either way.

5. **HEAD in the commit graph.** `import_from_git` uses `resolve_head()` to make the checked-out commit a visible head. Once the store is shared, the graph should treat every worktree's HEAD as visible, not just the current one (exactly what ISL's "checked out elsewhere" badges expect, and what `getOtherWorktreeDotHashes` adds to the smartlog revset today). Enumerate `<common>/worktrees/*/HEAD` plus `<common>/HEAD`. `RepoMinimalInfo` should carry the per-worktree admin dir so the commits factory can build its `BareGit` from it rather than from the store's `gitdir` file. About 80 lines in `lib/commits/git`.

6. **Visibleheads namespace.** `refs/visibleheads/<hex>` lives in the common dir and `export_to_git` deletes entries it does not know about (`git.rs:530-560`). With a shared metalog this is consistent, which is another reason to share the store rather than give each worktree its own metalog.

7. **Tests.** New `test-dotgit-worktree*.t` covering: `sl` inside a worktree sees history and the right `.`, commits from a worktree are visible in the main checkout and vice versa, bookmarks/remote names shared, `sl root`/`--shared`/`--dotdir` in both, concurrent `sl status` in both, and the `sharedpath` value round-trip between Rust and Python.

After steps 1 to 5, `sl` works in any worktree created by `git worktree add`, with no `sl worktree` command involved. That alone retires the PreToolUse guard hook and the "publish a detached HEAD as a branch" Stop hook.

## 5. What `sl worktree` itself needs

The command lives in `lib/commands/commands/cmdworktree/` with the registry in `lib/worktree/`. EdenFS touches, exhaustively:

- The gate `repo.requirements.contains("eden")` (`cmdworktree/src/lib.rs:67-69`).
- `clone::eden_clone` (`add.rs:358`) → `eden clone <shared_path> <dest> -r <hex>`.
- `edenfs_client::get_client_dir` (`add.rs:283`) and the redirection/prefetch config snapshot and `eden redirect fixup` (`add.rs:291,370`).
- `edenfs_client::run_eden_remove` (`remove.rs:269`) → `eden remove -y <path>`.
- `edensparse` handling (`add.rs:231-240`) and the direct-copy snapshot's comment that EdenFS detects modified files (`add.rs:777-781`).
- Compile-time: `cmdworktree` is an optional dependency pulled in only by the `eden` feature (`lib/commands/Cargo.toml:56,104`, `lib/commands/src/commands.rs:55-56`), and `clone::eden_clone` is `#[cfg(feature = "eden")]`. The OSS build passes only `sl_oss` (`build.py:389-402`).

Proposed shape: a small backend trait with two implementations, chosen from requirements.

| Operation | Eden backend (today) | Git backend (new) |
|---|---|---|
| gate | `eden` requirement | `dotgit` requirement |
| add | `eden clone -r <hex>` | `git worktree add --detach <dest> <hex>` then `sl` auto-init in dest |
| remove | `eden remove -y` | `git worktree remove --force <path>` (registry says it is ours) |
| list | registry | registry, cross-checked with `git worktree list --porcelain` |
| label | registry + `.sl/worktreename` | same, marker at `<admin>/sl/worktreename` |
| snapshot | `sl snapshot` or direct copy + treestate rows | direct copy + `git add -N`/`git rm --cached` in dest |
| redirections, sparse | eden config | not applicable |

Detached HEAD is the right target because that is how `sl` already drives git in dotgit mode. `check_dest_not_in_repo` (`lib/worktree/src/lib.rs:443-457`) already refuses destinations under a `.git` ancestor, so the sibling `<repo>.worktrees/` layout ISL generates keeps working. The `worktree.enabled` config ISL still passes is read by nothing and only needs tolerating.

Build wiring: make `cmdworktree` a plain dependency (or a `worktree` feature that `sl_oss` turns on), move the `eden_clone` call sites behind the backend trait so the crate compiles without `clone/eden`, and register the command unconditionally in `commands.rs`.

Estimated 300 to 500 lines including the trait and the git backend, most of it moving existing code behind an interface.

## 6. What ISL needs

The server side needs nothing. Verified against an `sl share` checkout of a `sl clone --git` repo, which exercises the same shared-store code path ISL will see:

- `sl root` prints the checkout, `sl root --shared` prints the original, `sl root --dotdir` prints the checkout's dot dir.
- `sl whereami -R <other checkout>` returns the sibling's HEAD.
- `sl worktree list -Tjson` must emit an array of `{path, role: "main"|"linked", label?}`; the existing `list.rs` already does, and ISL ignores the extra `current` field.
- Path strings from `list` must match `sl root` byte for byte after separator normalisation, because `pathsAreIdentical` does no realpath. `list.rs` canonicalises but `sl root` does not, so a worktree under a symlinked path renders as a removable sibling. Worth fixing on the CLI side regardless of backend.

The client side has four gates to relax:

- `addons/isl/src/WorktreeSection.tsx:42` and `addons/isl/src/CheckedOutElsewhere.tsx:28`: `info?.isEdenFs === true`.
- `addons/vscode/extension/commands.ts:631`: same check, with a "Worktrees require EdenFS" error message.
- The `codeReviewSystem.type !== 'github'` exclusion (`WorktreeSection.tsx:42`, `commands.ts:637`). Irrelevant for Gerrit, but it excludes the repos a git backend most naturally targets.

`isEdenFs` is computed by probing for a `.eden` directory (`addons/isl-server/src/Repository.ts:1941-1947`). The cleanest replacement is a `worktreesSupported` field on `RepoInfo` derived from a CLI probe (for example `sl worktree list` succeeding, or a `sl config`/requirements check), so the UI does not have to know which backend is in play.

Watch out for `WatchForChanges.ts:170-182` and `:355-361`: it realpaths the dot dir and edits `.gitignore` relative to an "outer dot dir". A worktree's dot dir is `main/.git/worktrees/<n>/sl`, outside the worktree root, so those two spots need a test.

## 7. The alternative that works today: `sl share` on a native `.sl` clone

For a repo created with `sl clone --git <url>` (native `.sl`, git objects in a private bare repo under `.sl/store/git`), the OSS `sl` already supports `sl --config extensions.share= share <src> <dest>`. Verified: the second checkout shares the store, a commit made in it appears in the first as a draft, checkouts move independently, and every ISL server command behaves. Wiring `sl worktree` to this would be a thin `add = share, remove = rm -rf + registry` and needs none of section 4.

It does not meet the goal, though. The checkout has no `.git`, so `git status`/`git commit` do not work in it, agents cannot use git there, and `~/code/core` is a dotgit repo that would have to be re-cloned. It is a fallback if the dotgit worktree work stalls, and a reasonable second backend to offer later.

## 8. Comparison with the EdenFS route

| | EdenFS worktrees (done, not shipped) | Git worktrees (this document) |
|---|---|---|
| Build | getdeps, fbthrift, folly patches, hours cold | plain `cargo`, existing formula |
| Runtime | daemon, setuid privhelper, NFS mount, `~/.edenrc` | none |
| Repo kind | native `.sl` backing repo, eden mount per worktree; `~/code/core` must be re-cloned | dotgit as-is; `~/code/core` works unchanged |
| Git interop in a worktree | no `.git`, git tools do not work | full: it is a git worktree |
| Checkout speed / laziness | lazy files, instant clone | full checkout per worktree (git's cost) |
| `sl` upstream delta | build fixes only, command untouched | core repo-layer change in `gitcompat`/`repo`; plausibly upstreamable as "dotgit worktree support" |
| Estimated new code | 0 in `sl`, large in packaging | 800 to 1500 Rust, 50 TS, tests |

## 9. Suggested order of work

1. Spike sections 4.1 to 4.4 on a branch and confirm the two-line experiment from section 1 passes: `sl log` and `sl whereami` inside `wt` show the worktree's HEAD and full history, and a commit from `wt` shows in `main`. This is the milestone that removes the agent hooks.
2. Section 4.5 (all worktree HEADs visible), plus the `.t` tests.
3. Section 5: backend trait, git backend, unconditional registration, `test-dotgit-worktree-add.t` etc.
4. Section 6: ISL gates and the `worktreesSupported` field, jest updates.
5. Decide what happens to the eden-enabled build: keep as a second formula for people who want lazy checkouts, or park it.

## 10. Spike results (2026-09-04, branch `dotgit-worktree-spike`)

Steps 4.1 to 4.5 were implemented in the git worktree `~/code/sapling-wt-dotgit` on branch `dotgit-worktree-spike` (based on `12fb88be671`), because another session was switching branches in the main checkout. The OSS `sl` built from it (`eden/scm/out/sl`, version string `0.3.3-worktree-spike`) passes the section 1 experiment and more:

- Inside a `git worktree add` checkout of a dotgit repo: `sl root` is the worktree, `sl root --shared` the main checkout, `sl root --dotdir` is `<main>/.git/worktrees/<name>/sl`; `sl log` shows full history and the worktree's branch as a bookmark; `sl whereami` is the worktree's own HEAD.
- `sl commit` in the worktree updates the worktree's git HEAD and index (git status clean afterwards) and the commit appears in the main checkout's smartlog as a sibling draft. Commits made in main appear in the worktree. `sl goto` in the worktree leaves main's HEAD alone.
- The first ever `sl` run may happen in the worktree; the main checkout is initialised correctly afterwards (this was a bug in the first cut, caught by the Opus review and by a scratch case).
- A worktree already touched by the old `sl` (private empty store, no `sharedpath`) is repaired on the next run.
- A worktree of a bare repo works; `sl root --shared` prints the bare dir.
- A branch created and committed with plain `git` inside the worktree shows up in main as a bookmark.
- Regression: all 12 `test-dotgit-*.t`, 3 `test-share*.t` and 26 `test-git-*.t` pass except `test-dotgit-gpg.t`, which fails identically with the installed Homebrew `sl` (no gpg-agent on this machine). New `tests/test-dotgit-worktree.t` passes.

What changed, in the order of section 4: `identity::dotgit::read_git_common_dir`; `BareGit` gained `git_common_dir` and `is_linked_worktree()`, refs and `packed-refs` read from the common dir, `HEAD` and git's per-worktree namespaces from the admin dir, cwd pinned for worktrees; `maybe_init_inside_dotgit` initialises the shared store under `<common>/sl/store` and writes a per-worktree dot dir with `requires` = `store dotgit shared` and a `sharedpath` file naming `<common>/sl`; `RepoMinimalInfo` treats `commondir` as authoritative for the shared dot dir and main root, and `read_sharedpath` accepts a dotgit shared dot dir; `import_from_git` imports every linked worktree's HEAD into the dag and reads `shallow` from the common dir; `treestate::dirstate::flush` uses `resolve_full_dot_dir`; Python `localrepo.sharedroot` strips the `.git` level to match Rust.

Two things found on the way that are independent of worktrees:

- The merged tree's plain `--oss` build was broken: the fork's `[patch.crates-io]` for `wezterm-dynamic` points at a git revision whose `HashMap` impls sit behind a `std` feature that nothing requested, so `termwiz` failed to compile. Fixed on the spike branch by requesting `wezterm-dynamic` with `std` from `lib/io`. This belongs in its own commit on the merge stack.
- Compatibility: an old `sl` run inside a worktree that a new `sl` has touched aborts with "sharedpath points to nonexistent directory" instead of silently opening an empty repo. Loud is better than silent, but it means the Homebrew `sl` and the spike binary should not be mixed on the same worktree.

Not done in the spike, still open from the review: per-worktree git config (`extensions.worktreeConfig`) does not invalidate the translated config; stale admin dirs left by deleting a worktree without `git worktree prune` keep their HEAD pinned in the dag until pruned; `list_references` walks all of the admin dir's `refs/` while `lookup_reference` routes only git's three per-worktree namespaces there (cosmetic).

## Appendix: experiment log

Scratch dirs under `~/.claude/jobs/d6da13d0/tmp/` (removed with the job):

- `wt-exp`, `wt-exp2`: polluted by `sl init --git .`, which creates a fresh `.sl` repo on top of the git repo. Dotgit mode is auto-initialised by running any `sl` command in a git repo; do not run `sl init --git` in an existing one.
- `wt-exp3/main` + `wt`: the plain dotgit + `git worktree add` case from section 1, then the `sharedpath = main/.git` variant that reproduces "integrity check failed on commit" and leaves `main/.git/store` behind.
- `wt-exp3/native` + `shared1`: `sl clone --git` plus `sl share`, the working alternative from section 7.
