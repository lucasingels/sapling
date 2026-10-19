#require git no-windows no-eden

`sl worktree list -Tjson` says what each worktree is up to, the way `prune`
sees it, so that scripts need not run `sl -R <worktree> log/status` per
worktree.

  $ . $TESTDIR/git.sh
  $ setconfig remotenames.rename.default=origin remotenames.hoist=origin
  $ setconfig extensions.shelve= extensions.rebase=

  $ git init -q -b main $TESTTMP/server
  $ cd $TESTTMP/server
  $ echo base > base
  $ git add base
  $ git commit -q -m base
  $ git checkout -q --detach
  $ git clone -q $TESTTMP/server $TESTTMP/repo
  $ cd $TESTTMP/repo
  $ git checkout -q --detach

  $ state() {
  >   sl worktree list -Tjson "$@" | sl debugpython -- -c "
  > import json, os, sys
  > keys = ['finished', 'unfinished', 'drafts', 'shelved', 'missing', 'dirty']
  > for entry in json.load(sys.stdin):
  >     fields = ' '.join(f'{key}={entry[key]}' for key in keys if key in entry)
  >     print(os.path.basename(entry['path']), fields)
  > "
  > }

  $ sl worktree add -q -r origin/main $TESTTMP/fresh --label fresh
  $ for name in stack landed gone rebasing shelved edited away; do
  >   sl worktree add -q -r origin/main $TESTTMP/$name
  > done

"stack" gets two drafts, "landed" one that lands as is, "gone" one that is
then hidden, "rebasing" an interrupted rebase, "shelved" a shelf, "edited" a
change to a tracked file, and "away" is deleted:

  $ cd $TESTTMP/stack
  $ echo 1 > 1
  $ sl commit -qAm 1
  $ echo 2 > 2
  $ sl commit -qAm 2
  $ cd $TESTTMP/landed
  $ echo landed > landed
  $ sl commit -qAm landed
  $ sl push -q -r . --to main
  $ cd $TESTTMP/gone
  $ echo gone > gone
  $ sl commit -qAm gone
  $ cd $TESTTMP/rebasing
  $ echo one > base
  $ sl commit -qm one
  $ sl goto -q 'desc(base)'
  $ echo two > base
  $ sl commit -qm two
  $ sl rebase -q -d 'desc(one)'
  warning: 1 conflicts while merging base! (edit, then use 'sl resolve --mark')
  unresolved conflicts (see sl resolve, then sl rebase --continue)
  [1]
  $ cd $TESTTMP/shelved
  $ echo wip > wip
  $ sl add -q wip
  $ sl shelve -q
  $ echo edited >> $TESTTMP/edited/base
  $ rm -rf $TESTTMP/away
  $ cd $TESTTMP/repo
  $ sl hide -q 'desc(gone)'

The main and the current checkout get no "finished"; a missing worktree gets
no "unfinished" or "drafts":

  $ state
  repo unfinished=False drafts=0 shelved=0 missing=False
  away shelved=0 missing=True
  edited finished=idle unfinished=False drafts=0 shelved=0 missing=False
  fresh finished=idle unfinished=False drafts=0 shelved=0 missing=False
  gone finished=abandoned unfinished=False drafts=1 shelved=0 missing=False
  landed finished=landed unfinished=False drafts=0 shelved=0 missing=False
  rebasing unfinished=True drafts=1 shelved=0 missing=False
  shelved finished=idle unfinished=False drafts=0 shelved=1 missing=False
  stack unfinished=False drafts=2 shelved=0 missing=False

With --status, also which have uncommitted changes; a change to a tracked file
alone is enough:

  $ state --status
  repo unfinished=False drafts=0 shelved=0 missing=False dirty=False
  away shelved=0 missing=True
  edited finished=idle unfinished=False drafts=0 shelved=0 missing=False dirty=True
  fresh finished=idle unfinished=False drafts=0 shelved=0 missing=False dirty=False
  gone finished=abandoned unfinished=False drafts=1 shelved=0 missing=False dirty=False
  landed finished=landed unfinished=False drafts=0 shelved=0 missing=False dirty=False
  rebasing unfinished=True drafts=1 shelved=0 missing=False dirty=True
  shelved finished=idle unfinished=False drafts=0 shelved=1 missing=False dirty=False
  stack unfinished=False drafts=2 shelved=0 missing=False dirty=False

From a linked worktree, that one is the current checkout:

  $ cd $TESTTMP/fresh
  $ state | grep -E '^(fresh|repo) '
  repo unfinished=False drafts=0 shelved=0 missing=False
  fresh unfinished=False drafts=0 shelved=0 missing=False
  $ cd $TESTTMP/repo

A worktree made with plain git that sl never ran in has no status yet; list
says so instead of setting it up:

  $ git worktree add -q --detach $TESTTMP/plain
  $ state --status | grep '^plain '
  plain finished=idle unfinished=False drafts=0 shelved=0 missing=False
  cannot check $TESTTMP/plain for uncommitted changes: sl has not used it yet

`path -Tjson` gives the same entry:

  $ sl worktree path -Tjson --status fresh | grep -E '"(finished|dirty)"'
    "finished": "idle",
    "dirty": false

The plain format stays as it was, and --status is only for list and path:

  $ sl worktree list
  * main    $TESTTMP/repo
    linked  $TESTTMP/away   (missing)
    linked  $TESTTMP/edited
    linked  $TESTTMP/fresh   fresh
    linked  $TESTTMP/gone
    linked  $TESTTMP/landed
    linked  $TESTTMP/plain
    linked  $TESTTMP/rebasing
    linked  $TESTTMP/shelved
    linked  $TESTTMP/stack
  $ sl worktree prune --status
  abort: --status can only be used with 'worktree list' and 'worktree path'
  [255]
