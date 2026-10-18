#require no-eden

Test that the gerrit extension joins hard-wrapped body prose as a commit is
written. Gerrit soft-wraps a commit message at 72 columns, so a body filled at
~72-80 renders as a full line, a one-word stub, then the next full line.

  $ eagerepo
  $ enable gerrit rebase
  $ setconfig ui.allowemptycommit=true

Without `gerrit.url` the extension is inert, and the message is kept as typed:

  $ newrepo
  $ sl commit -d '0 0' -m 'gerrit: Subject
  > 
  > A commit body filled at seventy-two columns by an editor shows up in
  > Gerrit as a full line, a one-word stub, then the next full line, because
  > Gerrit soft-wraps at the same width.'
  $ sl log -r . -T '{desc}\n'
  gerrit: Subject
  
  A commit body filled at seventy-two columns by an editor shows up in
  Gerrit as a full line, a one-word stub, then the next full line, because
  Gerrit soft-wraps at the same width.

With `gerrit.url` set, the paragraph is joined into one line. The section
header, the list, the indented continuation and the trailer-like `Type:` line
are left as they are, and the Change-Id is added after unwrapping:

  $ newrepo
  $ setconfig gerrit.url=https://gerrit.example.com
  $ sl commit -d '0 0' -m 'gerrit: Subject
  > 
  > Type: bugfix
  > 
  > Description:
  > A commit body filled at seventy-two columns by an editor shows up in
  > Gerrit as a full line, a one-word stub, then the next full line, because
  > Gerrit soft-wraps at the same width.
  > 
  > - a list item is kept as it is, even when it is long enough to look like
  >   it was filled at seventy-two columns by the same editor'
  $ sl log -r . -T '{desc}\n'
  gerrit: Subject
  
  Type: bugfix
  
  Description:
  A commit body filled at seventy-two columns by an editor shows up in Gerrit as a full line, a one-word stub, then the next full line, because Gerrit soft-wraps at the same width.
  
  - a list item is kept as it is, even when it is long enough to look like
    it was filled at seventy-two columns by the same editor
  
  Change-Id: I5de69cb4bf56b84f76c0eaa7b67477587ba05776

Short lines that stop with room for the next word were broken on purpose and
survive:

  $ sl commit -d '0 0' -m 'gerrit: Short lines
  > 
  > roses are red
  > violets are blue'
  $ sl log -r . -T '{desc}\n'
  gerrit: Short lines
  
  roses are red
  violets are blue
  
  Change-Id: I7cd4ec24ed20216948d52d40f61a1bea42933d97

Rewording unwraps too, since every commit written goes through the same hook:

  $ sl metaedit -d '0 0' -m 'gerrit: Reworded
  > 
  > A commit body filled at seventy-two columns by an editor shows up in
  > Gerrit as a full line, a one-word stub, then the next full line, because
  > Gerrit soft-wraps at the same width.'
  $ sl log -r . -T '{desc}\n'
  gerrit: Reworded
  
  A commit body filled at seventy-two columns by an editor shows up in Gerrit as a full line, a one-word stub, then the next full line, because Gerrit soft-wraps at the same width.
  
  Change-Id: I7cd4ec24ed20216948d52d40f61a1bea42933d97

A message is unwrapped once, when it is written or edited. A joined line can
itself look like a fixed-column fill, so a second pass would join a break left
on purpose; rewriting a commit without touching its message keeps it as it is:

  $ newrepo
  $ setconfig gerrit.url=https://gerrit.example.com
  $ echo base > base
  $ sl commit -Aqm base -d '0 0'
  $ echo work > work
  $ sl commit -Aq -d '0 0' -m 'admin: Update post backend
  > 
  > *Added posts package and basic function outlines for db operations.
  > *Added posts to ops
  > *Updated admin client and server to include posts (I think)
  > *Updated proto files'
  $ sl log -r . -T '{desc}\n'
  admin: Update post backend
  
  *Added posts package and basic function outlines for db operations. *Added posts to ops
  *Updated admin client and server to include posts (I think) *Updated proto files
  
  Change-Id: Id9e17fb9b289afdbcbdf3aef4ebb955bf34007d0
  $ echo more >> work
  $ sl amend -q -d '0 0'
  $ sl bookmark -q admin
  $ sl log -r admin -T '{desc}\n'
  admin: Update post backend
  
  *Added posts package and basic function outlines for db operations. *Added posts to ops
  *Updated admin client and server to include posts (I think) *Updated proto files
  
  Change-Id: Id9e17fb9b289afdbcbdf3aef4ebb955bf34007d0
  $ sl goto -q 'desc(base)'
  $ echo other > other
  $ sl commit -Aqm other -d '0 0'
  $ sl rebase -q -r admin -d .
  $ sl log -r admin -T '{desc}\n'
  admin: Update post backend
  
  *Added posts package and basic function outlines for db operations. *Added posts to ops
  *Updated admin client and server to include posts (I think) *Updated proto files
  
  Change-Id: Id9e17fb9b289afdbcbdf3aef4ebb955bf34007d0

`gerrit.unwrap-prose=False` keeps the body as typed:

  $ setconfig gerrit.unwrap-prose=False
  $ sl commit -d '0 0' -m 'gerrit: Kept
  > 
  > A commit body filled at seventy-two columns by an editor shows up in
  > Gerrit as a full line.' --config gerrit.add-change-id=False
  $ sl log -r . -T '{desc}\n'
  gerrit: Kept
  
  A commit body filled at seventy-two columns by an editor shows up in
  Gerrit as a full line.
