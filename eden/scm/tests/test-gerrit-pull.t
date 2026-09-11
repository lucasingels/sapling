#require git no-windows no-eden

Test that `sl gerrit pull` fetches a change and the open changes below it.

  $ . $TESTDIR/git.sh
  $ setconfig remotenames.rename.default=origin remotenames.hoist=origin

The server has a trunk plus two changes uploaded on top of it, the second
depending on the first -- the shape `refs/changes/<nn>/<change>/<patchset>`
that a Gerrit push leaves behind.

  $ git init -q -b main "$TESTTMP/server"
  $ cd "$TESTTMP/server"
  $ echo base > base
  $ git add base
  $ git commit -qm base

The fake `ssh` answers Gerrit queries and also serves git, the way a real
Gerrit does over the same connection and port.

  $ cat > "$TESTTMP/ssh" <<'EOF'
  > #!/bin/sh
  > sent="$*"
  > case "$sent" in
  >   *git-upload-pack*)
  >     exec git-upload-pack "$TESTTMP/server"
  >     ;;
  >   *"gerrit query"*)
  >     for word in $sent; do
  >       case "$word" in
  >         change:*)
  >           while IFS= read -r change; do
  >             case "$change" in
  >               *"\"number\":${word#change:},"*) echo "$change" ;;
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

Cloning over that same fake `ssh` gives the client a Gerrit-shaped origin and,
unlike a local clone, no shortcut to the server's objects -- so the pull below
really has to fetch.

  $ cd
  $ git clone -q ssh://alice@gerrit.example.com:29418/server client
  $ cd client
  $ setconfig gerrit.url=https://gerrit.example.com
  $ sl log -r 'all()' -T '{desc|firstline}\n'
  base

The two changes are uploaded only after the clone below has its own copy of
the trunk, so pulling one really has to go back to the server for it.

  $ cd "$TESTTMP/server"
  $ echo one > one
  $ git add one
  $ git commit -qm 'change one'
  $ git update-ref refs/changes/01/101/1 HEAD
  $ echo two > two
  $ git add two
  $ git commit -qm 'change two'
  $ git update-ref refs/changes/02/102/1 HEAD
  $ git reset -q --hard main

  $ ONE=`git rev-parse refs/changes/01/101/1`
  $ TWO=`git rev-parse refs/changes/02/102/1`
  $ cat > "$TESTTMP/changes.json" <<EOF
  > {"number":101,"subject":"change one","owner":{"username":"alice"},"status":"NEW","id":"I1111111111111111111111111111111111111111","currentPatchSet":{"number":1,"revision":"$ONE","ref":"refs/changes/01/101/1"}}
  > {"number":102,"subject":"change two","owner":{"username":"alice"},"status":"NEW","id":"I2222222222222222222222222222222222222222","dependsOn":[{"number":101,"open":true}],"currentPatchSet":{"number":1,"revision":"$TWO","ref":"refs/changes/02/102/1"}}
  > EOF

Pulling the top change brings the one it depends on with it, since the change
does not apply without it, and leaves the checkout on top:

  $ cd "$TESTTMP/client"
  $ sl gerrit pull 102
    #101 change one
    #102 change two
  fetching a stack of 2 change(s)...
  From ssh://gerrit.example.com:29418/server
   * [new ref]         refs/changes/02/102/1 -> refs/visibleheads/* (glob)
  bookmarking gerrit/101 at the base of the stack...
  checking out * (glob)
  update complete
  $ sl log -r 'all()' -T '{desc|firstline} {bookmarks}\n'
  base 
  change one gerrit/101
  change two gerrit/101-tip
  $ sl log -r . -T '{desc|firstline}\n'
  change two

A change the server does not have is an error, not an empty pull:

  $ sl gerrit pull 999
  abort: change 999 is not on Gerrit
  [255]

Local work built on a stack is carried onto the new patchset when the stack is
pulled again, rather than left behind on the patchset it was written against:

  $ echo local > local
  $ sl commit -Aqm 'local work'

  $ cd "$TESTTMP/server"
  $ git checkout -q refs/changes/02/102/1
  $ echo more >> two
  $ git add two
  $ git commit -qm 'change two, take two'
  $ git update-ref refs/changes/02/102/2 HEAD
  $ git checkout -q main
  $ TWO2=`git rev-parse refs/changes/02/102/2`
  $ cat > "$TESTTMP/changes.json" <<EOF
  > {"number":101,"subject":"change one","owner":{"username":"alice"},"status":"NEW","id":"I1111111111111111111111111111111111111111","currentPatchSet":{"number":1,"revision":"$ONE","ref":"refs/changes/01/101/1"}}
  > {"number":102,"subject":"change two","owner":{"username":"alice"},"status":"NEW","id":"I2222222222222222222222222222222222222222","dependsOn":[{"number":101,"open":true}],"currentPatchSet":{"number":2,"revision":"$TWO2","ref":"refs/changes/02/102/2"}}
  > EOF

  $ cd "$TESTTMP/client"
  $ sl gerrit pull 102
    #101 change one
    #102 change two
  fetching a stack of 2 change(s)...
  From ssh://gerrit.example.com:29418/server
   * [new ref]         refs/changes/02/102/2 -> refs/visibleheads/* (glob)
  bookmarking gerrit/101 at the base of the stack...
  rebasing local work onto the updated stack...
  rebasing * "local work" (glob)
  checking out * (glob)
  update complete

The patchset the local work was written against is still in the graph, as any
superseded draft is; what matters is that the local commit moved off it:

  $ sl log -r 'all()' -T '{desc|firstline} {bookmarks}\n'
  base 
  change one gerrit/101
  change two 
  change two, take two gerrit/101-tip
  local work 
  $ sl log -r . -T '{desc|firstline}\n'
  local work
