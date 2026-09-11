# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed according to the terms of the
# GNU General Public License version 2.

"""Gerrit code review integration

The ``gerrit`` extension enables Gerrit-specific features. The ``sl gerrit
publish`` command is implemented in Rust and pushes commits for review via
``refs/for/<branch>``.

Gerrit detection is handled by :func:`detect.isgerrit`, which probes the
remote server and persists the result as ``gerrit.url`` in repo config.

While ``gerrit.url`` is set, a commit gets a ``Change-Id`` trailer as it is
written. Gerrit needs the id to be in the commit by the time it is pushed --
unlike a Phabricator diff number, which the server assigns and the submit tool
records afterwards -- and ``sl push`` reaches ``refs/for/<branch>`` just as
``sl gerrit publish`` does, so this hangs off commit writing rather than off a
publish command.

``sl gerrit view``, ``review`` and ``refresh`` are Python subcommands of the
native command; see :mod:`cmd`. What Gerrit says about a change is cached
locally (see :mod:`status`) and shown in smartlog through the template
keywords in :mod:`templates`, which :mod:`smartlog` points the same slots at
that the GitHub and Phabricator providers use.

Config::

    [gerrit]
    # Turn off Change-Id handling, e.g. to supply your own via an extension
    # wrapping rewriteutil.newcommitmessage.
    add-change-id = False

    # The project a change belongs to, for building its web URL. Defaults to
    # the path of the remote URL.
    project = tools/sl

    # How long to wait for the server, in seconds.
    timeout = 15

    # Don't refresh the review status cache after a push or a pull.
    autorefresh = False
"""

from sapling import extensions, git, mutation, rewriteutil, util

from . import changeid, smartlog, status
from .changeid import extract as extract_change_id  # noqa: F401 – for callers
from .cmd import cmdtable  # noqa: F401 – registers the gerrit subcommands
from .detect import isgerrit  # noqa: F401 – re-export for external callers
from .templates import templatekeyword  # noqa: F401 – registers the keywords


def extsetup(ui):
    extensions.wrapfunction(
        rewriteutil, "newcommitmessage", _newcommitmessage
    )
    extensions.wrapfunction(rewriteutil, "copycommitmessage", _copycommitmessage)
    # Wrapping git.push rather than the push command: remotenames short-circuits
    # the command for git repos, so a command wrapper would not see the push
    # that `sl push --to refs/for/...` and `sl gerrit publish` both end in.
    extensions.wrapfunction(git, "push", _push)


def reposetup(ui, repo):
    ui.setconfig("hooks", "post-pull.gerrit-refresh", _postpull, "gerrit")
    # Only in a Gerrit repo: elsewhere smartlog's review slots belong to
    # whichever provider that repo does use.
    if ui.config("gerrit", "url"):
        smartlog.install(ui)


def _autorefresh(repo):
    return repo.ui.config("gerrit", "url") and repo.ui.configbool(
        "gerrit", "autorefresh", True
    )


def _push(orig, repo, dest, pushnode_to_pairs, force=False):
    """Refresh the review status of whatever was just uploaded to Gerrit."""
    result = orig(repo, dest, pushnode_to_pairs, force=force)
    if not _autorefresh(repo):
        return result
    if not any(
        str(ref).startswith(git.GERRIT_UPLOAD_REFS)
        for _pushnode, ref in pushnode_to_pairs
        if ref
    ):
        return result
    # The whole stack was uploaded, not only the commit named, and Gerrit
    # renumbers patchsets across it.
    status.refresh(repo, status.draftchangeids(repo))
    return result


def _postpull(ui, repo, **kwargs):
    """Refresh changes that the pull may have moved, without holding it up.

    A pull is where someone else's review shows up, so the cache is stale
    afterwards -- but the query is a round-trip to Gerrit, and blocking the
    pull on it is what makes an integration feel slow. The refresh runs in a
    detached child, which re-enters this extension as `debuggerrit refresh`.
    """
    if not _autorefresh(repo):
        return
    stale = [
        cid
        for cid, entry in status.load(repo).items()
        if entry.get("status") not in ("MERGED", "ABANDONED")
    ]
    if not stale:
        return
    try:
        util.spawndetached([util.hgexecutable(), "debuggerrit", "refresh"], cwd=repo.root)
    except Exception:
        status.refresh(repo, stale)


def _copycommitmessage(orig, repo, message, operation, source):
    """Drop the Change-Id when a commit is copied rather than rewritten.

    ``graft`` and ``rebase --keep`` duplicate a commit, and the copy is new
    work that happens to carry the source's trailer. Pushing it under the same
    Change-Id would add a patchset to the source's change, or be rejected for
    reusing an id across changes, so the copy starts without one and is given
    a fresh id when it is written.
    """
    message = orig(repo, message, operation, source)
    if not repo.ui.config("gerrit", "url"):
        return message
    if not repo.ui.configbool("gerrit", "add-change-id", True):
        return message
    return changeid.strip(message)


def _newcommitmessage(orig, repo, ctx, message):
    """Give a commit a Change-Id trailer as it is written."""
    message = orig(repo, ctx, message)
    if not message.strip():
        return message
    # `gerrit.url` is the single gate, shared with ISL (see detect.isgerrit).
    # Probing here instead would put an SSH round-trip in front of every commit.
    if not repo.ui.config("gerrit", "url"):
        return message
    if not repo.ui.configbool("gerrit", "add-change-id", True):
        return message
    inherited = _inherited_change_id(repo, ctx)
    if inherited:
        return changeid.attach(message, inherited)
    return changeid.ensure(message, repo.ui.username(), _p1hex(ctx), ctx.date())


def _inherited_change_id(repo, ctx):
    """The Change-Id of the commit this one rewrites, if it had one.

    ``sl commit --amend -m ...`` (and reword, metaedit, histedit) replaces the
    description wholesale, dropping the trailer. Minting a fresh id there would
    open a second Gerrit change for work already under review, so carry the
    predecessor's id across instead. Sapling records the predecessor in the
    commit's mutation info, which is what those rewrites set.
    """
    if changeid.extract(ctx.description()):
        return None
    try:
        mutinfo = ctx.mutinfo()
    except Exception:
        return None
    if not mutinfo:
        return None
    for node in mutation.nodesfrominfo(mutinfo.get("mutpred")) or []:
        try:
            found = changeid.extract(repo[node].description())
        except Exception:
            continue
        if found:
            return found
    return None


def _p1hex(ctx):
    """First parent's hex node, or empty when there is none (or it is unborn)."""
    try:
        return ctx.p1().hex()
    except Exception:
        return ""
