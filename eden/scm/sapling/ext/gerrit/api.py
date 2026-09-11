# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed according to the terms of the
# GNU General Public License version 2.

"""Talking to a Gerrit server.

A thin skin over ``bindings.gerrit``, the Rust client, which reaches the
server over SSH or over the REST API depending on how the repo was cloned and
hands back one shape of change either way. The transport, the credentials and
the rules for turning votes into a review state all live there, so there is
only ever one copy of them.

A change is a plain dict here, carrying what the server said plus the state
derived from it: ``review_state``, ``verified_state`` and ``summary``.
"""

from bindings import gerrit as _gerrit

from sapling import error
from sapling.i18n import _


def _config(ui):
    """The config the Rust client reads the server and transport from."""
    return ui._rcfg


def query(ui, spec):
    """The changes matching a Gerrit query."""
    return _gerrit.query(_config(ui), spec)


def change(ui, changeid):
    """One change by number or Change-Id, or None."""
    return _gerrit.change(_config(ui), str(changeid))


def stackfor(ui, changeid):
    """A change and the open changes below it, root first."""
    return _gerrit.stackfor(_config(ui), str(changeid))


def changeurl(ui, number):
    """The web URL of a change, which is where Gerrit serves it."""
    return _gerrit.changeurl(_config(ui), int(number))


def review(ui, change, **fields):
    """Post a review. ``fields`` is Gerrit's ReviewInput."""
    _gerrit.review(_config(ui), change, fields)


def settopic(ui, change, topic):
    _gerrit.settopic(_config(ui), change, topic)


def addreviewer(ui, change, reviewer):
    _gerrit.addreviewer(_config(ui), change, reviewer)


def abortnochange(changeid):
    raise error.Abort(
        _("change %s is not on Gerrit") % changeid,
        hint=_("upload it with '@prog@ gerrit publish'"),
    )
