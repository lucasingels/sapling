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

Config::

    [gerrit]
    # Turn off Change-Id handling, e.g. to supply your own via an extension
    # wrapping rewriteutil.newcommitmessage.
    add-change-id = False
"""

from sapling import extensions, mutation, rewriteutil

from . import changeid
from .changeid import extract as extract_change_id  # noqa: F401 – for callers
from .detect import isgerrit  # noqa: F401 – re-export for external callers


def extsetup(ui):
    extensions.wrapfunction(
        rewriteutil, "newcommitmessage", _newcommitmessage
    )
    extensions.wrapfunction(rewriteutil, "copycommitmessage", _copycommitmessage)


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
