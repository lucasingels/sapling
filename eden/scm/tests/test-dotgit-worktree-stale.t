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

`worktree list` shows which checkouts are stale, and what each has checked out:

  $ sl worktree list
  * main    $TESTTMP/repo
    linked  $TESTTMP/dirty   (stale)
    linked  $TESTTMP/wt   (stale)
  $ sl worktree list -Tjson | sl debugpython -- -c "
  > import json, sys
  > for entry in json.load(sys.stdin):
  >     print(entry['node'][:12], entry['stale'], entry.get('stale_reason'))
  > "
  414300166dd7 False None
  6592f5ce41bd True this worktree's commit 6592f5ce41bd "A" was rewritten in another worktree
  6592f5ce41bd True this worktree's commit 6592f5ce41bd "A" was rewritten in another worktree
  $ sl -R $TESTTMP/wt log -r . -T '{desc}\n'
  note: this worktree's commit 6592f5ce41bd "A" was rewritten in another worktree; 'sl update-stale' moves it onto the latest versions
  A

Read-only commands work in the stale checkout and note that it is stale, the
Rust ones (status, whereami) included; whereami keeps the bare hash on stdout:

  $ cd $TESTTMP/wt
  $ sl status
  note: this worktree's commit 6592f5ce41bd "A" was rewritten in another worktree; 'sl update-stale' moves it onto the latest versions
  $ sl whereami
  6592f5ce41bd* (glob)
  note: this worktree's commit 6592f5ce41bd "A" was rewritten in another worktree; 'sl update-stale' moves it onto the latest versions
  $ sl whereami 2>/dev/null
  6592f5ce41bd* (glob)

Commands that would build on or rewrite the stale commit refuse:

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
  $ sl worktree list -Tjson | sl debugpython -- -c "
  > import json, sys
  > for entry in json.load(sys.stdin):
  >     print(entry['stale'], entry.get('stale_reason'))
  > "
  False None
  True 414300166dd7 "A2", below this worktree's commit, was rewritten in another worktree
  True 414300166dd7 "A2", below this worktree's commit, was rewritten in another worktree
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

With worktree.auto-update-stale, a command that would build on the stale
commits first updates the checkout; read-only commands still only note it:

  $ cd $TESTTMP/repo
  $ sl metaedit -q -r $(sl -R $TESTTMP/wt log -r . -T '{node}') -m B2
  note: worktree $TESTTMP/wt is now stale (it is on 583eed58c3e0 "B"); 'sl update-stale' there moves it onto the latest versions
  $ cd $TESTTMP/wt
  $ sl log -r . -T '{desc}\n' --config worktree.auto-update-stale=true
  note: this worktree's commit 583eed58c3e0 "B" was rewritten in another worktree; 'sl update-stale' moves it onto the latest versions
  B
  $ sl metaedit -m B3 --config worktree.auto-update-stale=true
  note: this worktree's commit 583eed58c3e0 "B" was rewritten in another worktree
  note: moved this worktree to the latest version 47c3fc8a52d7 "B2"; files changed to match
  $ sl log -r . -T '{desc}\n'
  B3
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
  note: worktree $TESTTMP/wt is now stale (it is on f961745d4e8e "B3"); it moves onto the latest versions before the next command there that would build on them
  $ cd $TESTTMP/wt
  $ sl log -r . -T '{desc}\n'
  note: 94cd8d1654d1 "A2", below this worktree's commit, was rewritten in another worktree; 'sl update-stale' moves it onto the latest versions
  B3
  $ sl metaedit -m B4
  note: 94cd8d1654d1 "A2", below this worktree's commit, was rewritten in another worktree
  note: left 037085e2525a "P" for worktree $TESTTMP/dirty; run 'sl update-stale' there
  note: restacked this worktree's commits onto the latest versions, now on 3f0065896a64 "B3"; files changed to match
  $ sl log -r '.^::.' -T '{desc}\n'
  A2
  B4
  $ sl status
  M b
  $ cat a
  a4
  $ setconfig worktree.auto-update-stale=false

Uncommitted changes to the files the rewrite changed come along too. Ones that
merge cleanly land on the latest version:

  $ setconfig extensions.shelve=
  $ git init -q -b main $TESTTMP/overlap
  $ cd $TESTTMP/overlap
  $ echo 1 > f
  $ echo 2 >> f
  $ echo 3 >> f
  $ git add f
  $ git commit -q -m base
  $ git checkout -q --detach
  $ echo c > c
  $ sl commit -qAm C
  $ sl worktree add -q $TESTTMP/clean
  $ sl worktree add -q $TESTTMP/conflict
  $ sl worktree add -q $TESTTMP/stacked
  $ echo 1 > $TESTTMP/clean/f
  $ echo 2 >> $TESTTMP/clean/f
  $ echo three >> $TESTTMP/clean/f
  $ echo uno > $TESTTMP/conflict/f
  $ echo 2 >> $TESTTMP/conflict/f
  $ echo 3 >> $TESTTMP/conflict/f
  $ cd $TESTTMP/stacked
  $ echo d > d
  $ sl commit -qAm D
  $ echo uno > f
  $ echo 2 >> f
  $ echo 3 >> f
  $ cd $TESTTMP/overlap
  $ echo one > f
  $ echo 2 >> f
  $ echo 3 >> f
  $ sl amend -qm C2
  hint[amend-restack]: descendants of 6268e51f817f are left behind - use 'sl restack' to rebase them
  hint[hint-ack]: use 'sl hint --ack amend-restack' to silence these hints
  note: worktree $TESTTMP/clean is now stale (it is on 6268e51f817f "C"); 'sl update-stale' there moves it onto the latest versions
  note: worktree $TESTTMP/conflict is now stale (it is on 6268e51f817f "C"); 'sl update-stale' there moves it onto the latest versions
  note: worktree $TESTTMP/stacked is now stale (it is on 12115d535d4a "D"); 'sl update-stale' there moves it onto the latest versions

  $ cd $TESTTMP/clean
  $ sl update-stale
  note: this worktree's commit 6268e51f817f "C" was rewritten in another worktree
  note: moved this worktree to the latest version 0937152ba8f5 "C2"; files changed to match
  $ cat f
  one
  2
  three
  $ sl status
  M f

Ones that conflict stop update-stale with the conflicts marked, the way
unshelve leaves them, rather than reporting success:

  $ cd $TESTTMP/conflict
  $ sl update-stale
  note: this worktree's commit 6268e51f817f "C" was rewritten in another worktree
  note: moved this worktree to the latest version 0937152ba8f5 "C2"; files changed to match
  abort: uncommitted changes conflict with 0937152ba8f5 "C2" in f (they are also kept as shelve 'update-stale-*') (glob)
  (the conflicts are marked in the files; resolve them, run 'sl resolve --mark', then 'sl unshelve --continue')
  [255]
  $ sl status
  M f
  ? f.orig
  $ echo uno > f
  $ echo 2 >> f
  $ echo 3 >> f
  $ sl resolve --mark f
  (no more unresolved files)
  continue: sl unshelve --continue
  $ sl unshelve --continue
  rebasing * "shelve changes to: C" (glob)
  unshelve of 'update-stale-*' complete (glob)
  $ cat f
  uno
  2
  3
  $ sl status
  M f
  ? f.orig
  $ sl shelve --list
  $ sl update-stale
  this worktree is not stale

The same goes for a restack, and with worktree.auto-update-stale the command
that triggered the update does not run:

  $ cd $TESTTMP/stacked
  $ sl commit -qm E --config worktree.auto-update-stale=true
  note: 6268e51f817f "C", below this worktree's commit, was rewritten in another worktree
  note: restacked this worktree's commits onto the latest versions, now on 1430ebce3c52 "D"; files changed to match
  abort: uncommitted changes conflict with 1430ebce3c52 "D" in f (they are also kept as shelve 'update-stale-*') (glob)
  (the conflicts are marked in the files; resolve them, run 'sl resolve --mark', then 'sl unshelve --continue')
  [255]
  $ sl log -r '.^::.' -T '{desc}\n'
  C2
  D

Aborting the unshelve instead keeps the changes in the shelve:

  $ sl unshelve --abort
  rebase aborted
  unshelve of 'update-stale-*' aborted (glob)
  $ sl status
  ? f.orig
  $ sl shelve --list
  update-stale-* shelve changes to: D (glob)

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

  $ sl whereami > /dev/null
