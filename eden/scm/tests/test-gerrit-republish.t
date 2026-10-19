#require git no-windows no-eden

Test the checks run before commits are uploaded to refs/for/<branch>.

  $ . $TESTDIR/git.sh
  $ setconfig remotenames.rename.default=origin remotenames.hoist=origin
  $ enable rebase

A stand-in for Gerrit. Like the real one, it never creates the refs/for/ ref
that was pushed to: each commit new to it becomes the next patchset of the
change its Change-Id names on that branch, and a push with no new commit in it
is refused as "no new changes". What it has is what `gerrit query` answers
with.

  $ git init -q -b main "$TESTTMP/server"
  $ cd "$TESTTMP/server"
  $ echo base > base
  $ git add base
  $ git commit -qm base
  $ echo 101 > "$TESTTMP/next"
  $ cat > .git/hooks/pre-receive <<'EOF'
  > #!/bin/sh
  > while read old new ref; do
  >   case "$ref" in
  >     refs/for/*)
  >       if [ -z "$(git rev-list "$new" --not --branches --glob=refs/changes)" ]; then
  >         echo "no new changes" >&2
  >         exit 1
  >       fi
  >       ;;
  >   esac
  > done
  > EOF
  $ cat > .git/hooks/post-receive <<'EOF'
  > #!/bin/sh
  > while read old new ref; do
  >   case "$ref" in
  >     refs/for/*)
  >       git update-ref -d "$ref"
  >       branch=${ref#refs/for/}
  >       branch=${branch%%%*}
  >       for commit in $(git rev-list --reverse "$new" --not --branches --glob=refs/changes); do
  >         id=$(git log -1 --format='%(trailers:key=Change-Id,valueonly)' $commit)
  >         subject=$(git log -1 --format=%s $commit)
  >         number=
  >         patchset=0
  >         while IFS= read -r change; do
  >           case "$change" in
  >             *"\"branch\":\"$branch\",\"id\":\"$id\""*)
  >               rest=${change#*\"number\":}
  >               number=${rest%%,*}
  >               rest=${change#*\"currentPatchSet\":\{\"number\":}
  >               patchset=${rest%%,*}
  >               ;;
  >           esac
  >         done < "$TESTTMP/changes.json"
  >         if [ -z "$number" ]; then
  >           read number < "$TESTTMP/next"
  >           echo $((number + 1)) > "$TESTTMP/next"
  >         fi
  >         patchset=$((patchset + 1))
  >         git update-ref refs/changes/$number/$patchset $commit
  >         echo "{\"number\":$number,\"subject\":\"$subject\",\"owner\":{\"username\":\"alice\"},\"status\":\"NEW\",\"branch\":\"$branch\",\"id\":\"$id\",\"currentPatchSet\":{\"number\":$patchset,\"revision\":\"$commit\",\"ref\":\"refs/changes/$number/$patchset\"}}" >> "$TESTTMP/changes.json"
  >         echo "#$number patchset $patchset: $subject ($branch)" >> "$TESTTMP/uploads"
  >       done
  >       ;;
  >   esac
  > done
  > EOF
  $ chmod +x .git/hooks/pre-receive .git/hooks/post-receive
  $ touch "$TESTTMP/changes.json" "$TESTTMP/uploads"

The fake `ssh` serves git and answers queries with what it has for each
change asked for, newest last, as Gerrit does over the same connection.

  $ cat > "$TESTTMP/ssh" <<'EOF'
  > #!/bin/sh
  > if [ -e "$TESTTMP/ssh-down" ]; then
  >   echo "ssh: connect to host gerrit.example.com port 29418: Connection refused" >&2
  >   exit 255
  > fi
  > sent="$*"
  > case "$sent" in
  >   *git-upload-pack*)
  >     exec git-upload-pack "$TESTTMP/server"
  >     ;;
  >   *git-receive-pack*)
  >     exec git-receive-pack "$TESTTMP/server"
  >     ;;
  >   *"gerrit query"*)
  >     for word in $sent; do
  >       case "$word" in
  >         change:*)
  >           while IFS= read -r change; do
  >             case "$change" in
  >               *"\"id\":\"${word#change:}\""*) echo "$change" ;;
  >             esac
  >           done < "$TESTTMP/changes.json"
  >           ;;
  >       esac
  >     done
  >     echo '{"type":"stats","rowCount":0}'
  >     ;;
  > esac
  > EOF
  $ chmod +x "$TESTTMP/ssh"
  $ export PATH=$TESTTMP:$PATH

  $ uploads() {
  >   cat "$TESTTMP/uploads"
  >   : > "$TESTTMP/uploads"
  > }
  $ trunk() {
  >   here="$PWD"
  >   cd "$TESTTMP/server"
  >   echo "$1" > "$1"
  >   git add "$1"
  >   git commit -qm "$1"
  >   cd "$here"
  >   sl pull -q --config gerrit.autorefresh=false
  > }
  $ restack() {
  >   trunk "$1"
  >   sl rebase -q -s 'roots(draft())' -d main
  > }

  $ cd
  $ git clone -q ssh://alice@gerrit.example.com:29418/server client
  $ cd client
  $ setconfig gerrit.url=https://gerrit.example.com

`sl pull` runs git with the environment it started with, from before the fake
`ssh` was put on PATH, so git is told about it directly:

  $ git config core.sshCommand "$TESTTMP/ssh"

A stack of three changes goes up as three patchsets:

  $ for name in a b c; do
  >   echo $name > $name
  >   sl commit -Aqm "change $name" -d '0 0'
  > done
  $ B=`sl log -r 'desc("change b")' -T '{node}'`
  $ sl push -q --to refs/for/main -r .
  $ uploads
  #101 patchset 1: change a (main)
  #102 patchset 1: change b (main)
  #103 patchset 1: change c (main)

Rebase-only patchsets
---------------------

The trunk moves on and the stack is rebased onto it, then the top change is
amended. Only the top change has anything new for review, but the two below it
have new hashes, so pushing it gives them patchsets that only rebase them.
With `gerrit.republish-check=abort` the push is refused, with a rebase that
avoids it:

  $ trunk t1
  $ sl rebase -q -s 'roots(draft())' -d main
  $ echo more >> c
  $ sl amend -q
  $ sl push -q --to refs/for/main -r . --config gerrit.republish-check=abort
  2 changes below the one being pushed would get patchsets that only rebase them:
    * change a (on Gerrit as *) (glob)
    * change b (on Gerrit as *) (glob)
  abort: refusing to upload rebase-only patchsets
  (rebase the rest onto what is on Gerrit with 'sl rebase -s * -d *', then hide the rebased copies with 'sl hide * *'; or pass --force-republish to upload them anyway) (glob)
  [255]
  $ uploads

Following the hint puts the amended change back on what Gerrit already has, so
it is the only one uploaded:

  $ COPIES=`sl log -r "draft() - ::$B - ." -T '{node|short} '`
  $ sl rebase -q -s . -d $B
  warning: creating a child of an old version of a commit will diverge your stack:
  - * -> * (rebase) (glob)
  $ sl hide -q $COPIES
  $ sl push -q --to refs/for/main -r . --config gerrit.republish-check=abort
  $ uploads
  #103 patchset 2: change c (main)

By default it only warns: Gerrit's default copy conditions carry votes over a
trivial rebase, so all it costs is a patchset with nothing to review. When the
commit pushed is itself only rebased, there is nothing else to upload, and the
warning says so:

  $ restack t2
  $ sl push -q --to refs/for/main -r .
  warning: nothing but a rebase to upload: 3 changes would get patchsets that only rebase them:
    * change a (on Gerrit as *) (glob)
    * change b (on Gerrit as *) (glob)
    * change c (on Gerrit as *) (glob)
  $ uploads
  #101 patchset 2: change a (main)
  #102 patchset 2: change b (main)
  #103 patchset 3: change c (main)

With `abort` the same push is refused, and there is no rebase to suggest:

  $ restack t3
  $ sl push -q --to refs/for/main -r . --config gerrit.republish-check=abort
  nothing but a rebase to upload: 3 changes would get patchsets that only rebase them:
    * change a (on Gerrit as *) (glob)
    * change b (on Gerrit as *) (glob)
    * change c (on Gerrit as *) (glob)
  abort: nothing but a rebase to upload
  (pass --force-republish to upload it anyway)
  [255]
  $ uploads

`--force-republish` uploads them anyway, without a word:

  $ sl push -q --to refs/for/main -r . --config gerrit.republish-check=abort --force-republish
  $ uploads
  #101 patchset 3: change a (main)
  #102 patchset 3: change b (main)
  #103 patchset 4: change c (main)

And `off` skips the check:

  $ restack t4
  $ sl push -q --to refs/for/main -r . --config gerrit.republish-check=off
  $ uploads
  #101 patchset 4: change a (main)
  #102 patchset 4: change b (main)
  #103 patchset 5: change c (main)

`sl gerrit publish` takes `--force-republish` too:

  $ restack t5
  $ sl config -q --local gerrit.republish-check abort
  $ sl gerrit publish -q
  nothing but a rebase to upload: 3 changes would get patchsets that only rebase them:
    * change a (on Gerrit as *) (glob)
    * change b (on Gerrit as *) (glob)
    * change c (on Gerrit as *) (glob)
  abort: nothing but a rebase to upload
  (pass --force-republish to upload it anyway)
  [255]
  $ sl gerrit publish -q --force-republish
  $ uploads
  #101 patchset 5: change a (main)
  #102 patchset 5: change b (main)
  #103 patchset 6: change c (main)

A change edited in the middle of a stack is new, and so is everything above
it, since what it sits on changed. Only what is below it is a rebase:

  $ restack t6
  $ sl goto -q 'children(roots(draft()))'
  $ echo more >> b
  $ sl amend -q --rebase
  $ sl goto -q 'max(draft())'
  $ sl push -q --to refs/for/main -r .
  1 change below the one being pushed would get a patchset that only rebases it:
    * change a (on Gerrit as *) (glob)
  abort: refusing to upload rebase-only patchsets
  (rebase the rest onto what is on Gerrit with 'sl rebase -s * -d *', then hide the rebased copies with 'sl hide *'; or pass --force-republish to upload them anyway) (glob)
  [255]
  $ sl push -q --to refs/for/main -r . --force-republish
  $ uploads
  #101 patchset 6: change a (main)
  #102 patchset 6: change b (main)
  #103 patchset 7: change c (main)

Reordering a stack is not a rebase, even though each commit is the same patch
it was: what it sits on is not what it sat on.

  $ RA=`sl log -r 'roots(draft())' -T '{node}'`
  $ RB=`sl log -r 'children(roots(draft()))' -T '{node}'`
  $ RC=`sl log -r 'heads(draft())' -T '{node}'`
  $ sl rebase -q -r $RC -d $RA
  $ sl rebase -q -r $RB -d "children($RA) - $RB"
  $ sl log -r 'draft()' -T '{desc|firstline}\n'
  change a
  change c
  change b
  $ TOP=`sl log -r 'heads(draft())' -T '{node}'`
  $ sl push -q --to refs/for/main -r $TOP
  $ uploads
  #103 patchset 8: change c (main)
  #102 patchset 7: change b (main)
  $ sl config -q --local gerrit.republish-check warn

Duplicate Change-Ids
--------------------

A copy of a change made by hand -- here the top change ported onto the trunk
with its message -- carries the same Change-Id as the original, and whichever
of the two is pushed becomes the change's next patchset. The push is refused
until one of them is gone:

  $ sl log -r $TOP -T '{desc}' > "$TESTTMP/msg"
  $ sl goto -q main
  $ echo ported > b
  $ sl commit -Aq -l "$TESTTMP/msg" -d '0 0'
  $ sl push -q --to refs/for/main -r .
  Change-Id I* is on both * change b (pushed) and * change b (glob)
  abort: the same change is on more than one live commit
  (hide the stale copy with 'sl hide REV' first: Gerrit takes whichever is pushed as the change's next patchset, dropping the other's work)
  [255]

The check can be turned off:

  $ sl push -q --to refs/for/main -r . --config gerrit.check-duplicate-change-ids=false
  $ uploads
  #102 patchset 8: change b (main)
  $ sl hide -q .

Two commits of one stack with the same Change-Id are refused too; Gerrit would
take neither:

  $ sl goto -q 'max(draft())'
  $ echo again > again
  $ sl commit -Aq -l "$TESTTMP/msg" -d '0 0'
  $ sl push -q --to refs/for/main -r .
  Change-Id I* is on two of the commits being pushed, * change b and * change b (glob)
  abort: the same change is on more than one live commit
  (hide the stale copy with 'sl hide REV' first: Gerrit takes whichever is pushed as the change's next patchset, dropping the other's work)
  [255]
  $ sl hide -q .

An older version of a change, still visible under work stacked on it, is not
a second live copy until it is pushed again:

  $ sl goto -q 'roots(draft())'
  $ echo more >> a
  $ sl amend -q --config amend.autorestack=never
  hint[amend-restack]: descendants of * are left behind - use 'sl restack' to rebase them (glob)
  hint[hint-ack]: use 'sl hint --ack amend-restack' to silence these hints
  $ sl push -q --to refs/for/main -r .
  $ uploads
  #101 patchset 7: change a (main)
  $ sl push -q --to refs/for/main -r $TOP
  Change-Id I* is on both * change a (pushed) and * change a (glob)
  abort: the same change is on more than one live commit
  (hide the stale copy with 'sl hide REV' first: Gerrit takes whichever is pushed as the change's next patchset, dropping the other's work)
  [255]
  $ uploads

Other branches
--------------

The same Change-Id on another branch is another change. A stack already up for
review on main, moved unchanged onto a release branch, is a first upload there,
not a republish:

  $ sl config -q --local remotenames.publicheads origin/main,origin/release
  $ git -C "$TESTTMP/server" branch release main~1
  $ sl pull -q -B release --config gerrit.autorefresh=false
  $ sl goto -q main
  $ for name in m1 m2; do
  >   echo $name > $name
  >   sl commit -Aqm "change $name" -d '0 0'
  > done
  $ sl push -q --to refs/for/main -r .
  $ uploads
  #104 patchset 1: change m1 (main)
  #105 patchset 1: change m2 (main)
  $ sl rebase -q -s 'desc("change m1")' -d origin/release
  $ sl push -q --to refs/for/release%topic=backport -r . --config gerrit.republish-check=abort
  $ uploads
  #106 patchset 1: change m1 (release)
  #107 patchset 1: change m2 (release)

"(no new changes)"
-------------------

Pushing a commit again has nothing new in it. Gerrit refuses that as "no new
changes", but when the commit is already the change's current patchset the
change is exactly as asked, so it is not an error:

  $ sl push --to refs/for/release -r .
  remote: no new changes* (glob)
  To ssh://gerrit.example.com:29418/server
   ! [remote rejected] * -> refs/for/release (pre-receive hook declined) (glob)
  error: failed to push some refs to 'ssh://gerrit.example.com:29418/server'
  change #107 already has this commit as its current patchset
  $ uploads

Not when the push carried options: the topic, reviewers or labels it asked for
were never applied.

  $ sl push -q --to 'refs/for/release%topic=again' -r .
  remote: no new changes* (glob)
  To ssh://gerrit.example.com:29418/server
   ! [remote rejected] * -> refs/for/release%topic=again (pre-receive hook declined) (glob)
  error: failed to push some refs to 'ssh://gerrit.example.com:29418/server'
  [1]
  $ sl gerrit publish -q --topic again > /dev/null 2>&1
  [1]

Nor when Gerrit cannot be asked. The push failed, and what the cache last
heard does not say why:

  $ touch "$TESTTMP/ssh-down"
  $ sl push -q --to refs/for/release -r .
  ssh: connect to host gerrit.example.com port 29418: Connection refused
  fatal: Could not read from remote repository.
  
  Please make sure you have the correct access rights
  and the repository exists.
  [128]
  $ rm "$TESTTMP/ssh-down"
