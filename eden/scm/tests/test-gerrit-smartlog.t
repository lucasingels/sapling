#require no-eden

Test that smartlog shows a commit's Gerrit change the way it shows a GitHub
pull request or a Phabricator diff.

  $ eagerepo
  $ enable gerrit smartlog
  $ setconfig ui.allowemptycommit=true

The smartlog templates live in the production config, which tests do not load
unless asked.

  $ export TEST_PROD_CONFIGS=1

  $ cat > "$TESTTMP/ssh" <<'EOF'
  > #!/bin/sh
  > for word in $*; do
  >   case "$word" in
  >     change:*)
  >       while IFS= read -r change; do
  >         case "$change" in
  >           *"${word#change:}"*) echo "$change" ;;
  >         esac
  >       done < "$TESTTMP/changes.json"
  >       ;;
  >   esac
  > done
  > echo '{"type":"stats","rowCount":0}'
  > EOF
  $ chmod +x "$TESTTMP/ssh"
  $ export PATH=$TESTTMP:$PATH

  $ cat > "$TESTTMP/changes.json" <<'EOF'
  > {"number":101,"subject":"approved","status":"NEW","lastUpdated":1136214245,"id":"I1111111111111111111111111111111111111111","currentPatchSet":{"number":1,"revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","approvals":[{"type":"Code-Review","value":"2"},{"type":"Verified","value":"1"}]}}
  > {"number":102,"subject":"rejected","status":"NEW","lastUpdated":1136214245,"id":"I2222222222222222222222222222222222222222","currentPatchSet":{"number":1,"revision":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","approvals":[{"type":"Code-Review","value":"-1"},{"type":"Verified","value":"-1"}]}}
  > {"number":103,"subject":"merged","status":"MERGED","lastUpdated":1136214245,"id":"I3333333333333333333333333333333333333333","currentPatchSet":{"number":1,"revision":"cccccccccccccccccccccccccccccccccccccccc","approvals":[]}}
  > {"number":104,"subject":"wip","status":"NEW","wip":true,"lastUpdated":1136214245,"id":"I4444444444444444444444444444444444444444","currentPatchSet":{"number":1,"revision":"dddddddddddddddddddddddddddddddddddddddd","approvals":[]}}
  > EOF

  $ newrepo
  $ setconfig gerrit.url=https://gerrit.example.com
  $ setconfig paths.default=ssh://alice@gerrit.example.com:29418/tools/sl

  $ for n in 1 2 3 4; do
  >   sl commit -d '0 0' -m "change $n
  > 
  > Change-Id: I${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}"
  > done
  $ sl gerrit refresh -q
    I11111111111 #101 CR+2 V+1
    I22222222222 #102 CR-1 V-1
    I33333333333 #103 MERGED
    I44444444444 #104 WIP

Once the cache knows about a change, the commit that carries its Change-Id
can name it:

  $ sl log -T '{gerrit_repo} {gerrit_change_number} {gerrit_review_state}\n' -r 'desc("change 1")'
  True 101 APPROVED

Each review state picks the text, the color and the CI glyph:

  $ sl log -T '{sl_diffstatus} | {sl_difflabel} | {sl_diffsignal}\n' -r 'all()'
  Approved | ssl.accepted | \xe2\x9c\x93 (esc)
  Changes Requested | ssl.revision | ✗
  Merged | ssl.committed | 
  Work in Progress | ssl.unpublished | 

Plain smartlog shows the change number and the votes, since whether a Gerrit
change has its +2 is the thing worth seeing at a glance:

  $ sl log -T '{sl_diff}\n' -r 'all()'
  #101 [CR+2 V+1]
  #102 [CR-1 V-1]
  #103 [MERGED]
  #104 [WIP]

The change number links to the change:

  $ sl log -T '{gerrit_change_url}\n' -r 'desc("change 1")'
  https://gerrit.example.com/c/tools/sl/+/101

A definition of your own is left alone: the provider only fills the slots
sapling itself shipped, so this shows the Change-Id it was told to and not
the change number:

  $ sl log -T '{sl_difflink}\n' -r 'desc("change 1")' --config templatealias.sl_difflink=gerrit_change_id
  I1111111111111111111111111111111111111111

Without a Gerrit server the keywords are inert and the GitHub and Phabricator
templates are what render:

  $ newrepo
  $ sl commit -d '0 0' -m 'no gerrit here'
  $ sl log -T '[{gerrit_repo}] [{sl_diff}] [{sl_diffstatus}]\n' -r .
  [False] [] []
