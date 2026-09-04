#require git no-eden

Test running `sl` inside a linked git worktree (`git worktree add`) of a
dotgit repo.

  $ . $TESTDIR/git.sh
  $ setconfig diff.git=true ui.allowemptycommit=true

Prepare a git repo with two commits on "main":

  $ git init -q -b main $TESTTMP/git-repo
  $ cd $TESTTMP/git-repo
  $ echo a > a
  $ git add a
  $ git commit -q -m commit1
  $ echo b > a
  $ git commit -q -a -m commit2

Add a linked worktree on its own branch:

  $ git worktree add -q $TESTTMP/wt -b agent
  $ cd $TESTTMP/wt

`sl root` prints the worktree itself, `--shared` the main checkout, and
`--dotdir` the per-worktree dot dir living under the main repo's `.git`:

  $ sl root
  $TESTTMP/wt
  $ sl root --shared
  $TESTTMP/git-repo
  $ sl root --dotdir
  $TESTTMP/git-repo/.git/worktrees/wt/sl

The per-worktree dot dir has its own requires/sharedpath/dirstate, and points
at the main checkout's shared store:

  $ cat $(sl root --dotdir)/requires
  store
  dotgit
  shared
  $ cat $(sl root --dotdir)/sharedpath; echo
  $TESTTMP/git-repo/.git/sl
  $ test -f $(sl root --dotdir)/dirstate && echo dirstate-ok
  dirstate-ok

`sl log` in the worktree sees the full history, and the worktree's own git
branch shows up as a bookmark:

  $ sl log -r 'all()' -T '{desc}\n'
  commit1
  commit2
  $ sl log -r 'desc(commit2)' -T '{desc} {bookmarks}\n'
  commit2 agent

`sl whereami` reflects the worktree's own git HEAD:

  $ [ "$(sl whereami)" = "$(git rev-parse HEAD)" ] && echo same
  same

Commit from the worktree; it becomes visible from the main checkout as a
draft commit:

  $ echo wt > wt-file
  $ sl commit -qAm commit3-wt

  $ sl -R $TESTTMP/git-repo log -r 'all()' -T '{desc} {phase}\n'
  commit1 draft
  commit2 draft
  commit3-wt draft

`.` is independent between the worktree and the main checkout:

  $ [ "$(sl whereami)" = "$(sl -R $TESTTMP/git-repo whereami)" ] && echo same || echo different
  different

Commit from the main checkout; it becomes visible from the worktree:

  $ cd $TESTTMP/git-repo
  $ echo main > main-file
  $ sl commit -qAm commit4-main
  $ cd $TESTTMP/wt

  $ sl log -r 'all()' -T '{desc}\n'
  commit1
  commit2
  commit3-wt
  commit4-main

`sl status` in the worktree reflects its own working copy and index,
including when run from a sub-directory:

  $ mkdir sub
  $ echo x > sub/x
  $ sl status
  ? sub/x
  $ cd sub
  $ sl status
  ? x
  $ cd ..
  $ rm -rf sub

`sl goto` in the worktree only moves the worktree's HEAD, leaving the main
checkout untouched:

  $ MAIN_HEAD=$(git -C $TESTTMP/git-repo rev-parse HEAD)
  $ sl goto -q 'desc(commit1)'
  $ cat a
  a
  $ [ "$(sl whereami)" = "$(git rev-parse HEAD)" ] && echo same
  same
  $ [ "$(git -C $TESTTMP/git-repo rev-parse HEAD)" = "$MAIN_HEAD" ] && echo main-unchanged
  main-unchanged
