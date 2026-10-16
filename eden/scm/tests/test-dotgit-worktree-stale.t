#require git no-eden

A checkout of a worktree group goes stale when another checkout rewrites its
commits, the way a jj workspace does.

  $ . $TESTDIR/git.sh
  $ setconfig diff.git=true ui.allowemptycommit=true

  $ git init -q -b main $TESTTMP/repo
  $ cd $TESTTMP/repo
  $ echo base > base
  $ git add base
  $ git commit -q -m base
  $ git checkout -q --detach
  $ echo a > a
  $ sl commit -qAm A

  $ sl worktree add $TESTTMP/wt
  created linked worktree at $TESTTMP/wt
  $ sl worktree add $TESTTMP/dirty
  created linked worktree at $TESTTMP/dirty
  $ echo pending > $TESTTMP/dirty/pending
  $ sl --cwd $TESTTMP/dirty add -q pending

Rewriting A in the main checkout leaves the other checkouts alone:

  $ echo a2 > a
  $ sl amend -m A2
  note: worktree $TESTTMP/dirty is now stale (it is on 6592f5ce41bd "A"); 'sl update-stale' there moves it onto the latest versions
  note: worktree $TESTTMP/wt is now stale (it is on 6592f5ce41bd "A"); 'sl update-stale' there moves it onto the latest versions
  $ cat $TESTTMP/wt/a
  a
  $ sl -R $TESTTMP/wt log -r . -T '{desc}\n'
  A

Read-only commands work in the stale checkout; commands that would build on or
rewrite the stale commit refuse:

  $ cd $TESTTMP/wt
  $ sl status
  $ echo b > b
  $ sl commit -qAm B
  abort: stale worktree: this worktree's commit 6592f5ce41bd "A" was rewritten in another worktree
  (nothing was changed; run 'sl update-stale' to move this worktree onto the latest versions (uncommitted changes come along), then retry)
  [255]
  $ sl amend -m A3
  abort: stale worktree: this worktree's commit 6592f5ce41bd "A" was rewritten in another worktree
  (nothing was changed; run 'sl update-stale' to move this worktree onto the latest versions (uncommitted changes come along), then retry)
  [255]

update-stale moves onto the latest version, carrying pending changes along:

  $ sl update-stale
  note: this worktree's commit 6592f5ce41bd "A" was rewritten in another worktree
  note: moved this worktree to the latest version 414300166dd7 "A2"; files changed to match
  $ sl log -r . -T '{desc}\n'
  A2
  $ cat a
  a2
  $ sl status
  ? b
  $ sl commit -qAm B
  $ sl update-stale
  this worktree is not stale

The same goes for the checkout that had uncommitted changes:

  $ cd $TESTTMP/dirty
  $ sl update-stale
  note: this worktree's commit 6592f5ce41bd "A" was rewritten in another worktree
  note: moved this worktree to the latest version 414300166dd7 "A2"; files changed to match
  $ sl status
  A pending
  $ sl commit -qm P

Own commits on top of a commit rewritten elsewhere leave the checkout stale
too, and update-stale restacks them, uncommitted changes and all:

  $ cd $TESTTMP/repo
  $ sl goto -q 'desc(A2)'
  $ echo a3 > a
  $ sl amend --no-rebase
  hint[amend-restack]: descendants of * are left behind - use 'sl restack' to rebase them (glob)
  hint[hint-ack]: use 'sl hint --ack amend-restack' to silence these hints
  note: worktree $TESTTMP/dirty is now stale (it is on 037085e2525a "P"); 'sl update-stale' there moves it onto the latest versions
  note: worktree $TESTTMP/wt is now stale (it is on 22236f856409 "B"); 'sl update-stale' there moves it onto the latest versions
  $ cd $TESTTMP/wt
  $ echo more > b
  $ sl amend
  abort: stale worktree: 414300166dd7 "A2", below this worktree's commit, was rewritten in another worktree
  (nothing was changed; run 'sl update-stale' to move this worktree onto the latest versions (uncommitted changes come along), then retry)
  [255]
  $ sl update-stale
  note: 414300166dd7 "A2", below this worktree's commit, was rewritten in another worktree
  note: restacked this worktree's commits onto the latest versions, now on 583eed58c3e0 "B"; files changed to match
  $ sl log -r '.^::.' -T '{desc}\n'
  A2
  B
  $ cat a b
  a3
  more
  $ sl status
  M b

With worktree.auto-update-stale, any command first updates a stale checkout:

  $ cd $TESTTMP/repo
  $ sl metaedit -q -r $(sl -R $TESTTMP/wt log -r . -T '{node}') -m B2
  note: worktree $TESTTMP/wt is now stale (it is on 583eed58c3e0 "B"); 'sl update-stale' there moves it onto the latest versions
  $ cd $TESTTMP/wt
  $ sl log -r . -T '{desc}\n' --config worktree.auto-update-stale=true
  note: this worktree's commit 583eed58c3e0 "B" was rewritten in another worktree
  note: moved this worktree to the latest version 47c3fc8a52d7 "B2"; files changed to match
  B2
  $ sl status
  M b

Set in a config file, it also restacks with uncommitted changes set aside:

  $ setconfig worktree.auto-update-stale=true
  $ cd $TESTTMP/repo
  $ sl goto -q 'desc(A2) - obsolete()'
  $ echo a4 > a
  $ sl amend -q --no-rebase
  hint[amend-restack]: descendants of * are left behind - use 'sl restack' to rebase them (glob)
  hint[hint-ack]: use 'sl hint --ack amend-restack' to silence these hints
  note: worktree $TESTTMP/wt is now stale (it is on 47c3fc8a52d7 "B2"); it moves onto the latest versions at its next sl command
  $ cd $TESTTMP/wt
  $ sl log -r . -T '{desc}\n'
  note: 94cd8d1654d1 "A2", below this worktree's commit, was rewritten in another worktree
  note: restacked this worktree's commits onto the latest versions, now on c8229bba727d "B2"; files changed to match
  B2
  $ sl status
  M b
  $ cat a
  a4
  $ setconfig worktree.auto-update-stale=false

Outside a worktree group, an obsolete working copy parent is not stale:

  $ git init -q -b main $TESTTMP/single
  $ cd $TESTTMP/single
  $ echo x > x
  $ sl commit -qAm X
  $ sl amend -qm X2
  $ sl goto -q 'predecessors(.) - .'
  warning: checking out an old version of a commit risks diverging your stack:
  - * -> * (amend) (glob)
  $ echo y > y
  $ sl commit -qAm Y
  warning: creating a child of an old version of a commit will diverge your stack:
  - * -> * (amend) (glob)
