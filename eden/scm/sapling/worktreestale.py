# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed according to the terms of the
# GNU General Public License version 2.

"""stale checkouts of a git worktree group

The checkouts of a worktree group share their commits. Rewriting a commit
(amend, rebase, restack, ...) only moves the checkout running the command.
Another checkout that has the old version checked out, or its own commits
stacked on it, is then stale, the way jj marks a workspace stale when another
workspace rewrites its working-copy commit.

Nothing touches a stale checkout from outside: its files only change when a
command runs in it. The rewriting command lists the checkouts it made stale.
In a stale checkout, commands that would build on, rewrite or publish the
stale commits (``worktree.stale-blocked-commands``) refuse to run until
``@prog@ update-stale`` moves it onto the latest versions, carrying uncommitted
changes along. With ``worktree.auto-update-stale=true``, every command in a
stale checkout runs that update first.
"""

import os
import subprocess
import time

from . import cmdutil, error, git, hg, mutation, util
from .i18n import _
from .node import bin, nullid, short

# Commands that would build on, rewrite or publish the stale commits.
DEFAULT_BLOCKED_COMMANDS = [
    "absorb",
    "amend",
    "commit",
    "fold",
    "histedit",
    "metaedit",
    "push",
    "split",
    "unamend",
    "uncommit",
]

# The working copy parent itself was rewritten.
REWRITTEN = "rewritten"
# A commit below the working copy parent was rewritten.
ORPHANED = "orphaned"

# The commits the current command rewrote, by the root of the repo it ran in.
# The checkouts stacked on them are listed once the command is done.
_rewritten = {}


def _ingroup(repo):
    """whether the repo is a checkout of a git worktree group with others"""
    if git.DOTGIT_REQUIREMENT not in repo.requirements:
        return False
    dotgit = repo.wvfs.join(".git")
    if os.path.isfile(dotgit):
        # A linked worktree: ".git" points into the main checkout's git dir.
        return True
    try:
        return bool(os.listdir(os.path.join(dotgit, "worktrees")))
    except OSError:
        return False


def _hasnewerversion(repo, node, isvisible):
    return any(isvisible(s) for s in mutation.allsuccessors(repo, [node], startdepth=1))


def _stalestate(repo, node):
    """(REWRITTEN or ORPHANED, the rewritten commit) for a checkout at node,
    or None if it is not stale

    This walks the graph instead of using ``obsolete()``: another checkout's
    commits are hidden here once rewritten here, and revsets only see visible
    commits.
    """
    cl = repo.changelog
    if not cl.hasnode(node):
        return None
    ispublic = mutation.getispublicfunc(repo)
    isvisible = mutation.getisvisiblefunc(repo)
    if _hasnewerversion(repo, node, isvisible):
        return REWRITTEN, node
    seen = {node}
    pending = list(cl.parents(node))
    while pending:
        n = pending.pop()
        if n == nullid or n in seen or ispublic(n):
            continue
        seen.add(n)
        if _hasnewerversion(repo, n, isvisible):
            return ORPHANED, n
        pending.extend(cl.parents(n))
    return None


def _latest(repo, node):
    """the latest visible version of a rewritten node, or None if there is no
    single one (diverged, or the latest version is hidden)"""
    succsets = mutation.successorssets(repo, node)
    if len(succsets) != 1:
        return None
    isvisible = mutation.getisvisiblefunc(repo)
    succs = succsets[0]
    if not succs or not all(isvisible(n) for n in succs):
        return None
    # A split leaves several commits; the top one carries all of the content.
    return repo[repo.revs("max(%ln)", succs).first()].node()


def _describe(repo, node):
    try:
        title = repo[node].description().split("\n", 1)[0]
    except error.RepoLookupError:
        return short(node)
    return '%s "%s"' % (short(node), title)


def _staleness(repo, state):
    kind, node = state
    if kind == REWRITTEN:
        return _("this worktree's commit %s was rewritten in another worktree") % (
            _describe(repo, node)
        )
    return _("%s, below this worktree's commit, was rewritten in another worktree") % (
        _describe(repo, node)
    )


def _state(repo):
    """the stale state of this checkout, or None when there is nothing to check"""
    if not _ingroup(repo):
        return None
    ctx = repo["."]
    if ctx.node() == nullid or not ctx.mutable() or repo.dirstate.p2() != nullid:
        return None
    try:
        cmdutil.checkunfinished(repo)
    except error.Abort:
        # A rebase, graft, ... in progress owns the working copy.
        return None
    return _stalestate(repo, ctx.node())


def checkstale(ui, repo, cmd):
    """before running cmd in this checkout, update it or refuse if it is stale"""
    if cmd == "update-stale":
        return
    state = _state(repo)
    if state is None:
        return
    if ui.configbool("worktree", "auto-update-stale"):
        ui.warn(_("note: %s\n") % _staleness(repo, state))
        update(ui, repo, state)
        return
    if cmd not in ui.configlist(
        "worktree", "stale-blocked-commands", DEFAULT_BLOCKED_COMMANDS
    ):
        return
    raise error.Abort(
        _("stale worktree: %s") % _staleness(repo, state),
        hint=_(
            "nothing was changed; run '@prog@ update-stale' to move this worktree "
            "onto the latest versions (uncommitted changes come along), then retry"
        ),
    )


def updatestale(ui, repo):
    """the update-stale command"""
    state = _state(repo)
    if state is None:
        ui.status(_("this worktree is not stale\n"))
        return 0
    ui.warn(_("note: %s\n") % _staleness(repo, state))
    return update(ui, repo, state)


def update(ui, repo, state):
    """move a stale checkout onto the latest versions of its commits"""
    old = repo["."].node()
    if state[0] == REWRITTEN:
        target = _latest(repo, old)
        if target is None:
            raise error.Abort(
                _("%s was rewritten and has no single latest version") % short(old),
                hint=_(
                    "pick one with '@prog@ log -r \"successors(%s)\"' and '@prog@ goto'"
                )
                % short(old),
            )
        with repo.wlock():
            try:
                hg.update(repo, target, quietempty=True, updatecheck="noconflict")
            except error.Abort as ex:
                raise error.Abort(
                    _("cannot move pending changes onto %s: %s") % (short(target), ex),
                    hint=_("run '@prog@ goto --merge %s' and resolve") % short(target),
                )
        ui.warn(
            _("note: moved this worktree to the latest version %s; files changed to match\n")
            % _describe(repo, target)
        )
        state = _stalestate(repo, target)
        if state is None:
            return 0
        old = target

    _restack(ui, repo)
    new = repo["."].node()
    if new == old or _stalestate(repo, new) is not None:
        raise error.Abort(
            _("could not restack %s onto the latest versions of the commits below it")
            % short(old),
            hint=_("run '@prog@ restack' and resolve the conflicts"),
        )
    ui.warn(
        _(
            "note: restacked this worktree's commits onto the latest versions, now on "
            "%s; files changed to match\n"
        )
        % _describe(repo, new)
    )
    return 0


def _sl(path, args):
    env = dict(os.environ)
    env["HGPLAIN"] = "1"
    # The checkout is still stale while these run; they are the update.
    cmd = util.hgcmd() + [
        "--cwd",
        path,
        "--config",
        "worktree.auto-update-stale=false",
    ]
    cmd += args
    return subprocess.run(cmd, capture_output=True, env=env)


def _restack(ui, repo):
    """restack the stack under the working copy, setting uncommitted changes
    aside meanwhile: a rebase cannot move a working copy that has them"""
    shelved = None
    if any(repo.status()[:4]):
        shelved = "update-stale-%d" % int(time.time())
        proc = _sl(
            repo.root,
            ["--config", "extensions.shelve=", "shelve", "--name", shelved],
        )
        if proc.returncode != 0:
            raise error.Abort(
                _("cannot set uncommitted changes aside: %s")
                % proc.stderr.decode("utf-8", "replace").strip()
            )
    try:
        _sl(
            repo.root,
            [
                "--config",
                "extensions.rebase=",
                "--config",
                "rebase.experimental.inmemory=true",
                "rebase",
                "--restack",
                "--noconflict",
            ],
        )
    finally:
        if shelved:
            proc = _sl(
                repo.root,
                ["--config", "extensions.shelve=", "unshelve", "--name", shelved],
            )
            if proc.returncode != 0:
                ui.warn(proc.stdout.decode("utf-8", "replace"))
                ui.warn(proc.stderr.decode("utf-8", "replace"))
        repo.invalidateall()
        mutation.clearobsoletecache(repo)


def _checkouts(repo):
    """{path: node} for every detached checkout of the git worktree group"""
    out = git.callgit(repo, ["worktree", "list", "--porcelain"], checkreturncode=False)
    checkouts = {}
    for entry in out.decode("utf-8", "surrogateescape").split("\n\n"):
        fields = {}
        for line in entry.splitlines():
            key, _sep, value = line.partition(" ")
            fields[key] = value
        if "worktree" in fields and "detached" in fields and "prunable" not in fields:
            head = fields.get("HEAD", "")
            if len(head) == 40:
                checkouts[fields["worktree"]] = bin(head)
    return checkouts


def scheduleafterrewrite(repo, oldnodes):
    """list the checkouts this command makes stale by rewriting oldnodes, once
    it is done"""
    if not oldnodes or not _ingroup(repo):
        return
    if repo.root not in _rewritten:
        _rewritten[repo.root] = set()
        repo.ui.atexit(_notestale, repo)
    _rewritten[repo.root].update(oldnodes)


def _stackedon(repo, node, nodes):
    """whether node, or a non-public commit it is stacked on, is in nodes"""
    cl = repo.changelog
    ispublic = mutation.getispublicfunc(repo)
    seen = set()
    pending = [node]
    while pending:
        n = pending.pop()
        if n in nodes:
            return True
        if n == nullid or n in seen or not cl.hasnode(n) or ispublic(n):
            continue
        seen.add(n)
        pending.extend(cl.parents(n))
    return False


def _notestale(repo):
    rewritten = _rewritten.pop(repo.root, set())
    ui = repo.ui
    root = os.path.realpath(repo.root)
    if ui.configbool("worktree", "auto-update-stale"):
        then = _("it moves onto the latest versions at its next @prog@ command")
    else:
        then = _("'@prog@ update-stale' there moves it onto the latest versions")
    for path, node in sorted(_checkouts(repo).items()):
        if os.path.realpath(path) == root or not _stackedon(repo, node, rewritten):
            continue
        if _stalestate(repo, node) is not None:
            ui.warn(
                _("note: worktree %s is now stale (it is on %s); %s\n")
                % (path, _describe(repo, node), then)
            )
