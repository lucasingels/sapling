#require git no-eden

A rewrite moves the other checkouts of a worktree group that it made stale
onto the latest versions, the way it moves its own.

  $ . $TESTDIR/git.sh
  $ setconfig diff.git=true ui.allowemptycommit=true
  $ setconfig amend.autorestack=no-conflict rebase.experimental.inmemory=true
  $ enable rebase shelve

  $ git init -q -b main $TESTTMP/repo
  $ cd $TESTTMP/repo
  $ echo base > base
  $ git add base
  $ git commit -q -m base
  $ git checkout -q --detach
  $ echo a > a
  $ sl commit -qAm A
  $ A=`sl log -r . -T '{node}'`
  $ echo b > b
  $ sl commit -qAm B
  $ B=`sl log -r . -T '{node}'`
  $ echo c > c
  $ sl commit -qAm C
  $ C=`sl log -r . -T '{node}'`

Checkouts on the top and the middle of the stack, one with uncommitted changes
to a file the rewrite does not touch:

  $ sl worktree add -q $TESTTMP/top -r $C
  $ sl worktree add -q $TESTTMP/middle -r $B
  $ echo pending > $TESTTMP/middle/pending
  $ sl --cwd $TESTTMP/middle add -q pending

Amending the bottom of the stack restacks this checkout's commits; the other
checkouts follow, uncommitted changes and all:

  $ sl goto -q $A
  $ echo a2 > a
  $ sl amend -q -m A2
  note: moved worktree $TESTTMP/middle onto the latest versions, now on * "B" (glob)
  note: moved worktree $TESTTMP/top onto the latest versions, now on * "C" (glob)
  $ sl worktree list
  * main    $TESTTMP/repo
    linked  $TESTTMP/middle
    linked  $TESTTMP/top
  $ cat $TESTTMP/top/a $TESTTMP/middle/a
  a2
  a2
  $ sl --cwd $TESTTMP/middle status
  A pending
  $ sl log -G -T '{desc}\n' -r 'draft()'
  o  C
  │
  o  B
  │
  @  A2
  │
  o  base

Rebasing works the same way, and nothing old stays visible for the checkouts:

  $ sl goto -q 'desc(base)'
  $ sl commit -q -m trunk
  $ sl rebase -q -s 'desc(A2)' -d 'desc(trunk)'
  note: moved worktree $TESTTMP/middle onto the latest versions, now on * "B" (glob)
  note: moved worktree $TESTTMP/top onto the latest versions, now on * "C" (glob)
  $ sl log -T '{desc}\n' -r 'obsolete()'

A checkout's own commit on top of a rewritten one is restacked there:

  $ cd $TESTTMP/top
  $ C=`sl log -r . -T '{node}'`
  $ echo d > d
  $ sl commit -qAm D
  $ cd $TESTTMP/repo
  $ sl goto -q $C
  $ sl metaedit -q -m C2
  note: moved worktree $TESTTMP/top onto the latest versions, now on * "D" (glob)
  $ sl -R $TESTTMP/top log -r '.^' -T '{desc}\n'
  C2

A checkout whose uncommitted changes would conflict stays where it is, with its
changes, and is named:

  $ B=`sl -R $TESTTMP/middle log -r . -T '{node}'`
  $ echo mine > $TESTTMP/middle/b
  $ sl goto -q $B
  $ echo theirs > b
  $ sl amend -q -m B2
  note: worktree $TESTTMP/middle is still stale (it is on * "B"): uncommitted changes to b would conflict with the latest versions; left on * "B"; 'sl update-stale' there moves it (glob)
  note: moved worktree $TESTTMP/top onto the latest versions, now on * "D" (glob)
  $ cat $TESTTMP/middle/b
  mine
  $ sl --cwd $TESTTMP/middle status
  M b
  A pending
  note: this worktree's commit * "B" was rewritten in another worktree; 'sl update-stale' moves it onto the latest versions (glob)
  $ sl worktree list
  * main    $TESTTMP/repo
    linked  $TESTTMP/middle   (stale)
    linked  $TESTTMP/top

`update-stale` there still marks the conflicts, as before:

  $ cd $TESTTMP/middle
  $ sl update-stale
  note: this worktree's commit * "B" was rewritten in another worktree (glob)
  note: moved this worktree to the latest version * "B2"; files changed to match (glob)
  abort: uncommitted changes conflict with * "B2" in b (they are also kept as shelve 'update-stale-*') (glob)
  (the conflicts are marked in the files; resolve them, run 'sl resolve --mark', then 'sl unshelve --continue')
  [255]
  $ sl unshelve --abort -q
  rebase aborted
  unshelve of 'update-stale-*' aborted (glob)
  $ sl revert -q -C b
  $ cd $TESTTMP/repo
  $ sl worktree list
  * main    $TESTTMP/repo
    linked  $TESTTMP/middle
    linked  $TESTTMP/top

With worktree.follow-rewrites=false the other checkouts are only listed, and
stay stale until `update-stale` runs in each:

  $ sl goto -q 'desc(A2)'
  $ sl amend -q -m A3 --config worktree.follow-rewrites=false
  note: left * "B2" for worktree $TESTTMP/middle; run 'sl update-stale' there (glob)
  note: left * "D" for worktree $TESTTMP/top; run 'sl update-stale' there (glob)
  $ sl worktree list
  * main    $TESTTMP/repo
    linked  $TESTTMP/middle   (stale)
    linked  $TESTTMP/top   (stale)
  $ sl --cwd $TESTTMP/middle update-stale -q
  note: * "A2", below this worktree's commit, was rewritten in another worktree (glob)
  note: restacked this worktree's commits onto the latest versions, now on * "B2"; files changed to match (glob)
  $ sl --cwd $TESTTMP/top update-stale -q
  note: * "B2", below this worktree's commit, was rewritten in another worktree (glob)
  note: restacked this worktree's commits onto the latest versions, now on * "D"; files changed to match (glob)
  $ sl worktree list
  * main    $TESTTMP/repo
    linked  $TESTTMP/middle
    linked  $TESTTMP/top
