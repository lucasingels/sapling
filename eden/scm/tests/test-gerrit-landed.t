#require git no-windows no-eden

Test that a pull marks drafts as landed once Gerrit has submitted them.

  $ . $TESTDIR/git.sh
  $ setconfig remotenames.rename.default=origin remotenames.hoist=origin
  $ enable rebase

The server stands in for Gerrit only as far as uploads go: like Gerrit, it
never keeps the refs/for/ ref that was pushed to.

  $ git init -q -b main "$TESTTMP/server"
  $ cd "$TESTTMP/server"
  $ echo base > base
  $ git add base
  $ git commit -qm base
  $ cat > .git/hooks/post-receive <<'EOF'
  > #!/bin/sh
  > while read old new ref; do
  >   case "$ref" in
  >     refs/for/*) git update-ref -d "$ref" ;;
  >   esac
  > done
  > EOF
  $ chmod +x .git/hooks/post-receive

Gerrit submits a change by putting a new commit on the branch, carrying the
change's message -- and with it the Change-Id -- but not its hash, and not
necessarily its content: a reviewer may have amended it, or it may have been
rebased past someone else's work.

  $ land() {
  >   here="$PWD"
  >   sl log -r "$1" -T '{desc}' > "$TESTTMP/msg"
  >   cd "$TESTTMP/server"
  >   echo "$3" > "$2"
  >   git add "$2"
  >   git commit -qF "$TESTTMP/msg"
  >   cd "$here"
  > }
  $ trunk() {
  >   here="$PWD"
  >   cd "$TESTTMP/server"
  >   echo "$1" > "$1"
  >   git add "$1"
  >   git commit -qm "$1"
  >   cd "$here"
  > }
  $ newclient() {
  >   git clone -q "$TESTTMP/server" "$TESTTMP/$1"
  >   cd "$TESTTMP/$1"
  >   sl config -q --local gerrit.url https://gerrit.example.com
  >   sl config -q --local gerrit.autorefresh false
  > }
  $ commit() {
  >   echo "$1" > "$1"
  >   sl commit -Aqm "change $1" -d '0 0'
  > }

Landing as amended in review
----------------------------

A stack of three changes, uploaded for review:

  $ newclient client
  $ commit one
  $ commit two
  $ commit three
  $ ONE=`sl log -r 'desc("change one")' -T '{node}'`
  $ TWO=`sl log -r 'desc("change two")' -T '{node}'`
  $ sl push -q --to refs/for/main -r .

The first is submitted after someone else's work, as the reviewer amended it:

  $ trunk other
  $ land $ONE one 'one, as amended in review'

Nothing has landed as far as this repo knows until the pull brings it in:

  $ sl debuggerritmarker --dry-run
  no landed commits found

With the marker turned off, a pull leaves the local copy live alongside the
commit that landed:

  $ sl pull -q --config gerrit.hide-landed-commits=false
  $ sl log -r 'draft() - obsolete()' -T '{desc|firstline}\n'
  change one
  change two
  change three

`debuggerritmarker` finds it by Change-Id. The draft is what was uploaded, so
whatever differs in what landed was changed in review, and hiding it loses
nothing:

  $ sl debuggerritmarker --dry-run
  would mark * landed as * (glob)
  $ sl debuggerritmarker
  marked 1 commit as landed

The draft is now a predecessor of the commit that landed, which is what rebase,
smartlog and `sl worktree prune` follow:

  $ sl log -r "successors($ONE)" --hidden -T '{desc|firstline} {phase}\n'
  change one public
  change one draft
  $ sl log -r "$ONE" --hidden -T '{mutations % "{operation}\n"}'
  land
  $ sl debuggerritmarker
  no landed commits found

`pull --rebase`
---------------

A pull does the same by itself, and before `pull --rebase` rebases. The second
change lands with an amendment the third does not apply cleanly on top of a
replay of: replaying the local copy of a landed change is what conflicted, and
what made agents grep for Change-Ids by hand. Marked first, it is skipped:

  $ land $TWO two 'two, as amended in review'
  $ sl pull --rebase -d main
  pulling from $TESTTMP/server
  From $TESTTMP/server
     *  * -> origin/main (glob)
  marked 1 commit as landed
  note: not rebasing *, already in destination as * "change one" (glob)
  note: not rebasing *, already in destination as * "change two" (origin/main main) (glob)
  rebasing * "change three" (glob)
  $ sl log -r 'all()' -T '{desc|firstline} {phase}\n' -G
  @  change three draft
  │
  o  change two public
  │
  o  change one public
  │
  o  other public
  │
  o  base public
  
  $ cat two
  two, as amended in review

That went through remotenames' `pull --rebase`. Without tracking, tweakdefaults
does the rebase instead, and marks first too. The third change lands as the
rebased copy of what was uploaded, which counts as uploaded:

  $ THREE=`sl log -r . -T '{node}'`
  $ commit four
  $ land $THREE three 'three, as amended in review'
  $ sl pull -q --rebase -d main --config remotenames.tracking=false
  $ sl log -r 'draft()' -T '{desc|firstline}\n'
  change four
  $ cat three
  three, as amended in review

Drafts written on an older trunk
--------------------------------

A draft is looked for above the trunk commit it was written on, not the newest
one any draft is on:

  $ newclient older
  $ commit five
  $ FIVE=`sl log -r . -T '{node}'`
  $ sl push -q --to refs/for/main -r .
  $ land $FIVE five five
  $ trunk t1
  $ sl pull -q --config gerrit.hide-landed-commits=false
  $ sl goto -q main
  $ commit six

Only the newest `gerrit.landed-scan-limit` public commits are read, so a limit
of one stops short of where the change landed:

  $ sl debuggerritmarker --dry-run --config gerrit.landed-scan-limit=1
  no landed commits found
  $ sl debuggerritmarker --dry-run
  would mark * landed as * (glob)

Local work that was never uploaded
----------------------------------

A draft amended after it was uploaded holds work that is in no patchset, so
the landed commit does not have it. Hiding it would lose that work:

  $ newclient amended
  $ commit seven
  $ SEVEN=`sl log -r . -T '{node}'`
  $ sl push -q --to refs/for/main -r .
  $ land $SEVEN seven seven
  $ echo 'more work' >> seven
  $ sl amend -q
  $ sl pull -q
  change I* landed as *; * has local changes not in it, not hiding (glob)
  $ sl log -r 'draft() - obsolete()' -T '{desc|firstline}\n'
  change seven

Several copies of a change
--------------------------

Two live drafts can carry one Change-Id, as when a change is ported by hand.
Both land with it, the copy because it is the same patch as what landed:

  $ newclient copies
  $ commit eight
  $ sl push -q --to refs/for/main -r .
  $ sl log -r . -T '{desc}' > "$TESTTMP/msg8"
  $ EIGHT=`sl log -r . -T '{node}'`
  $ trunk t2
  $ sl pull -q --config gerrit.hide-landed-commits=false
  $ sl goto -q main
  $ echo eight > eight
  $ sl commit -Aq -l "$TESTTMP/msg8" -d '0 0'
  $ CID8=`sl log -r $EIGHT -T '{gerrit_change_id}'`
  $ sl log -r "draft() & desc('$CID8')" -T '{desc|firstline}\n'
  change eight
  change eight
  $ land $EIGHT eight eight
  $ sl pull
  pulling from $TESTTMP/server
  From $TESTTMP/server
     *  * -> origin/main (glob)
  marked 2 commits as landed
  $ sl log -r 'draft() - obsolete()' -T '{desc|firstline}\n'

Other branches, and Change-Ids that are not the commit's own
-------------------------------------------------------------

The same Change-Id cherry-picked to another branch is another change there;
the one under review for main has not landed:

  $ newclient branches
  $ sl config -q --local remotenames.publicheads origin/main,origin/release
  $ commit nine
  $ sl push -q --to refs/for/main -r .
  $ NINE=`sl log -r . -T '{node}'`
  $ cd "$TESTTMP/server"
  $ git checkout -q -b release
  $ cd "$TESTTMP/branches"
  $ land $NINE nine nine
  $ cd "$TESTTMP/server"
  $ git checkout -q main
  $ cd "$TESTTMP/branches"
  $ sl pull -q -B release
  $ sl log -r 'desc("change nine") & public()' -T '{remotenames}\n'
  origin/release
  $ sl debuggerritmarker --dry-run
  no landed commits found

Nor is a Change-Id that a commit only quotes in its body, or one of two in a
footer that Gerrit would have refused:

  $ CID9=`sl log -r $NINE -T '{gerrit_change_id}'`
  $ cat > "$TESTTMP/msg" <<EOF
  > quote it
  > 
  > This is about
  > Change-Id: $CID9
  > 
  > Change-Id: I0000000000000000000000000000000000000001
  > EOF
  $ git -C "$TESTTMP/server" commit -q --allow-empty -F "$TESTTMP/msg"
  $ cat > "$TESTTMP/msg" <<EOF
  > two ids
  > 
  > Change-Id: $CID9
  > Change-Id: I0000000000000000000000000000000000000002
  > EOF
  $ git -C "$TESTTMP/server" commit -q --allow-empty -F "$TESTTMP/msg"
  $ sl pull -q
  $ sl debuggerritmarker --dry-run
  no landed commits found
  $ sl log -r 'draft() - obsolete()' -T '{desc|firstline}\n'
  change nine

Other worktrees
---------------

A landed draft that another worktree has checked out, or has work stacked on,
is hidden like any other, and once the pull is done that worktree is moved onto
what landed, uncommitted changes and all, as after any rewrite:

  $ newclient wt
  $ commit w1
  $ W1=`sl log -r . -T '{node}'`
  $ sl goto -q main
  $ commit x1
  $ X1=`sl log -r . -T '{node}'`
  $ commit x2
  $ sl push -q --to refs/for/main -r $W1
  $ sl push -q --to refs/for/main -r .
  $ sl goto -q $W1
  $ sl worktree add -q "$TESTTMP/wt-b"
  $ sl goto -q 'desc("change x2")'
  $ sl worktree add -q "$TESTTMP/wt-c"
  $ sl goto -q main
  $ echo pending > "$TESTTMP/wt-b/pending"
  $ sl --cwd "$TESTTMP/wt-b" add -q pending
  $ land $W1 w1 w1
  $ land $X1 x1 x1
  $ sl pull -q
  note: moved worktree $TESTTMP/wt-b onto the latest versions, now on * "change w1" (glob)
  note: moved worktree $TESTTMP/wt-c onto the latest versions, now on * "change x2" (glob)
  $ sl log -r 'draft() - obsolete()' -T '{desc|firstline}\n'
  change x2
  $ sl -R "$TESTTMP/wt-b" log -r . -T '{phase}\n'
  public
  $ sl --cwd "$TESTTMP/wt-b" status
  A pending
  $ sl -R "$TESTTMP/wt-c" log -r '.^' -T '{phase} {desc|firstline}\n'
  public change x1

With worktree.follow-rewrites=false, a worktree may be in the middle of work on
the landed draft it has checked out, and hiding the draft would make it stale
under whoever is working there, so the draft is left visible and the worktree
named. A landed draft that a worktree only has work stacked on is hidden, and
that worktree is noted stale:

  $ newclient wtoff
  $ setconfig worktree.follow-rewrites=false
  $ commit v1
  $ V1=`sl log -r . -T '{node}'`
  $ sl goto -q main
  $ commit y1
  $ Y1=`sl log -r . -T '{node}'`
  $ commit y2
  $ sl push -q --to refs/for/main -r $V1
  $ sl push -q --to refs/for/main -r .
  $ sl goto -q $V1
  $ sl worktree add -q "$TESTTMP/wtoff-b"
  $ sl goto -q 'desc("change y2")'
  $ sl worktree add -q "$TESTTMP/wtoff-c"
  $ sl goto -q main
  $ echo pending > "$TESTTMP/wtoff-b/pending"
  $ land $V1 v1 v1
  $ land $Y1 y1 y1
  $ sl pull -q
  change I* landed as *; not hiding *, which worktree $TESTTMP/wtoff-b has checked out (glob)
  note: worktree $TESTTMP/wtoff-c is now stale (it is on * "change y2"); 'sl update-stale' there moves it onto the latest versions (glob)
  $ sl log -r 'draft() - obsolete()' -T '{desc|firstline}\n'
  change v1
  change y2

The worktree with the draft checked out carries on as before:

  $ cd "$TESTTMP/wtoff-b"
  $ sl commit -Aqm 'more on v1'
  $ sl log -r . -T '{desc|firstline}\n'
  more on v1
  $ setconfig worktree.follow-rewrites=true

Turned off, and outside Gerrit
------------------------------

  $ newclient quiet
  $ sl config -q --local gerrit.hide-landed-commits false
  $ commit ten
  $ sl push -q --to refs/for/main -r .
  $ TEN=`sl log -r . -T '{node}'`
  $ land $TEN ten ten
  $ sl pull -q
  $ sl log -r 'draft() - obsolete()' -T '{desc|firstline}\n'
  change ten

Without `gerrit.url` the repo is not a Gerrit one, and a commit that happens to
carry a Change-Id is left alone:

  $ git clone -q "$TESTTMP/server" "$TESTTMP/plain"
  $ cd "$TESTTMP/plain"
  $ echo eleven > eleven
  $ cat > "$TESTTMP/msg11" <<EOF
  > change eleven
  > 
  > Change-Id: I0000000000000000000000000000000000000011
  > EOF
  $ sl commit -Aq -l "$TESTTMP/msg11" -d '0 0'
  $ land . eleven eleven
  $ sl pull -q
  $ sl log -r 'draft() - obsolete()' -T '{desc|firstline}\n'
  change eleven
  $ sl debuggerritmarker
  abort: this is not a Gerrit repo (gerrit.url is not set)
  [255]
