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
changes along. With ``worktree.auto-update-stale=true``, those commands run
that update first instead. Every other command, ``status`` and ``whereami``
included, only notes that the checkout is stale.

A restack (``@prog@ restack``, the one after ``@prog@ amend``, and the one
``update-stale`` runs) only restacks the checkout's own stack: the commits
below and above its working copy parent, and those stacked on an older version
of a commit below it. It leaves alone the commits another checkout has checked
out or stacked its commits on, and the commits above them, and notes which
checkouts must update themselves. The exception is the commits below this
checkout's own commit, which it restacks; checkouts on them become stale.
``worktree.restack-foreign=true`` restacks every connected commit, as outside a
worktree group.

Detecting the state is shared with the Rust commands: see the
``worktree_stale`` crate, reached through ``repo._rsrepo``.
"""

import os
import subprocess
import time

from . import error, git, hg, merge as mergemod, mutation, util
from .i18n import _
from .node import bin, hex, nullid, short

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

# In a linked git worktree's dot dir: the commit `sl commit` or `sl amend` last
# made there. The worktree_stale crate reads it to tell a worktree whose own work
# landed from one that only sits on a landed commit.
LASTCOMMIT = "worktree-last-commit"

# The working copy parent itself was rewritten.
REWRITTEN = "rewritten"
# A commit below the working copy parent was rewritten.
ORPHANED = "orphaned"

# A stale state is (REWRITTEN or ORPHANED, the rewritten commit, why the
# checkout is stale), as the worktree_stale crate reports it.

# The commits the current command rewrote, by the root of the repo it ran in.
# The checkouts stacked on them are listed once the command is done.
_rewritten = {}

# The checkouts a restack in the current command left stale, by the root of the
# repo it ran in. They were noted already, so they are not listed again.
_left = {}


def _schedule(repo):
    """list the stale checkouts once the current command is done"""
    if repo.root not in _rewritten:
        _rewritten[repo.root] = set()
        _left[repo.root] = set()
        repo.ui.atexit(_notestale, repo)


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


def recordcommit(repo, node):
    """note that `sl commit` or `sl amend` made node in this checkout, when it
    is a linked git worktree"""
    # Commits made inside a larger operation (shelve, unshelve, rebase,
    # histedit, split, ...) are not the checkout's own: the operation may
    # still abort, or hide them. Rewrites are found as later versions of the
    # recorded commit instead.
    if repo.currenttransaction() is not None:
        return
    if git.DOTGIT_REQUIREMENT not in repo.requirements:
        return
    if not os.path.isfile(repo.wvfs.join(".git")):
        return
    try:
        repo.localvfs.writeutf8(LASTCOMMIT, "%s\n" % hex(node))
    except OSError:
        # Only `sl worktree prune` is the poorer for it: the worktree reads
        # as idle rather than landed.
        pass


def _stalestate(repo, node):
    """the stale state of a checkout at node, judged by this repo's
    visibility, or None if it is not stale"""
    return repo._rsrepo.worktreestalestate(node, list(repo.dirstate.parents()))


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


def describe(repo, node):
    try:
        title = repo[node].description().split("\n", 1)[0]
    except error.RepoLookupError:
        return short(node)
    return '%s "%s"' % (short(node), title)


def _state(repo):
    """the stale state of this checkout, or None when there is nothing to check
    (outside a worktree group, during a merge or an unfinished operation, on a
    public commit)"""
    if not _ingroup(repo):
        return None
    return repo._rsrepo.worktreecheckoutstale(list(repo.dirstate.parents()))


def checkstale(ui, repo, cmd):
    """before running cmd in this checkout, note that it is stale, or, for a
    command that would build on the stale commits, update it or refuse"""
    if cmd == "update-stale":
        return
    state = _state(repo)
    if state is None:
        return
    if cmd not in ui.configlist(
        "worktree", "stale-blocked-commands", DEFAULT_BLOCKED_COMMANDS
    ):
        ui.warn(
            _("note: %s; '@prog@ update-stale' moves it onto the latest versions\n")
            % state[2]
        )
        return
    if ui.configbool("worktree", "auto-update-stale"):
        ui.warn(_("note: %s\n") % state[2])
        update(ui, repo, state)
        return
    raise error.Abort(
        _("stale worktree: %s") % state[2],
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
    ui.warn(_("note: %s\n") % state[2])
    return update(ui, repo, state)


def update(ui, repo, state):
    """move a stale checkout onto the latest versions of its commits, setting
    uncommitted changes aside meanwhile and bringing them back afterwards"""
    target = None
    if state[0] == REWRITTEN:
        old = repo["."].node()
        target = _latest(repo, old)
        if target is None:
            raise error.Abort(
                _("%s was rewritten and has no single latest version") % short(old),
                hint=_(
                    "pick one with '@prog@ log -r \"successors(%s)\"' and '@prog@ goto'"
                )
                % short(old),
            )
    shelved = _shelve(repo)
    try:
        _move(ui, repo, state, target)
    except BaseException:
        if shelved:
            # Back onto the commit they came from, or onto wherever the move
            # got to before it failed.
            try:
                conflicts = _unshelve(ui, repo, shelved)
            except error.Abort as ex:
                ui.warn(_("%s\n") % ex)
            else:
                if conflicts:
                    ui.warn(_conflictsmessage(repo, shelved, conflicts) + "\n")
        raise
    if shelved:
        conflicts = _unshelve(ui, repo, shelved)
        if conflicts:
            raise error.Abort(
                _conflictsmessage(repo, shelved, conflicts),
                hint=_(
                    "the conflicts are marked in the files; resolve them, "
                    "run '@prog@ resolve --mark', then '@prog@ unshelve --continue'"
                ),
            )
    return 0


def _move(ui, repo, state, target):
    """move the clean working copy onto target, the latest version of its
    rewritten parent, then restack whatever is still stale below it"""
    old = repo["."].node()
    if state[0] == REWRITTEN:
        with repo.wlock():
            hg.update(repo, target, quietempty=True)
        ui.warn(
            _("note: moved this worktree to the latest version %s; files changed to match\n")
            % describe(repo, target)
        )
        state = _stalestate(repo, target)
        if state is None:
            return
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
        % describe(repo, new)
    )


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


def _shelve(repo):
    """set uncommitted changes aside, since neither a rebase nor a git checkout
    moves a working copy whose changes overlap the move; the shelve's name, or
    None when there was nothing to set aside"""
    if not any(repo.status()[:4]):
        return None
    shelved = "update-stale-%d" % int(time.time())
    proc = _sl(
        repo.root,
        ["--config", "extensions.shelve=", "shelve", "--name", shelved],
    )
    repo.invalidateall()
    if proc.returncode != 0:
        raise error.Abort(
            _("cannot set uncommitted changes aside: %s")
            % proc.stderr.decode("utf-8", "replace").strip()
        )
    return shelved


def _unshelve(ui, repo, shelved):
    """bring the changes set aside back onto the working copy; the files that
    conflict, left with conflict markers and the unshelve unfinished"""
    proc = _sl(
        repo.root,
        ["--config", "extensions.shelve=", "unshelve", "--name", shelved],
    )
    repo.invalidateall()
    if proc.returncode == 0:
        return []
    conflicts = []
    if repo.localvfs.exists("shelvedstate"):
        conflicts = sorted(mergemod.mergestate.read(repo).unresolved())
    if not conflicts:
        ui.warn(proc.stdout.decode("utf-8", "replace"))
        ui.warn(proc.stderr.decode("utf-8", "replace"))
        raise error.Abort(
            _("cannot bring back the uncommitted changes set aside as shelve '%s'")
            % shelved,
            hint=_("they are kept there; see '@prog@ shelve --list'"),
        )
    return conflicts


def _conflictsmessage(repo, shelved, conflicts):
    return _(
        "uncommitted changes conflict with %s in %s (they are also kept as shelve '%s')"
    ) % (describe(repo, repo["."].node()), ", ".join(conflicts), shelved)


def _restack(ui, repo):
    """restack the stack under the clean working copy, leaving alone the
    commits other checkouts own"""
    try:
        proc = _sl(
            repo.root,
            [
                "--config",
                "extensions.rebase=",
                "--config",
                "rebase.experimental.inmemory=true",
                "--config",
                "worktree.restack-foreign=false",
                "rebase",
                "--restack",
                "--noconflict",
            ],
        )
        # The checkouts the restack left stale, or made stale by restacking
        # commits below this one that they are on.
        for line in proc.stderr.decode("utf-8", "replace").splitlines():
            if line.startswith(("note: left ", "note: worktree ")):
                ui.warn("%s\n" % line)
    finally:
        repo.invalidateall()
        mutation.clearobsoletecache(repo)


def _checkouts(repo):
    """{path: node} for every detached checkout of the git worktree group

    Sapling keeps the checkouts it manages on a detached HEAD. A worktree on a
    git branch is one git manages, and is not listed."""
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


def ownrevs(repo, revs):
    """split revs, about to be restacked, into the ones this checkout restacks
    and the ones it leaves to the other checkouts of its worktree group.

    A checkout restacks its own stack: the commits below and above its working
    copy parent, and those stacked on an older version of a commit below it.
    Of those, the ones another checkout has checked out or stacked its commits
    on, and every commit above them, are that checkout's to restack. The
    exception is the commits below this checkout's own commit, and the older
    versions of them: it restacks those, and checkouts on them become stale.

    With no other live checkouts in the group, every rev is restacked.

    Returns (the revs to restack, {path: node} of the other checkouts whose
    commits are left alone). With ``worktree.restack-foreign=true``, or outside
    a worktree group, every rev is restacked."""
    revs = list(revs)
    if (
        not revs
        or not _ingroup(repo)
        or repo.ui.configbool("worktree", "restack-foreign")
    ):
        return revs, {}
    root = os.path.realpath(repo.root)
    hasnode = repo.changelog.hasnode
    others = {
        path: node
        for path, node in _checkouts(repo).items()
        if os.path.realpath(path) != root and hasnode(node)
    }
    if not others:
        return revs, {}
    own = repo.revs(
        "%ld & ((draft() & ::.) + .:: + ((predecessors(draft() & ::.) - ::.)::))",
        revs,
    )
    # Leaving out what is below this checkout's own commit, and the older
    # versions of it, keeps them restackable when another checkout is stacked
    # on them too.
    foreign = repo.revs(
        "(%ld & ::%ln) - ::. - predecessors(draft() & ::.)",
        own,
        list(others.values()),
    )
    owners = {}
    if foreign:
        left = repo.revs("%ld & (%ld::)", own, foreign)
        torev = repo.changelog.rev
        owners = {path: node for path, node in others.items() if torev(node) in left}
        own = repo.revs("%ld - %ld", own, left)
    return list(own), owners


def checkoutsin(repo, revs):
    """{path: node} for the other checkouts of the worktree group that have
    one of revs checked out"""
    if not _ingroup(repo):
        return {}
    root = os.path.realpath(repo.root)
    hasnode = repo.changelog.hasnode
    torev = repo.changelog.rev
    revs = set(revs)
    return {
        path: node
        for path, node in _checkouts(repo).items()
        if os.path.realpath(path) != root and hasnode(node) and torev(node) in revs
    }


def noteleft(ui, repo, owners):
    """note which checkouts a restack left stale, for them to update; whether
    there were any"""
    noted = False
    for path, node in sorted(owners.items()):
        if _stalestate(repo, node) is None:
            continue
        _schedule(repo)
        _left[repo.root].add(os.path.realpath(path))
        ui.warn(
            _("note: left %s for worktree %s; run '@prog@ update-stale' there\n")
            % (describe(repo, node), path)
        )
        noted = True
    return noted


def scheduleafterrewrite(repo, oldnodes):
    """list the checkouts this command makes stale by rewriting oldnodes, once
    it is done"""
    if not oldnodes or not _ingroup(repo):
        return
    _schedule(repo)
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
    noted = _left.pop(repo.root, set())
    ui = repo.ui
    root = os.path.realpath(repo.root)
    if ui.configbool("worktree", "auto-update-stale"):
        then = _(
            "it moves onto the latest versions before the next command there "
            "that would build on them"
        )
    else:
        then = _("'@prog@ update-stale' there moves it onto the latest versions")
    for path, node in sorted(_checkouts(repo).items()):
        realpath = os.path.realpath(path)
        if (
            realpath == root
            or realpath in noted
            or not _stackedon(repo, node, rewritten)
        ):
            continue
        if _stalestate(repo, node) is not None:
            ui.warn(
                _("note: worktree %s is now stale (it is on %s); %s\n")
                % (path, describe(repo, node), then)
            )
