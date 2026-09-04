#require git no-eden

Test `sl worktree` on a dotgit repo, backed by `git worktree`.

  $ . $TESTDIR/git.sh
  $ setconfig diff.git=true ui.allowemptycommit=true

Prepare a git repo with two commits:

  $ git init -q -b main $TESTTMP/repo
  $ cd $TESTTMP/repo
  $ echo a > a
  $ git add a
  $ git commit -q -m commit1
  $ echo b > b
  $ git add b
  $ git commit -q -m commit2

Before any linked worktree exists, the main checkout forms a group by itself:

  $ sl worktree list
  * main    $TESTTMP/repo

Add a linked worktree at the current commit, with a label:

  $ sl worktree add $TESTTMP/wt1 --label first
  created linked worktree at $TESTTMP/wt1
  $ git worktree list --porcelain | grep '^worktree '
  worktree $TESTTMP/repo
  worktree $TESTTMP/wt1
  $ sl worktree list
  * main    $TESTTMP/repo
    linked  $TESTTMP/wt1   first
  $ sl worktree list -Tjson
  [
  {
    "path": "$TESTTMP/repo",
    "role": "main",
    "current": true
  },
  {
    "path": "$TESTTMP/wt1",
    "role": "linked",
    "label": "first",
    "current": false
  }
  ]

The new worktree is a detached checkout of the same commit, sl works in it,
and it knows its label:

  $ cd $TESTTMP/wt1
  $ git symbolic-ref -q HEAD || echo detached
  detached
  $ [ "$(sl whereami)" = "$(sl -R $TESTTMP/repo whereami)" ] && echo same
  same
  $ sl log -r . -T '{desc}\n'
  commit2
  $ cat $(sl root --dotdir)/worktreename
  first (no-eol)
  $ sl root --shared
  $TESTTMP/repo

Add a worktree at an older revision:

  $ sl worktree add $TESTTMP/wt2 -r $(sl log -r 'desc(commit1)' -T '{node}')
  created linked worktree at $TESTTMP/wt2
  $ sl -R $TESTTMP/wt2 log -r . -T '{desc}\n'
  commit1
  $ ls $TESTTMP/wt2
  a

`list` from a linked worktree marks it as current:

  $ sl worktree list
    main    $TESTTMP/repo
  * linked  $TESTTMP/wt1   first
    linked  $TESTTMP/wt2

Labels can be set and removed from anywhere in the group:

  $ sl worktree label $TESTTMP/wt2 second
  label set for $TESTTMP/wt2
  $ sl worktree label $TESTTMP/wt1 --remove
  label removed for $TESTTMP/wt1
  $ sl worktree list -Tjson | grep -E 'label|path'
    "path": "$TESTTMP/repo",
    "path": "$TESTTMP/wt1",
    "path": "$TESTTMP/wt2",
    "label": "second",
  $ cat $(sl root --dotdir)/worktreename
  wt1 (no-eol)

A worktree created with plain git shows up too:

  $ git -C $TESTTMP/repo worktree add -q --detach $TESTTMP/wt3
  $ sl worktree list
    main    $TESTTMP/repo
  * linked  $TESTTMP/wt1
    linked  $TESTTMP/wt2   second
    linked  $TESTTMP/wt3

Commits made in a worktree are visible in the others:

  $ cd $TESTTMP/wt2
  $ echo c > c
  $ sl commit -qAm commit3
  $ sl -R $TESTTMP/repo log -r 'all()' -T '{desc}\n'
  commit1
  commit2
  commit3

Snapshot: uncommitted changes (modified, added, untracked) follow into the new
worktree:

  $ cd $TESTTMP/repo
  $ echo aa > a
  $ echo new > new
  $ sl add new
  $ echo untracked > untracked
  $ sl status
  M a
  A new
  ? untracked
  $ sl worktree add $TESTTMP/wt4 --snapshot
  computing working copy status...
  created linked worktree at $TESTTMP/wt4
  applying working copy changes to new worktree...
  working copy changes applied to new worktree
  $ cd $TESTTMP/wt4
  $ sl status
  M a
  A new
  ? untracked
  $ cat a
  aa
  $ cd $TESTTMP/repo
  $ sl status
  M a
  A new
  ? untracked

The main worktree cannot be removed while linked ones exist; a path outside
the group is rejected:

  $ sl worktree remove $TESTTMP/repo -y
  abort: cannot remove a main worktree with linked worktrees
  [255]
  $ sl worktree remove $TESTTMP/elsewhere -y
  abort: $TESTTMP/elsewhere is not in this worktree group, use `git worktree remove` instead
  [255]

Remove worktrees, including one with local changes; git forgets them too:

  $ sl worktree remove $TESTTMP/wt4 $TESTTMP/wt3 -y
  removed $TESTTMP/wt3
  removed $TESTTMP/wt4
  $ test -d $TESTTMP/wt4 || echo gone
  gone
  $ git worktree list --porcelain | grep '^worktree '
  worktree $TESTTMP/repo
  worktree $TESTTMP/wt1
  worktree $TESTTMP/wt2

A worktree deleted behind sl's back is dropped from the list:

  $ rm -rf $TESTTMP/wt1
  $ sl worktree list
  * main    $TESTTMP/repo
    linked  $TESTTMP/wt2   second

Remove everything that is left:

  $ sl worktree remove --all -y
  removed $TESTTMP/wt2
  $ sl worktree list
  * main    $TESTTMP/repo
  $ git worktree list --porcelain | grep '^worktree '
  worktree $TESTTMP/repo
