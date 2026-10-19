#require no-eden

Coding agents are detected by the variables they set in the shells they run,
not only by CODING_AGENT_METADATA.

  $ enable amend

  $ newclientrepo
  $ sl debugshell -c 'print(ui.agent())'
  False
  $ CODING_AGENT_METADATA=id=test sl debugshell -c 'print(ui.agent())'
  True
  $ CLAUDECODE=1 sl debugshell -c 'print(ui.agent())'
  True
  $ AI_AGENT=claude-code_2_agent sl debugshell -c 'print(ui.agent())'
  True
  $ CODEX_SANDBOX=seatbelt sl debugshell -c 'print(ui.agent())'
  True
  $ CODEX_SANDBOX_NETWORK_DISABLED=1 sl debugshell -c 'print(ui.agent())'
  True

People set CODEX_HOME and other CODEX_ variables to configure Codex, so only
the ones Codex sets for the commands it runs count. An empty value opts out:

  $ CODEX_HOME=$TESTTMP/codex CODEX_API_KEY=key sl debugshell -c 'print(ui.agent())'
  False
  $ CLAUDECODE= sl debugshell -c 'print(ui.agent())'
  False

Agent mode turns on the agent-only defaults, such as refusing to change an old
version of a commit:

  $ echo a > a
  $ sl commit -qAm original
  $ sl amend -m amended
  $ sl go -q --config checkout.obsolete-mode=ignore 'predecessors(.) - .'
  $ CLAUDECODE=1 sl amend -m again
  abort: changing an old version of a commit will diverge your stack:
  - * -> * (amend) (glob)
  (switch to the newer version listed above, or run 'sl graft' with the old commit hash to deliberately fork it; 'sl sl' shows the latest graph)
  [255]

