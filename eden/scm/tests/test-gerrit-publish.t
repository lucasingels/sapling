#require git no-windows no-eden

Test that `sl gerrit publish` pushes the stack it was pointed at.

  $ . $TESTDIR/git.sh
  $ setconfig remotenames.rename.default=origin remotenames.hoist=origin

  $ git init -q -b main "$TESTTMP/server"
  $ cd "$TESTTMP/server"
  $ echo base > base
  $ git add base
  $ git commit -qm base
  $ cd
  $ git clone -q "$TESTTMP/server" client
  $ cd client
  $ setconfig gerrit.url=https://gerrit.example.com

Two stacks on the same trunk, with the checkout left on the second one. On a
plain git remote `refs/for/main` is an ordinary ref the push really creates,
so what the server ends up with is what was sent.

  $ echo a1 > a1
  $ sl commit -Aqm 'change a1' -d '0 0'
  $ echo a2 > a2
  $ sl commit -Aqm 'change a2' -d '0 0'
  $ A2=$(sl log -r . -T '{node}')
  $ sl goto -q 'desc(base)'
  $ echo b1 > b1
  $ sl commit -Aqm 'change b1' -d '0 0'

With no revision the stack you are on is what goes up:

  $ sl gerrit publish -q
  $ git -C "$TESTTMP/server" log --format='%s' refs/for/main
  change b1
  base

Given a revision it is that stack instead, even though the checkout has not
moved. Without the revision reaching `sl push` this would publish `change b1`
a second time.

  $ git -C "$TESTTMP/server" update-ref -d refs/for/main
  $ sl gerrit publish -q $A2
  $ git -C "$TESTTMP/server" log --format='%s' refs/for/main
  change a2
  change a1
  base
  $ sl log -r . -T '{desc|firstline}\n'
  change b1

The flags still apply to the revision that was named:

  $ git -C "$TESTTMP/server" update-ref -d refs/for/main
  $ sl gerrit publish -q --wip $A2
  $ git -C "$TESTTMP/server" for-each-ref --format='%(refname)' 'refs/for/*'
  refs/for/main%wip

A second revision is refused rather than silently dropped:

  $ sl gerrit publish $A2 .
  abort: gerrit publish takes at most one revision, got 2
  [255]
