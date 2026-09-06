#require no-eden

Test that the gerrit extension adds a Change-Id trailer to new commits.

  $ eagerepo
  $ enable gerrit
  $ setconfig ui.allowemptycommit=true

The Change-Id is derived from the commit's own identity, so pinning the date
makes it reproducible here.

Without `gerrit.url` the extension is inert. It is the same gate ISL uses, and
probing for a Gerrit server would put an SSH round-trip in front of every
command.

  $ newrepo
  $ sl commit -m 'no gerrit here' -d '0 0'
  $ sl log -r . -T '{desc}\n'
  no gerrit here

With `gerrit.url` set, a new commit gets a Change-Id trailer:

  $ newrepo
  $ setconfig gerrit.url=https://gerrit.example.com
  $ sl commit -m 'first commit' -d '0 0'
  $ sl log -r . -T '{desc}\n'
  first commit
  
  Change-Id: Ic7096aaadd551d380a2fa7f95debc94908f5e424

Amending keeps that Change-Id, so Gerrit attaches the amend to the same change
instead of opening a new one:

  $ sl commit --amend -m 'first commit, reworded' -d '0 0'
  $ sl log -r . -T '{desc}\n'
  first commit, reworded
  
  Change-Id: Ic7096aaadd551d380a2fa7f95debc94908f5e424

A different commit gets a different Change-Id:

  $ sl commit -m 'second commit' -d '0 0'
  $ sl log -r . -T '{desc}\n'
  second commit
  
  Change-Id: I630949840a6754f1f28a77bed5b3bacc5518c8bb

The trailer joins an existing trailer block rather than starting a paragraph of
its own, the way git's trailer handling does:

  $ sl commit -d '0 0' -m 'third commit
  > 
  > Signed-off-by: alice'
  $ sl log -r . -T '{desc}\n'
  third commit
  
  Signed-off-by: alice
  Change-Id: Ia8d54c487c5ff78474587754abc7e32a42e6a594

`gerrit.add-change-id=False` turns it off, for repos where Gerrit's own
commit-msg hook is installed:

  $ setconfig gerrit.add-change-id=False
  $ sl commit -m 'no trailer wanted' -d '0 0'
  $ sl log -r . -T '{desc}\n'
  no trailer wanted

A copy is new work rather than a rewrite, so `graft` drops the trailer and the
copy gets its own Change-Id instead of attaching to the source's review:

  $ newrepo
  $ setconfig gerrit.url=https://gerrit.example.com
  $ echo base > base
  $ sl commit -Aqm base -d '0 0'
  $ echo one > one
  $ sl commit -Aqm 'work to copy' -d '0 0'
  $ sl goto -q 'desc(base)'
  $ echo two > two
  $ sl commit -Aqm 'other branch' -d '0 0'
  $ sl graft -q 'desc("work to copy")'
  $ sl log -r 'desc("work to copy")' -T '{desc}\n--\n'
  work to copy
  
  Change-Id: I366783f3ab7dadf8903b21394461c1e091e92405
  --
  work to copy
  
  Change-Id: I9fe08c9b2eadc5b8a1ccf244cb46b3983272d117
  --
