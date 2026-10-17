#require git no-eden unix-permissions no-root

Linked worktrees write to the main checkout's shared store and locks. When the
process may not write there (for example, a sandbox that only allows writes to
the worktree), sl must name the file it could not write, and must not call the
store corrupted or suggest repairing it.

  $ . $TESTDIR/git.sh
  $ git init -q -b main $TESTTMP/repo
  $ cd $TESTTMP/repo
  $ echo a > a
  $ git add a
  $ git commit -q -m commit1
  $ sl worktree add $TESTTMP/wt
  created linked worktree at $TESTTMP/wt
  $ cd $TESTTMP/wt
  $ echo b > b
  $ sl commit -Aqm wt1
  $ echo c > c
  $ sl add c

  >>> import os
  >>> def chmodtree(top, writable):
  ...     for root, dirs, files in os.walk(top):
  ...         for name in files:
  ...             os.chmod(os.path.join(root, name), 0o644 if writable else 0o444)
  ...         os.chmod(root, 0o755 if writable else 0o555)
  >>> store = os.path.join(os.environ["TESTTMP"], "repo", ".git", "sl", "store")

A read-only metalog is reported as a permission error on the file indexedlog
tried to open, not as "internal storage is corrupted":

  >>> chmodtree(os.path.join(store, "metalog"), False)
  $ sl commit -m wt2
  abort: Permission denied: $TESTTMP/repo/.git/sl/store/metalog/roots/rlock
  (current process runs with uid 42)
  ($TESTTMP/repo/.git/sl/store/metalog/roots/rlock: mode 0o52, uid 42, gid 42)
  ($TESTTMP/repo/.git/sl/store/metalog/roots: mode 0o52, uid 42, gid 42)
  (is sl running in a sandbox that blocks writes to $TESTTMP/repo/.git/sl?)
  [255]
  >>> chmodtree(os.path.join(store, "metalog"), True)

Same for the commit graph segments, which used to print the raw error chain:

  >>> chmodtree(os.path.join(store, "segments"), False)
  $ sl commit -m wt2
  abort: Permission denied: $TESTTMP/repo/.git/sl/store/segments/v1/rlock
  (current process runs with uid 42)
  ($TESTTMP/repo/.git/sl/store/segments/v1/rlock: mode 0o52, uid 42, gid 42)
  ($TESTTMP/repo/.git/sl/store/segments/v1: mode 0o52, uid 42, gid 42)
  (is sl running in a sandbox that blocks writes to $TESTTMP/repo/.git/sl?)
  [255]
  >>> chmodtree(os.path.join(store, "segments"), True)

The shared store lock:

  >>> for name in ["lock.lock", "lock.data"]:
  ...     os.chmod(os.path.join(store, name), 0o444)
  $ sl commit -m wt2
  abort: could not lock repository $TESTTMP/wt: failed to open file `$TESTTMP/repo/.git/sl/store/lock.lock`: Permission denied (os error 13)
  (is sl running in a sandbox that blocks writes to $TESTTMP/repo/.git/sl?)
  [255]
  >>> for name in ["lock.lock", "lock.data"]:
  ...     os.chmod(os.path.join(store, name), 0o644)

A store directory that does not allow new files names the full path:

  >>> os.chmod(store, 0o555)
  $ sl commit -m wt2
  abort: Permission denied: $TESTTMP/repo/.git/sl/store/journal.bookmarks
  (current process runs with uid 42)
  ($TESTTMP/repo/.git/sl/store/journal.bookmarks: mode 0o52, uid 42, gid 42)
  ($TESTTMP/repo/.git/sl/store: mode 0o52, uid 42, gid 42)
  (is sl running in a sandbox that blocks writes to $TESTTMP/repo/.git/sl?)
  [255]
  >>> os.chmod(store, 0o755)

With write access back, the commit goes through:

  $ sl commit -m wt2
  $ sl log -r . -T '{desc}\n'
  wt2
