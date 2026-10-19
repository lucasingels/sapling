#require git no-eden

The agent guard on how many commits a revset scans protects lazily fetched
monorepos. A git repo has all of its history locally, so the guard is off
there unless agent.git-fetch-guard is set.

  $ . $TESTDIR/git.sh
  $ setconfig agent.max-commit-fetch-count=2 experimental.commit-fetch-batch-size=1
  $ export CLAUDECODE=1

  $ newclientrepo
  $ drawdag <<'EOS'
  > A1..A3
  > EOS
  $ sl log -r 'desc(A)' -T '{desc}\n'
  A1
  A2
  abort: revset query scanned over 2 commits
  (run 'sl help agent performance' for guidance.)
  [255]

  $ git init -q -b main $TESTTMP/gitrepo
  $ cd $TESTTMP/gitrepo
  $ echo 1 > f
  $ sl commit -qAm G1
  $ echo 2 > f
  $ sl commit -qm G2
  $ echo 3 > f
  $ sl commit -qm G3
  $ sl log -r 'desc(G)' -T '{desc}\n'
  G1
  G2
  G3
  $ sl log -r 'desc(G)' -T '{desc}\n' --config agent.git-fetch-guard=true
  G1
  G2
  abort: revset query scanned over 2 commits
  (run 'sl help agent performance' for guidance.)
  [255]
