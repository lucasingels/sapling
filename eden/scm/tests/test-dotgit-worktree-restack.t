#require git no-eden

A restack in one checkout of a worktree group leaves alone the commits other
checkouts own: the ones they have checked out or stacked their commits on.

  $ . $TESTDIR/git.sh
  $ enable amend rebase
  $ setconfig diff.git=true ui.allowemptycommit=true
  $ setconfig amend.autorestack=no-conflict rebase.experimental.inmemory=true

  $ git init -q -b main $TESTTMP/repo
  $ cd $TESTTMP/repo
  $ echo base > base
  $ git add base
  $ git commit -q -m base
  $ git checkout -q --detach
  $ echo a1 > a
  $ sl commit -qAm A1
  $ sl worktree add -q $TESTTMP/wtA
  $ sl worktree add -q $TESTTMP/wtB
  $ sl goto -q 'desc(base)'

wtA stacks A2 on A1 and goes back to A1; wtB stacks B1 on A1:

  $ cd $TESTTMP/wtA
  $ echo a2 > a2
  $ sl commit -qAm A2
  $ sl goto -q 'desc(A1)'
  $ cd $TESTTMP/wtB
  $ echo b1 > b1
  $ sl commit -qAm B1

Amending A1 in wtA restacks wtA's own A2, but not wtB's B1:

  $ cd $TESTTMP/wtA
  $ echo a1-amended > a
  $ sl amend
  restacking children automatically (unless they conflict)
  rebasing d38c14cf8964 "A2"
  note: left a328b72a036e "B1" for worktree $TESTTMP/wtB; run 'sl update-stale' there
  $ showgraph
  o  fc48ade9b936 A2
  │
  @  188f5c5c35a7 A1
  │
  │ o  a328b72a036e B1
  │ │
  │ x  8842c42d35e7 A1
  ├─╯
  o  d0c915915e68 base

wtB updates itself:

  $ sl worktree list
    main    $TESTTMP/repo
  * linked  $TESTTMP/wtA
    linked  $TESTTMP/wtB   (stale)
  $ cd $TESTTMP/wtB
  $ sl update-stale
  note: 8842c42d35e7 "A1", below this worktree's commit, was rewritten in another worktree
  note: restacked this worktree's commits onto the latest versions, now on c3631a56b2db "B1"; files changed to match
  $ showgraph
  @  c3631a56b2db B1
  │
  │ o  fc48ade9b936 A2
  ├─╯
  o  188f5c5c35a7 A1
  │
  o  d0c915915e68 base

update-stale restacks only the checkout's own commits. With wtA on A2, amending
A1 again in the main checkout without restacking leaves both worktrees stale:

  $ cd $TESTTMP/wtA
  $ sl goto -q 'desc(A2)'
  $ cd $TESTTMP/repo
  $ sl goto -q 'desc(A1) - obsolete()'
  $ echo a1-again > a
  $ sl amend --no-rebase -q
  hint[amend-restack]: descendants of 188f5c5c35a7 are left behind - use 'sl restack' to rebase them
  hint[hint-ack]: use 'sl hint --ack amend-restack' to silence these hints
  note: worktree $TESTTMP/wtA is now stale (it is on fc48ade9b936 "A2"); 'sl update-stale' there moves it onto the latest versions
  note: worktree $TESTTMP/wtB is now stale (it is on c3631a56b2db "B1"); 'sl update-stale' there moves it onto the latest versions
  $ sl goto -q 'desc(base)'
  $ cd $TESTTMP/wtB
  $ sl update-stale
  note: 188f5c5c35a7 "A1", below this worktree's commit, was rewritten in another worktree
  note: restacked this worktree's commits onto the latest versions, now on d004b0dc9d2f "B1"; files changed to match
  $ showgraph
  @  d004b0dc9d2f B1
  │
  o  9fcd6f35a45a A1
  │
  │ o  fc48ade9b936 A2
  │ │
  │ x  188f5c5c35a7 A1
  ├─╯
  o  d0c915915e68 base
  $ cd $TESTTMP/wtA
  $ sl update-stale
  note: 188f5c5c35a7 "A1", below this worktree's commit, was rewritten in another worktree
  note: restacked this worktree's commits onto the latest versions, now on 3c03eb8346ca "A2"; files changed to match
  $ showgraph
  @  3c03eb8346ca A2
  │
  │ o  d004b0dc9d2f B1
  ├─╯
  o  9fcd6f35a45a A1
  │
  o  d0c915915e68 base

`sl restack` (`sl rebase --restack`) leaves the other checkouts' commits too.
wtA stacks A3 on A2, and the main checkout amends A1:

  $ echo a3 > a3
  $ sl commit -qAm A3
  $ cd $TESTTMP/repo
  $ sl goto -q 'desc(A1) - obsolete()'
  $ echo a1-third > a
  $ sl amend --no-rebase -q
  hint[amend-restack]: descendants of 9fcd6f35a45a are left behind - use 'sl restack' to rebase them
  hint[hint-ack]: use 'sl hint --ack amend-restack' to silence these hints
  note: worktree $TESTTMP/wtA is now stale (it is on 997e9be818ce "A3"); 'sl update-stale' there moves it onto the latest versions
  note: worktree $TESTTMP/wtB is now stale (it is on d004b0dc9d2f "B1"); 'sl update-stale' there moves it onto the latest versions
  $ sl rebase --restack
  note: left 997e9be818ce "A3" for worktree $TESTTMP/wtA; run 'sl update-stale' there
  note: left d004b0dc9d2f "B1" for worktree $TESTTMP/wtB; run 'sl update-stale' there
  [1]
  $ showgraph
  @  f880b1b6ead9 A1
  │
  │ o  997e9be818ce A3
  │ │
  │ o  3c03eb8346ca A2
  │ │
  │ │ o  d004b0dc9d2f B1
  │ ├─╯
  │ x  9fcd6f35a45a A1
  ├─╯
  o  d0c915915e68 base

With worktree.restack-foreign=true it restacks them as before:

  $ sl rebase --restack --config worktree.restack-foreign=true
  rebasing 3c03eb8346ca "A2"
  rebasing 997e9be818ce "A3"
  rebasing d004b0dc9d2f "B1"
  note: worktree $TESTTMP/wtA is now stale (it is on 997e9be818ce "A3"); 'sl update-stale' there moves it onto the latest versions
  note: worktree $TESTTMP/wtB is now stale (it is on d004b0dc9d2f "B1"); 'sl update-stale' there moves it onto the latest versions
  $ showgraph
  o  0b577fec20d4 B1
  │
  │ o  58daffde6a0b A3
  │ │
  │ o  970990f3bd4c A2
  ├─╯
  @  f880b1b6ead9 A1
  │
  o  d0c915915e68 base
  $ cd $TESTTMP/wtA
  $ sl update-stale
  note: this worktree's commit 997e9be818ce "A3" was rewritten in another worktree
  note: moved this worktree to the latest version 58daffde6a0b "A3"; files changed to match
  $ cd $TESTTMP/wtB
  $ sl update-stale
  note: this worktree's commit d004b0dc9d2f "B1" was rewritten in another worktree
  note: moved this worktree to the latest version 0b577fec20d4 "B1"; files changed to match

When one child of an amended commit conflicts, the others are still restacked,
and the ones left behind are named:

  $ newclientrepo
  $ echo a > a
  $ sl commit -qAm A
  $ echo conflict > a
  $ sl commit -qm B
  $ sl goto -q 'desc(A)'
  $ echo c > c
  $ sl commit -qAm C
  $ sl goto -q 'desc(A)'
  $ echo amended > a
  $ sl amend
  restacking children automatically (unless they conflict)
  rebasing 8f6cc287b3a0 "B"
  merging a
  restacking 8f6cc287b3a0 "B" would create conflicts (hit merge conflicts in a)
  rebasing 244232c2222a "C"
  left on the old version: 8f6cc287b3a0 "B"
  (run `sl restack` manually to restack them)
  $ showgraph
  o  0feb24c9d0bf C
  │
  @  35be8330be82 A
  
  o  8f6cc287b3a0 B
  │
  x  1994f17a630e A

The same in a worktree group, with worktree.restack-foreign=true, also names the
checkout that has the commit left behind:

  $ git init -q -b main $TESTTMP/conflict
  $ cd $TESTTMP/conflict
  $ echo base > base
  $ git add base
  $ git commit -q -m base
  $ git checkout -q --detach
  $ echo a > a
  $ sl commit -qAm A1
  $ sl worktree add -q $TESTTMP/conflictB
  $ echo c1 > c1
  $ sl commit -qAm C1
  $ sl goto -q 'desc(A1)'
  $ cd $TESTTMP/conflictB
  $ echo conflict > a
  $ sl commit -qm B1
  $ cd $TESTTMP/conflict
  $ echo amended > a
  $ sl amend --config worktree.restack-foreign=true
  restacking children automatically (unless they conflict)
  rebasing 5bd7247c4c47 "C1"
  rebasing 0d59f3c0ec79 "B1"
  merging a
  restacking 0d59f3c0ec79 "B1" would create conflicts (hit merge conflicts in a)
  left on the old version: 0d59f3c0ec79 "B1" (checked out in worktree $TESTTMP/conflictB)
  (run `sl restack` manually to restack them)
  note: worktree $TESTTMP/conflictB is now stale (it is on 0d59f3c0ec79 "B1"); 'sl update-stale' there moves it onto the latest versions
  $ showgraph
  o  3e0fb9acd6f1 C1
  │
  @  389d190ee390 A1
  │
  │ o  0d59f3c0ec79 B1
  │ │
  │ x  b64119a06054 A1
  ├─╯
  o  d0c915915e68 base

In a worktree group with the default config, a conflicting child of the
amended commit leaves only its own subtree behind: the other child of this
checkout still moves, and the other checkouts' commits are left to them:

  $ git init -q -b main $TESTTMP/mixed
  $ cd $TESTTMP/mixed
  $ echo base > base
  $ git add base
  $ git commit -q -m base
  $ git checkout -q --detach
  $ echo a > a
  $ sl commit -qAm A1
  $ sl worktree add -q $TESTTMP/mixedB
  $ sl worktree add -q $TESTTMP/mixedC
  $ echo conflict > a
  $ sl commit -qm A2
  $ sl goto -q 'desc(A1)'
  $ echo a3 > a3
  $ sl commit -qAm A3
  $ sl goto -q 'desc(A1)'
  $ cd $TESTTMP/mixedB
  $ echo b > b
  $ sl commit -qAm B1
  $ cd $TESTTMP/mixedC
  $ echo conflict-c > a
  $ sl commit -qm C1
  $ cd $TESTTMP/mixed
  $ echo amended > a
  $ sl amend
  restacking children automatically (unless they conflict)
  rebasing 20b1a1cf04bc "A2"
  merging a
  restacking 20b1a1cf04bc "A2" would create conflicts (hit merge conflicts in a)
  rebasing 639bad8c3f98 "A3"
  note: left 95b2bafb3606 "B1" for worktree $TESTTMP/mixedB; run 'sl update-stale' there
  note: left e684f22aab3e "C1" for worktree $TESTTMP/mixedC; run 'sl update-stale' there
  left on the old version: 20b1a1cf04bc "A2"
  (run `sl restack` manually to restack them)
  $ showgraph
  o  121a745ac88c A3
  │
  @  389d190ee390 A1
  │
  │ o  e684f22aab3e C1
  │ │
  │ │ o  95b2bafb3606 B1
  │ ├─╯
  │ │ o  20b1a1cf04bc A2
  │ ├─╯
  │ x  b64119a06054 A1
  ├─╯
  o  d0c915915e68 base

update-stale restacks the checkout's own commits only, so the A2 left behind
in the main checkout does not stop mixedB from updating:

  $ cd $TESTTMP/mixedB
  $ sl update-stale
  note: b64119a06054 "A1", below this worktree's commit, was rewritten in another worktree
  note: restacked this worktree's commits onto the latest versions, now on 314ad57c996c "B1"; files changed to match
  $ showgraph
  @  314ad57c996c B1
  │
  │ o  121a745ac88c A3
  ├─╯
  o  389d190ee390 A1
  │
  │ o  e684f22aab3e C1
  │ │
  │ │ o  20b1a1cf04bc A2
  │ ├─╯
  │ x  b64119a06054 A1
  ├─╯
  o  d0c915915e68 base

When the checkout's own commit conflicts with the rewrite, update-stale stops
and changes nothing:

  $ cd $TESTTMP/mixedC
  $ sl update-stale
  note: b64119a06054 "A1", below this worktree's commit, was rewritten in another worktree
  abort: could not restack e684f22aab3e onto the latest versions of the commits below it
  (run 'sl restack' and resolve the conflicts)
  [255]
  $ sl log -r . -T '{node|short} {desc}\n'
  note: b64119a06054 "A1", below this worktree's commit, was rewritten in another worktree; 'sl update-stale' moves it onto the latest versions
  e684f22aab3e C1
  $ sl status
  note: b64119a06054 "A1", below this worktree's commit, was rewritten in another worktree; 'sl update-stale' moves it onto the latest versions

The restack it points to also restacks only this checkout's stack:

  $ sl rebase --restack
  note: b64119a06054 "A1", below this worktree's commit, was rewritten in another worktree; 'sl update-stale' moves it onto the latest versions
  rebasing e684f22aab3e "C1"
  merging a
  hit merge conflicts (in a); switching to on-disk merge
  rebasing e684f22aab3e "C1"
  merging a
  warning: 1 conflicts while merging a! (edit, then use 'sl resolve --mark')
  unresolved conflicts (see sl resolve, then sl rebase --continue)
  [1]
  $ sl log -r 'all() - obsolete()' -T '{desc} ' && echo
  base A2 C1 A1 A3 B1 
  $ sl rebase --abort
  rebase aborted

The main checkout restacks A2, stacked on the old version of its commit:

  $ cd $TESTTMP/mixed
  $ sl rebase --restack
  note: left e684f22aab3e "C1" for worktree $TESTTMP/mixedC; run 'sl update-stale' there
  rebasing 20b1a1cf04bc "A2"
  merging a
  hit merge conflicts (in a); switching to on-disk merge
  rebasing 20b1a1cf04bc "A2"
  merging a
  warning: 1 conflicts while merging a! (edit, then use 'sl resolve --mark')
  unresolved conflicts (see sl resolve, then sl rebase --continue)
  [1]
  $ sl rebase --abort
  rebase aborted

Commits below this checkout's own commit are restacked even when another
checkout is on them, and update-stale passes on the note that the other
checkout is now stale. belowB is on W, belowA on X above it, and the main
checkout amends V below both:

  $ git init -q -b main $TESTTMP/below
  $ cd $TESTTMP/below
  $ echo base > base
  $ git add base
  $ git commit -q -m base
  $ git checkout -q --detach
  $ echo v > v
  $ sl commit -qAm V
  $ echo w > w
  $ sl commit -qAm W
  $ sl worktree add -q $TESTTMP/belowB
  $ echo x > x
  $ sl commit -qAm X
  $ sl worktree add -q $TESTTMP/belowA
  $ sl goto -q 'desc(V)'
  $ echo v2 > v
  $ sl amend --no-rebase -q
  hint[amend-restack]: descendants of b846900c8f1d are left behind - use 'sl restack' to rebase them
  hint[hint-ack]: use 'sl hint --ack amend-restack' to silence these hints
  note: worktree $TESTTMP/belowA is now stale (it is on b03806efcb2d "X"); 'sl update-stale' there moves it onto the latest versions
  note: worktree $TESTTMP/belowB is now stale (it is on 1b13eaddbfa3 "W"); 'sl update-stale' there moves it onto the latest versions
  $ sl goto -q 'desc(base)'
  $ cd $TESTTMP/belowA
  $ sl update-stale
  note: b846900c8f1d "V", below this worktree's commit, was rewritten in another worktree
  note: worktree $TESTTMP/belowB is now stale (it is on 1b13eaddbfa3 "W"); 'sl update-stale' there moves it onto the latest versions
  note: restacked this worktree's commits onto the latest versions, now on 4b983612e24d "X"; files changed to match
  $ showgraph
  @  4b983612e24d X
  │
  o  fdf2c9bacd71 W
  │
  o  c4abc755cc3e V
  │
  o  d0c915915e68 base
  $ sl worktree list
    main    $TESTTMP/below
  * linked  $TESTTMP/belowA
    linked  $TESTTMP/belowB   (stale)

An amend whose only child another checkout owns restacks nothing, and a
checkout on a grandchild owns the child below it too:

  $ git init -q -b main $TESTTMP/grand
  $ cd $TESTTMP/grand
  $ echo base > base
  $ git add base
  $ git commit -q -m base
  $ git checkout -q --detach
  $ echo a > a
  $ sl commit -qAm A1
  $ echo g1 > g1
  $ sl commit -qAm G1
  $ echo g2 > g2
  $ sl commit -qAm G2
  $ sl worktree add -q $TESTTMP/grandG
  $ sl goto -q 'desc(A1)'
  $ echo amended > a
  $ sl amend
  restacking children automatically (unless they conflict)
  note: left 7cb7c46af6a9 "G2" for worktree $TESTTMP/grandG; run 'sl update-stale' there
  $ showgraph
  @  389d190ee390 A1
  │
  │ o  7cb7c46af6a9 G2
  │ │
  │ o  1be5cd455810 G1
  │ │
  │ x  b64119a06054 A1
  ├─╯
  o  d0c915915e68 base

A restack that finds only other checkouts' commits to restack does nothing and
returns 1:

  $ echo again > a
  $ sl amend --no-rebase -q
  $ sl rebase --restack
  note: left 7cb7c46af6a9 "G2" for worktree $TESTTMP/grandG; run 'sl update-stale' there
  [1]
  $ sl rebase --restack --config worktree.restack-foreign=true
  rebasing 1be5cd455810 "G1"
  rebasing 7cb7c46af6a9 "G2"
  note: worktree $TESTTMP/grandG is now stale (it is on 7cb7c46af6a9 "G2"); 'sl update-stale' there moves it onto the latest versions
  $ showgraph
  o  7545b3ea0932 G2
  │
  o  be9876cd556b G1
  │
  @  292ec6ac2755 A1
  │
  o  d0c915915e68 base

Once grandG has updated, there is nothing left to restack:

  $ cd $TESTTMP/grandG
  $ sl update-stale
  note: this worktree's commit 7cb7c46af6a9 "G2" was rewritten in another worktree
  note: moved this worktree to the latest version 7545b3ea0932 "G2"; files changed to match
  $ cd $TESTTMP/grand
  $ sl rebase --restack
  nothing to restack
  [1]
