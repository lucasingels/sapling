#require git no-windows no-eden

Test that pushing to an upload ref records no remote bookmark.

  $ . $TESTDIR/git.sh
  $ setconfig remotenames.rename.default=origin remotenames.hoist=origin

  $ setupserver() {
  >   git init -q -b main "$1"
  >   cd "$1"
  >   echo base > base
  >   git add base
  >   git commit -qm base
  >   cd
  > }

On a plain git remote `refs/for/main` is an ordinary ref that the push really
creates, so a remote bookmark for it is correct:

  $ setupserver plain-server
  $ git clone -q plain-server plain-client
  $ cd plain-client
  $ echo a > a
  $ sl commit -Aqm 'change one' -d '0 0'
  $ sl push -q --to refs/for/main -r .
  $ sl log -r . -T '{remotenames}\n'
  origin/refs/for/main

In a Gerrit repo the same ref is write-only: the server turns the push into a
code review change and never creates the ref, so tracking it would leave a name
pointing at something that will never exist, making the commit look landed.

  $ cd
  $ setupserver gerrit-server
  $ git clone -q gerrit-server gerrit-client
  $ cd gerrit-client
  $ setconfig gerrit.url=https://gerrit.example.com
  $ echo a > a
  $ sl commit -Aqm 'change one' -d '0 0'
  $ sl push -q --to refs/for/main -r .
  $ sl log -r . -T '{remotenames}\n'
  

`refs/drafts/*`, which older Gerrit servers use, is treated the same way:

  $ echo b > b
  $ sl commit -Aqm 'change two' -d '0 0'
  $ sl push -q --to refs/drafts/main -r .
  $ sl log -r . -T '{remotenames}\n'
  

An ordinary branch in the same Gerrit repo is still tracked:

  $ sl push -q --to scratch -r .
  $ sl log -r . -T '{remotenames}\n'
  origin/scratch
