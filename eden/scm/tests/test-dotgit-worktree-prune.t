#require git no-eden

`sl worktree path` finds a worktree by label; `sl worktree prune` removes the
clean linked worktrees whose commit landed or was abandoned.

  $ . $TESTDIR/git.sh
  $ setconfig diff.git=true ui.allowemptycommit=true
  $ setconfig remotenames.rename.default=origin remotenames.hoist=origin
  $ setconfig extensions.rebase=

Worktrees that only wait to age are covered in test-worktree-git-idle.t:

  $ setconfig worktree.prune-min-age=0

A server, and a clone of it with a stack of draft commits:

  $ git init -q -b main $TESTTMP/server
  $ cd $TESTTMP/server
  $ echo base > base
  $ git add base
  $ git commit -q -m base
  $ git checkout -q --detach
  $ git clone -q $TESTTMP/server $TESTTMP/repo
  $ cd $TESTTMP/repo
  $ git checkout -q --detach
  $ for name in landed here gone rebased stale dirty wip; do
  >   [ $name = here ] || sl goto -q origin/main
  >   echo $name > $name
  >   sl commit -qAm $name
  >   sl worktree add -q $TESTTMP/$name --label $name
  > done
  $ sl goto -q origin/main

`path` prints the path of the worktree with a label:

  $ sl worktree path landed
  $TESTTMP/landed
  $ cd "$(sl worktree path gone)"
  $ sl log -r . -T '{desc}\n'
  gone
  $ sl worktree path nope
  abort: no worktree in this group is labeled 'nope'
  [255]
  $ sl worktree path
  abort: usage: sl worktree path LABEL
  [255]
  $ sl worktree path wip -Tjson | sl debugpython -- -c "
  > import json, sys
  > [entry] = json.load(sys.stdin)
  > print(entry['path'], entry['label'], entry['role'], entry['current'], len(entry['node']))
  > "
  $TESTTMP/wip wip linked False 40

Land some of the work and set other work aside, from the main checkout:

- "landed" and "here", on top of it, are pushed as is;
- "gone" is hidden;
- "rebased" is rewritten, then the new version is pushed;
- "stale" is rewritten, the new version stays a draft;
- "dirty" is rewritten onto main and pushed, but has an untracked file;
- "here" is where prune runs;
- "wip" stays a draft.

  $ cd $TESTTMP/repo
  $ sl push -q -r 'desc(here)' --to main
  $ sl hide -q 'desc(gone)'
  $ sl metaedit -q -r 'desc(rebased)' -m rebased2
  note: moved worktree $TESTTMP/rebased onto the latest versions, now on e70c82320dc1 "rebased2"
  $ sl metaedit -q -r 'desc(stale)' -m stale2 --config worktree.follow-rewrites=false
  note: worktree $TESTTMP/stale is now stale (it is on 55fb0dc47f8e "stale"); 'sl update-stale' there moves it onto the latest versions
  $ sl rebase -q -s 'desc(rebased2)' -d origin/main
  note: moved worktree $TESTTMP/rebased onto the latest versions, now on bde1d966c701 "rebased2"
  $ sl push -q -r 'desc(rebased2)' --to main
  $ sl rebase -q -s 'desc(dirty)' -d origin/main
  note: moved worktree $TESTTMP/dirty onto the latest versions, now on c8fdc753353f "dirty"
  $ sl push -q -r 'desc(dirty)' --to main
  $ echo untracked > $TESTTMP/dirty/untracked
  $ sl worktree list
  * main    $TESTTMP/repo
    linked  $TESTTMP/dirty   dirty
    linked  $TESTTMP/gone   gone
    linked  $TESTTMP/here   here
    linked  $TESTTMP/landed   landed
    linked  $TESTTMP/rebased   rebased
    linked  $TESTTMP/stale   stale   (stale)
    linked  $TESTTMP/wip   wip

`prune --dry-run` lists what would go and why, and removes nothing:

  $ cd $TESTTMP/here
  $ sl worktree prune --dry-run
  keeping $TESTTMP/dirty (landed): it has uncommitted changes
  would remove $TESTTMP/gone (abandoned)
  would remove $TESTTMP/landed (landed)
  would remove $TESTTMP/rebased (landed)
  $ test -d $TESTTMP/landed && test -d $TESTTMP/gone && test -d $TESTTMP/rebased && echo kept
  kept

Without -y, prune asks first:

  $ sl worktree prune
  keeping $TESTTMP/dirty (landed): it has uncommitted changes
  abort: running non-interactively, use -y instead
  [255]

`prune -y` removes them, running the pre-worktree-remove hooks and forgetting
their labels. The main checkout, the current one, a dirty one, a stale one
whose work goes on in a draft, and a draft one stay:

  $ setconfig hooks.pre-worktree-remove="echo pre-remove \$HG_PATH"
  $ sl worktree prune -y
  keeping $TESTTMP/dirty (landed): it has uncommitted changes
  pre-remove $TESTTMP/gone
  removed $TESTTMP/gone (abandoned)
  pre-remove $TESTTMP/landed
  removed $TESTTMP/landed (landed)
  pre-remove $TESTTMP/rebased
  removed $TESTTMP/rebased (landed)
  $ sl worktree list
    main    $TESTTMP/repo
    linked  $TESTTMP/dirty   dirty
  * linked  $TESTTMP/here   here
    linked  $TESTTMP/stale   stale   (stale)
    linked  $TESTTMP/wip   wip
  $ git -C $TESTTMP/repo worktree list --porcelain | grep '^worktree '
  worktree $TESTTMP/repo
  worktree $TESTTMP/dirty
  worktree $TESTTMP/here
  worktree $TESTTMP/stale
  worktree $TESTTMP/wip
  $ sl worktree path landed
  abort: no worktree in this group is labeled 'landed'
  [255]

Nothing is left to prune from here; from the main checkout, "here" goes too:

  $ sl worktree prune -y
  keeping $TESTTMP/dirty (landed): it has uncommitted changes
  no worktrees to prune
  $ cd $TESTTMP/repo
  $ sl worktree prune -y
  keeping $TESTTMP/dirty (landed): it has uncommitted changes
  pre-remove $TESTTMP/here
  removed $TESTTMP/here (landed)

prune with a PATH only looks at that worktree, and says why it stays;
prune takes no --force:

  $ sl worktree prune $TESTTMP/wip
  keeping $TESTTMP/wip: its commit has not landed and was not abandoned
  no worktrees to prune
  $ sl worktree prune --force
  abort: --force cannot be used with 'worktree prune'
  [255]
