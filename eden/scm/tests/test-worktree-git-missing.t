#require git no-windows no-eden

A linked git worktree deleted behind sl's back stays listed, as missing,
until sl removes what is left of it.

  $ . $TESTDIR/git.sh
  $ git init -q -b main repo
  $ cd repo
  $ echo base > base
  $ git add base
  $ git commit -qm base
  $ git checkout -q --detach
  $ echo draft > draft
  $ sl commit -qAm draft
  $ for name in a b c; do
  >   sl worktree add -q $TESTTMP/$name --label $name
  > done

  $ missing() {
  >   sl worktree list -Tjson | sl debugpython -- -c "
  > import json, os, sys
  > for entry in json.load(sys.stdin):
  >     print(os.path.basename(entry['path']), entry['missing'])
  > "
  > }

Deleted worktrees are listed as missing:

  $ rm -rf $TESTTMP/a
  $ rm -rf $TESTTMP/b
  $ sl worktree list
  * main    $TESTTMP/repo
    linked  $TESTTMP/a   a   (missing)
    linked  $TESTTMP/b   b   (missing)
    linked  $TESTTMP/c   c
  $ missing
  repo False
  a True
  b True
  c False

`remove` takes a missing worktree by its path, forgets its label, and leaves
the other missing one alone:

  $ sl worktree remove -y $TESTTMP/a
  removed $TESTTMP/a
  $ sl worktree list
  * main    $TESTTMP/repo
    linked  $TESTTMP/b   b   (missing)
    linked  $TESTTMP/c   c
  $ git worktree list --porcelain | grep '^worktree '
  worktree $TESTTMP/repo
  worktree $TESTTMP/b
  worktree $TESTTMP/c

A new worktree at that path does not inherit the old label:

  $ sl worktree add -q $TESTTMP/a
  $ sl worktree list
  * main    $TESTTMP/repo
    linked  $TESTTMP/a
    linked  $TESTTMP/b   b   (missing)
    linked  $TESTTMP/c   c

`add` at the path of a missing worktree replaces it:

  $ sl worktree add -q $TESTTMP/b --label b2
  $ sl worktree list
  * main    $TESTTMP/repo
    linked  $TESTTMP/a
    linked  $TESTTMP/b   b2
    linked  $TESTTMP/c   c

`prune` removes missing worktrees; worktrees on drafts stay:

  $ rm -rf $TESTTMP/c
  $ sl worktree prune --dry-run
  would remove $TESTTMP/c (missing)
  $ sl worktree prune -y
  removed $TESTTMP/c (missing)
  $ sl worktree list
  * main    $TESTTMP/repo
    linked  $TESTTMP/a
    linked  $TESTTMP/b   b2
  $ sl worktree path c
  abort: no worktree in this group is labeled 'c'
  [255]

`add` does not replace a missing worktree that keeps shelves, which would go
with it:

  $ setconfig extensions.shelve=
  $ sl worktree add -q $TESTTMP/s
  $ cd $TESTTMP/s
  $ echo wip > wip
  $ sl add -q wip
  $ sl shelve -q
  $ cd $TESTTMP/repo
  $ rm -rf $TESTTMP/s
  $ sl worktree add -q $TESTTMP/s
  abort: $TESTTMP/s is a missing worktree with shelved changes (default); remove them with it by `sl worktree remove --force $TESTTMP/s` first
  [255]
  $ sl worktree prune --dry-run
  keeping $TESTTMP/s (missing): it has shelved changes
  no worktrees to prune
  $ sl worktree remove -y --force $TESTTMP/s
  removed $TESTTMP/s
  $ sl worktree add -q $TESTTMP/s
  $ sl worktree remove -y $TESTTMP/s
  removed $TESTTMP/s

A worktree that cannot be read is not missing, and prune keeps it (there is
no remote, so its commit is a draft and stays anyway once readable):

#if no-root
  $ mkdir $TESTTMP/shut
  $ sl worktree add -q $TESTTMP/shut/d -r "$(sl log -r 'desc(base)' -T '{node}')"
  $ chmod 000 $TESTTMP/shut
  $ sl worktree list
  * main    $TESTTMP/repo
    linked  $TESTTMP/a
    linked  $TESTTMP/b   b2
    linked  $TESTTMP/shut/d
  $ sl worktree prune --dry-run
  keeping $TESTTMP/shut/d: cannot read it: Permission denied (os error 13)
  no worktrees to prune
  $ chmod 755 $TESTTMP/shut
  $ sl worktree prune --dry-run
  no worktrees to prune
#endif
