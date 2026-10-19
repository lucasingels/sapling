#require git no-windows no-eden

`prune` tells a worktree whose work landed from an idle one that sits on a
public commit it never had as a draft, e.g. one an agent hook just made on
origin/main. An idle worktree only goes once it was not made or moved for
worktree.prune-min-age.

  $ . $TESTDIR/git.sh
  $ setconfig remotenames.rename.default=origin remotenames.hoist=origin
  $ setconfig extensions.shelve=

  $ git init -q -b main $TESTTMP/server
  $ cd $TESTTMP/server
  $ echo base > base
  $ git add base
  $ git commit -q -m base
  $ git checkout -q --detach
  $ git clone -q $TESTTMP/server $TESTTMP/repo
  $ cd $TESTTMP/repo
  $ git checkout -q --detach

  $ age() {
  >   for file in commondir HEAD logs/HEAD; do
  >     touch -t 202001010000 $TESTTMP/repo/.git/worktrees/$1/$file
  >   done
  > }

An agent commits in "a" and lands it as is; then "b" is made on origin/main,
which is now that very commit. Only "a" landed; "b" is fresh:

  $ sl worktree add -q -r origin/main $TESTTMP/a
  $ cd $TESTTMP/a
  $ echo a > a
  $ sl commit -qAm a
  $ sl push -q -r . --to main
  $ cd $TESTTMP/repo
  $ sl worktree add -q -r origin/main $TESTTMP/b
  $ sl worktree prune --dry-run
  keeping $TESTTMP/b (idle): it was made or moved less than 1d ago
  would remove $TESTTMP/a (landed)

A worktree made on a draft that then lands as is landed too. Nothing was
committed in it, though, and whoever made it, e.g. an agent hook that runs
`sl worktree add` from a draft, may still be using it: it waits like an idle
one:

  $ sl goto -q origin/main
  $ echo c > c
  $ sl commit -qAm c
  $ sl worktree add -q $TESTTMP/c
  $ sl push -q -r . --to main
  $ sl worktree prune --dry-run
  keeping $TESTTMP/b (idle): it was made or moved less than 1d ago
  keeping $TESTTMP/c (landed): it was made or moved less than 1d ago
  would remove $TESTTMP/a (landed)
  $ age c
  $ sl worktree prune -y
  keeping $TESTTMP/b (idle): it was made or moved less than 1d ago
  removed $TESTTMP/a (landed)
  removed $TESTTMP/c (landed)

An idle worktree goes once it is old enough, by worktree.prune-min-age:

  $ sl worktree prune --dry-run --config worktree.prune-min-age=0
  would remove $TESTTMP/b (idle)
  $ sl worktree prune --dry-run --config worktree.prune-min-age=1h
  keeping $TESTTMP/b (idle): it was made or moved less than 1h ago
  no worktrees to prune
  $ age b
  $ sl worktree prune --dry-run
  would remove $TESTTMP/b (idle)

Moving it to another commit makes it young again:

  $ cd $TESTTMP/server
  $ git checkout -q main
  $ echo d > d
  $ git add d
  $ git commit -q -m d
  $ git checkout -q --detach
  $ cd $TESTTMP/b
  $ sl pull -q
  $ sl goto -q origin/main
  $ cd $TESTTMP/repo
  $ sl worktree prune --dry-run
  keeping $TESTTMP/b (idle): it was made or moved less than 1d ago
  no worktrees to prune

Uncommitted changes keep an old idle worktree; ignored files do not count:

  $ age b
  $ echo wip > $TESTTMP/b/wip
  $ sl worktree prune --dry-run
  keeping $TESTTMP/b (idle): it has uncommitted changes
  no worktrees to prune
  $ rm $TESTTMP/b/wip
  $ echo ignored >> $TESTTMP/repo/.git/info/exclude
  $ echo junk > $TESTTMP/b/ignored
  $ sl worktree prune --dry-run
  would remove $TESTTMP/b (idle)

Shelves keep a worktree too, and `remove` refuses to drop them without
--force:

  $ sl worktree add -q -r origin/main $TESTTMP/s
  $ cd $TESTTMP/s
  $ echo wip > wip
  $ sl add -q wip
  $ sl shelve -q
  $ sl status
  $ cd $TESTTMP/repo
  $ sl worktree prune --dry-run --config worktree.prune-min-age=0
  keeping $TESTTMP/s (idle): it has shelved changes
  would remove $TESTTMP/b (idle)
  $ sl worktree remove -y $TESTTMP/s
  $TESTTMP/s has shelved changes:
    default
  abort: not removing worktrees with shelved changes (use --force to remove them anyway)
  [255]

The commit `sl shelve` makes does not count as work done there: once the
shelf is gone, the worktree is idle again, not landed:

  $ cd $TESTTMP/s
  $ sl unshelve -q
  $ sl revert -q --all
  $ rm wip
  $ cd $TESTTMP/repo
  $ age s
  $ sl worktree prune --dry-run
  would remove $TESTTMP/b (idle)
  would remove $TESTTMP/s (idle)
  $ sl worktree remove -y $TESTTMP/s
  removed $TESTTMP/s

A draft that lands under another hash, without anything marking it as landed,
keeps its worktree:

  $ sl worktree add -q -r origin/main $TESTTMP/e
  $ cd $TESTTMP/e
  $ echo e > e
  $ sl commit -qAm e
  $ cd $TESTTMP/server
  $ git checkout -q main
  $ echo e > e
  $ git add e
  $ git commit -q -m 'e, as landed'
  $ git checkout -q --detach
  $ cd $TESTTMP/e
  $ sl pull -q
  $ cd $TESTTMP/repo
  $ sl worktree prune --dry-run
  would remove $TESTTMP/b (idle)

Worktrees made with relative paths (worktree.useRelativePaths) age too:

  $ sl pull -q
  $ sl goto -q origin/main
  $ git -c worktree.useRelativePaths=true worktree add -q --detach $TESTTMP/g
  $ sl worktree prune --dry-run
  keeping $TESTTMP/g (idle): it was made or moved less than 1d ago
  would remove $TESTTMP/b (idle)
  $ age g
  $ sl worktree prune --dry-run
  would remove $TESTTMP/b (idle)
  would remove $TESTTMP/g (idle)

Only the commit a worktree's last `sl commit` made, while it is still on it,
makes it landed. A worktree that committed and then went back to where it was
made ("m"), committed on an older commit and dropped that ("old"), or whose
work landed before it moved on to its next task ("next") is idle:

  $ sl worktree remove -q -y --force $TESTTMP/b $TESTTMP/e $TESTTMP/g
  $ for name in m old next; do
  >   sl worktree add -q -r origin/main $TESTTMP/$name
  > done
  $ cd $TESTTMP/m
  $ echo m > m
  $ sl commit -qAm m
  $ sl goto -q origin/main
  $ cd $TESTTMP/old
  $ sl goto -q 'desc(base)'
  $ echo old > old
  $ sl commit -qAm old
  $ sl hide -q .
  $ cd $TESTTMP/next
  $ echo next > next
  $ sl commit -qAm next
  $ sl push -q -r . --to main
  $ cd $TESTTMP/repo
  $ sl worktree prune --dry-run
  keeping $TESTTMP/m (idle): it was made or moved less than 1d ago
  keeping $TESTTMP/old (idle): it was made or moved less than 1d ago
  would remove $TESTTMP/next (landed)
  $ cd $TESTTMP/server
  $ git checkout -q main
  $ echo f > f
  $ git add f
  $ git commit -q -m f
  $ git checkout -q --detach
  $ cd $TESTTMP/next
  $ sl pull -q
  $ sl goto -q origin/main
  $ cd $TESTTMP/repo
  $ sl worktree prune --dry-run
  keeping $TESTTMP/m (idle): it was made or moved less than 1d ago
  keeping $TESTTMP/next (idle): it was made or moved less than 1d ago
  keeping $TESTTMP/old (idle): it was made or moved less than 1d ago
  no worktrees to prune
