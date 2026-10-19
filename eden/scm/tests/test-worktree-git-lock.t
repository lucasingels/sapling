#require git no-windows no-eden

A worktree locked with `git worktree lock` is in use, e.g. by an agent:
`sl worktree` shows the lock and never removes it.

  $ . $TESTDIR/git.sh
  $ setconfig remotenames.rename.default=origin remotenames.hoist=origin

  $ git init -q -b main $TESTTMP/server
  $ cd $TESTTMP/server
  $ echo base > base
  $ git add base
  $ git commit -q -m base
  $ git checkout -q --detach
  $ git clone -q $TESTTMP/server $TESTTMP/repo
  $ cd $TESTTMP/repo
  $ git checkout -q --detach

Worktrees on a commit that then lands; "away" is also deleted:

  $ echo work > work
  $ sl commit -qAm work
  $ for name in agent bare free away; do
  >   sl worktree add -q $TESTTMP/$name --label $name
  > done
  $ sl push -q -r . --to main
  $ git worktree lock --reason claude-session:1234 $TESTTMP/agent
  $ git worktree lock $TESTTMP/bare
  $ git worktree lock --reason on-usb $TESTTMP/away
  $ rm -rf $TESTTMP/away

`list` shows the locks:

  $ sl worktree list
  * main    $TESTTMP/repo
    linked  $TESTTMP/agent   agent   (locked)
    linked  $TESTTMP/away   away   (missing)   (locked)
    linked  $TESTTMP/bare   bare   (locked)
    linked  $TESTTMP/free   free
  $ sl worktree list -Tjson | sl debugpython -- -c "
  > import json, os, sys
  > for entry in json.load(sys.stdin):
  >     print(os.path.basename(entry['path']), entry['locked'], entry.get('lock_reason'))
  > "
  repo False None
  agent True claude-session:1234
  away True on-usb
  bare True None
  free False None

`prune` skips locked worktrees, missing ones included, instead of failing on
them:

  $ sl worktree prune --dry-run
  keeping $TESTTMP/agent (landed): it is locked (claude-session:1234)
  keeping $TESTTMP/away (missing): it is locked (on-usb)
  keeping $TESTTMP/bare (landed): it is locked
  would remove $TESTTMP/free (landed)
  $ sl worktree prune -y
  keeping $TESTTMP/agent (landed): it is locked (claude-session:1234)
  keeping $TESTTMP/away (missing): it is locked (on-usb)
  keeping $TESTTMP/bare (landed): it is locked
  removed $TESTTMP/free (landed)

`remove` refuses a locked worktree with an sl message, not git's:

  $ sl worktree remove -y $TESTTMP/agent
  abort: $TESTTMP/agent is locked (claude-session:1234); unlock it with `git worktree unlock $TESTTMP/agent` first
  [255]
  $ sl worktree remove -y --force $TESTTMP/bare
  abort: $TESTTMP/bare is locked; unlock it with `git worktree unlock $TESTTMP/bare` first
  [255]
  $ sl worktree remove -y $TESTTMP/away
  abort: $TESTTMP/away is locked (on-usb); unlock it with `git worktree unlock $TESTTMP/away` first
  [255]

`add` does not replace a missing worktree that is locked:

  $ sl worktree add -q $TESTTMP/away
  abort: $TESTTMP/away is a missing but locked worktree (on-usb); unlock it with `git worktree unlock $TESTTMP/away` first
  [255]

`remove --all` keeps locked worktrees:

  $ sl worktree remove --all -y
  keeping $TESTTMP/agent: it is locked (claude-session:1234)
  keeping $TESTTMP/away: it is locked (on-usb)
  keeping $TESTTMP/bare: it is locked
  no linked worktrees to remove

Once unlocked, they go like any other:

  $ git worktree unlock $TESTTMP/agent
  $ git worktree unlock $TESTTMP/bare
  $ git worktree unlock $TESTTMP/away
  $ sl worktree prune -y
  removed $TESTTMP/agent (landed)
  removed $TESTTMP/away (missing)
  removed $TESTTMP/bare (landed)
  $ sl worktree list
  * main    $TESTTMP/repo
