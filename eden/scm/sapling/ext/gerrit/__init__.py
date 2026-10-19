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

    # Keep hard-wrapped body prose as written. By default a commit's body
    # paragraphs are joined back into one line each as it is written, since
    # Gerrit soft-wraps at 72 columns and a body filled at ~80 renders as a
    # full line, a one-word stub, then the next full line.
    unwrap-prose = False

    # The project a change belongs to, for building its web URL. Defaults to
    # the path of the remote URL.
    project = tools/sl

    # How long to wait for the server, in seconds.
    timeout = 15

    # Don't refresh the review status cache after a push or a pull.
    autorefresh = False

    # Leave drafts visible after their change has been submitted. By default
    # a pull marks a draft whose Change-Id is on a public commit of the
    # change's branch as landed as that commit, and hides it, unless it holds
    # work that was never uploaded (see :mod:`landed`).
    hide-landed-commits = False

    # How many public commits to read at most, newest first, when looking
    # for where drafts landed.
    landed-scan-limit = 10000

    # Don't refuse a push for review that carries a Change-Id another live
    # draft also has (see :mod:`republish`).
    check-duplicate-change-ids = False

    # What to do when changes pushed for review would get patchsets that only
    # rebase them: warn (the default), abort (--force-republish overrides
    # it), or off.
    republish-check = abort
"""

from bindings import gerrit as _gerrit
from sapling import cmdutil, commands, extensions, git, mutation, rewriteutil, util
from sapling.i18n import _

from . import changeid, landed, republish, smartlog, status
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
    # The option is read by a pre-push hook rather than a command wrapper:
    # remotenames' wrapper does a git push itself instead of calling through,
    # so one installed beneath it would never run.
    _aliases, entry = cmdutil.findcmd("push", commands.table)
    entry[1].append(
        (
            "",
            "force-republish",
            None,
            _(
                "upload changes for Gerrit review even if all that changed is "
                "their base (Gerrit remotes only)"
            ),
        )
    )
    # `pull --rebase` rebases inside the pull command, before any post-pull
    # hook runs, and these are where it marks landed commits first so the
    # rebase skips them rather than replaying them onto the trunk.
    from sapling.ext import remotenames, tweakdefaults

    extensions.wrapfunction(remotenames, "_marklanded", _marklanded)
    extensions.wrapfunction(tweakdefaults, "_marklanded", _marklanded)


def reposetup(ui, repo):
    # Hooks run in name order; this one is named to run before the refresh.
    ui.setconfig("hooks", "post-pull.gerrit-landed", landed.hook, "gerrit")
    ui.setconfig("hooks", "post-pull.gerrit-refresh", _postpull, "gerrit")
    ui.setconfig("hooks", "pre-push.gerrit-republish", _prepush, "gerrit")
    # Only in a Gerrit repo: elsewhere smartlog's review slots belong to
    # whichever provider that repo does use.
    if ui.config("gerrit", "url"):
        smartlog.install(ui)


def _autorefresh(repo):
    return repo.ui.config("gerrit", "url") and repo.ui.configbool(
        "gerrit", "autorefresh", True
    )


def _marklanded(orig, ui, repo):
    orig(ui, repo)
    landed.marklanded(ui, repo)


def _prepush(ui, repo, opts=None, **kwargs):
    if opts and opts.get("force_republish"):
        repo.ui.setconfig("gerrit", "force-republish", True, "--force-republish")


def _uploads(pushnode_to_pairs):
    """The commits in a push that go to Gerrit's upload refs."""
    return [
        pushnode
        for pushnode, ref in pushnode_to_pairs
        if pushnode is not None
        and ref
        and str(ref).startswith(git.GERRIT_UPLOAD_REFS)
    ]


def _push(orig, repo, dest, pushnode_to_pairs, force=False):
    """Check an upload to Gerrit, then remember and refresh it."""
    uploads = _uploads(pushnode_to_pairs)
    if not uploads or not repo.ui.config("gerrit", "url"):
        return orig(repo, dest, pushnode_to_pairs, force=force)
    republish.check(repo, pushnode_to_pairs)
    result = orig(repo, dest, pushnode_to_pairs, force=force)
    if result == 0:
        # The whole draft stack below each commit went up with it.
        landed.recorduploaded(
            repo, [repo[r].node() for r in repo.revs("draft() & ::%ln", uploads)]
        )
    if not _autorefresh(repo):
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
    """Unwrap a commit's body prose and give it a Change-Id as it is written."""
    message = orig(repo, ctx, message)
    if not message.strip():
        return message
    # `gerrit.url` is the single gate, shared with ISL (see detect.isgerrit).
    # Probing here instead would put an SSH round-trip in front of every commit.
    if not repo.ui.config("gerrit", "url"):
        return message
    if repo.ui.configbool("gerrit", "unwrap-prose", True) and not any(
        message == description for description in _predecessor_descriptions(repo, ctx)
    ):
        # Only a message that was just written or edited. A joined line can
        # itself look like a fixed-column fill, so unwrapping the same message
        # again could join a break that was left on purpose; a rebase, or an
        # amend that keeps the message, would then wear it away a line at a
        # time.
        message = _gerrit.unwrapprose(message)
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
    predecessor's id across instead.
    """
    if changeid.extract(ctx.description()):
        return None
    for description in _predecessor_descriptions(repo, ctx):
        found = changeid.extract(description)
        if found:
            return found
    return None


def _predecessor_descriptions(repo, ctx):
    """The descriptions of the commits ``ctx`` rewrites, if any.

    Sapling records them in the commit's mutation info, which amend, rebase,
    metaedit, histedit and the like set.
    """
    try:
        mutinfo = ctx.mutinfo()
    except Exception:
        return
    if not mutinfo:
        return
    for node in mutation.nodesfrominfo(mutinfo.get("mutpred")) or []:
        try:
            yield repo[node].description()
        except Exception:
            continue


def _p1hex(ctx):
    """First parent's hex node, or empty when there is none (or it is unborn)."""
    try:
        return ctx.p1().hex()
    except Exception:
        return ""
