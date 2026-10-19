#require git no-windows no-eden

`sl worktree prune PATH...` only considers the named worktrees, and says why
each one it keeps stays. A named idle worktree goes without waiting to age,
so a session that is done with its worktree can drop it, while a sweep
(`prune` without PATHs) leaves young worktrees alone. Everything else that
keeps a worktree still does.

  $ . $TESTDIR/git.sh
  $ setconfig remotenames.rename.default=origin remotenames.hoist=origin
  $ setconfig extensions.shelve= extensions.rebase=

  $ git init -q -b main $TESTTMP/server
  $ cd $TESTTMP/server
  $ echo base > base
  $ git add base
  $ git commit -q -m base
  $ git checkout -q --detach
  $ git clone -q $TESTTMP/server $TESTTMP/repo
  $ cd $TESTTMP/repo
  $ git checkout -q --detach

Fresh worktrees on origin/main, then one with a draft, one locked, one dirty,
one with a shelf and one in the middle of a rebase:

  $ for name in done other draft locked dirty shelved rebasing; do
  >   sl worktree add -q -r origin/main $TESTTMP/$name
  > done
  $ cd $TESTTMP/draft
  $ echo draft > draft
  $ sl commit -qAm draft
  $ git -C $TESTTMP/repo worktree lock --reason claude-session:1 $TESTTMP/locked
  $ echo dirty > $TESTTMP/dirty/dirty
  $ cd $TESTTMP/shelved
  $ echo wip > wip
  $ sl add -q wip
  $ sl shelve -q
  $ cd $TESTTMP/rebasing
  $ echo one > base
  $ sl commit -qm one
  $ sl goto -q origin/main
  $ echo two > base
  $ sl commit -qm two
  $ sl rebase -q -d 'desc(one)'
  warning: 1 conflicts while merging base! (edit, then use 'sl resolve --mark')
  unresolved conflicts (see sl resolve, then sl rebase --continue)
  [1]
  $ cd $TESTTMP/repo

A sweep keeps the young idle worktrees:

  $ sl worktree prune --dry-run
  keeping $TESTTMP/dirty (idle): it was made or moved less than 1d ago
  keeping $TESTTMP/done (idle): it was made or moved less than 1d ago
  keeping $TESTTMP/locked (idle): it is locked (claude-session:1)
  keeping $TESTTMP/other (idle): it was made or moved less than 1d ago
  keeping $TESTTMP/shelved (idle): it has shelved changes
  no worktrees to prune

Named, an idle worktree goes at once, and the others are left alone:

  $ sl worktree prune -y $TESTTMP/done
  removed $TESTTMP/done (idle)
  $ test -d $TESTTMP/other && echo kept
  kept

Named, the rest stay, each with its reason:

  $ sl worktree prune --dry-run $TESTTMP/draft $TESTTMP/locked $TESTTMP/dirty $TESTTMP/shelved $TESTTMP/rebasing
  keeping $TESTTMP/dirty (idle): it has uncommitted changes
  keeping $TESTTMP/draft: its commit has not landed and was not abandoned
  keeping $TESTTMP/locked (idle): it is locked (claude-session:1)
  keeping $TESTTMP/rebasing: a merge, rebase, ... is unfinished there
  keeping $TESTTMP/shelved (idle): it has shelved changes
  no worktrees to prune

The current checkout stays too:

  $ cd $TESTTMP/other
  $ sl worktree prune --dry-run $TESTTMP/other
  keeping $TESTTMP/other: it is the current checkout
  no worktrees to prune
  $ cd $TESTTMP/repo

PATHs must be linked worktrees of this group:

  $ sl worktree prune $TESTTMP/repo
  abort: cannot prune the main worktree
  [255]
  $ sl worktree prune $TESTTMP/elsewhere
  abort: $TESTTMP/elsewhere is not in this worktree group
  [255]
  $ sl worktree prune $TESTTMP/other/sub
  abort: $TESTTMP/other/sub is not the root of checkout $TESTTMP/other, not pruning
  [255]
