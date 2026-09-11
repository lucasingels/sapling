#require no-eden

Test `sl gerrit view`, `review` and `refresh` against a stand-in server.

  $ eagerepo
  $ enable gerrit
  $ setconfig ui.allowemptycommit=true

A fake `ssh` plays the Gerrit server: it answers `gerrit query` from a file of
one change per line -- the shape Gerrit's `--format=JSON` really has -- and
records everything else so the test can check what was sent. Tests run with a
PATH that has no `grep` or `cat` on it, so it is all shell builtins.

  $ cat > "$TESTTMP/ssh" <<'EOF'
  > #!/bin/sh
  > sent="$*"
  > case "$sent" in
  >   *"gerrit query"*)
  >     while IFS= read -r change; do
  >       case "$sent" in
  >         *change:*)
  >           for word in $sent; do
  >             case "$word" in
  >               change:*)
  >                 case "$change" in
  >                   *"${word#change:}"*) echo "$change" ;;
  >                 esac
  >                 ;;
  >             esac
  >           done
  >           ;;
  >         *) echo "$change" ;;
  >       esac
  >     done < "$TESTTMP/changes.json"
  >     echo '{"type":"stats","rowCount":0}'
  >     ;;
  >   *"gerrit review"*)
  >     echo "sent: $sent" >> "$TESTTMP/calls.log"
  >     while IFS= read -r body || [ -n "$body" ]; do
  >       echo "$body" >> "$TESTTMP/calls.log"
  >     done
  >     ;;
  >   *)
  >     echo "sent: $sent" >> "$TESTTMP/calls.log"
  >     ;;
  > esac
  > EOF
  $ chmod +x "$TESTTMP/ssh"
  $ export PATH=$TESTTMP:$PATH

  $ cat > "$TESTTMP/changes.json" <<'EOF'
  > {"project":"tools/sl","number":101,"subject":"add a thing","owner":{"username":"alice"},"url":"https://gerrit.example.com/101","status":"NEW","lastUpdated":1136214245,"id":"I1111111111111111111111111111111111111111","currentPatchSet":{"number":1,"revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","ref":"refs/changes/01/101/1","approvals":[{"type":"Code-Review","value":"2"},{"type":"Verified","value":"1"}]}}
  > {"project":"tools/sl","number":102,"subject":"add another thing","owner":{"username":"alice"},"url":"https://gerrit.example.com/102","status":"NEW","lastUpdated":1136214245,"id":"I2222222222222222222222222222222222222222","dependsOn":[{"number":101,"open":true}],"currentPatchSet":{"number":1,"revision":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","ref":"refs/changes/02/102/1","approvals":[{"type":"Code-Review","value":"-1"}]}}
  > EOF

  $ newrepo
  $ setconfig gerrit.url=https://gerrit.example.com
  $ setconfig paths.default=ssh://alice@gerrit.example.com:29418/tools/sl

The two commits carry the Change-Ids the server knows those changes by. Real
commits get theirs when they are written; spelling them out here pins what the
server is asked about.

  $ sl commit -d '0 0' -m 'add a thing
  > 
  > Change-Id: I1111111111111111111111111111111111111111'
  $ sl commit -d '0 0' -m 'add another thing
  > 
  > Change-Id: I2222222222222222222222222222222222222222'

`refresh` asks about every draft commit and caches what comes back:

  $ sl gerrit refresh
  refreshing 2 change(s)...
    I11111111111 #101 CR+2 V+1
    I22222222222 #102 CR-1

One commit at a time:

  $ sl gerrit refresh .
  refreshing 1 change(s)...
    I22222222222 #102 CR-1

`review` with no options prints the status and where to find the change:

  $ sl gerrit review
  #102 CR-1 https://gerrit.example.com/c/tools/sl/+/102

  $ sl gerrit review 'desc("add a thing")'
  #101 CR+2 V+1 https://gerrit.example.com/c/tools/sl/+/101

Options send the change to the server rather than printing it:

  $ sl gerrit review -w
  marking #102 as work-in-progress...
  $ sl gerrit review --ready -t bugfix --reviewer bob
  marking #102 as ready for review...
  setting topic 'bugfix' on #102...
  adding reviewer bob to #102...
  $ cat "$TESTTMP/calls.log"
  sent: -p 29418 -o ConnectTimeout=15 alice@gerrit.example.com gerrit review --json 102,1
  {"work_in_progress":true}
  sent: -p 29418 -o ConnectTimeout=15 alice@gerrit.example.com gerrit review --json 102,1
  {"ready":true}
  sent: -p 29418 -o ConnectTimeout=15 alice@gerrit.example.com gerrit set-topic -t bugfix 102
  sent: -p 29418 -o ConnectTimeout=15 alice@gerrit.example.com gerrit set-reviewers -a bob 102

A commit that was never prepared for Gerrit has nothing to review:

  $ sl commit -d '0 0' -m 'not for gerrit' --config gerrit.add-change-id=false
  $ sl gerrit review
  abort: commit * has no Change-Id (glob)
  (it has not been prepared for Gerrit; amend it to add one)
  [255]

`view` draws a user's open changes as a graph, newest first, with each stack
rooted at the branch it is reviewed against. It only looks -- pulling is
`gerrit pull`, so a command that shows you something never moves the checkout:

  $ sl gerrit view -u alice
  open changes for alice:
    o  bbbbbbbbbbbb  2006-01-02  #102  [CR-1]
    │  add another thing
    │
    o  aaaaaaaaaaaa  2006-01-02  #101  [CR+2 V+1]
    │  add a thing
    │
    o  remote/master
    │
    ~
  $ sl gerrit view
  abort: specify a user with --user (-u)
  [255]

`pull` names the change to bring in, rather than prompting for a pick from
whatever `view` last drew:

  $ sl gerrit pull
  abort: specify one change to pull
  [255]
  $ sl gerrit pull 101 102
  abort: specify one change to pull
  [255]
  $ sl gerrit pull 999
  abort: change 999 is not on Gerrit
  [255]

Options belonging to another subcommand are refused rather than ignored:

  $ sl gerrit refresh --wip
  abort: gerrit refresh does not take --wip
  [255]
  $ sl gerrit view -u alice --ready
  abort: gerrit view does not take --ready
  [255]
  $ sl gerrit pull 101 --topic x
  abort: gerrit pull does not take --topic
  [255]
