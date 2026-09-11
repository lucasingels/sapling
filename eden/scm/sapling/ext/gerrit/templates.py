# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed according to the terms of the
# GNU General Public License version 2.

"""Template keywords that let smartlog show a commit's Gerrit change.

The keywords read only the local cache (see :mod:`status`), never the server:
smartlog renders one line per commit, and a query per line would make it
unusable. :mod:`smartlog` points the same ``sl_diff*`` slots the GitHub and
Phabricator providers use at these, so a Gerrit change shows up in smartlog
looking like any other code review link.
"""

from sapling import registrar

from . import api, changeid, status

templatekeyword = registrar.templatekeyword()

# The loaded cache is stashed in the templater's per-command cache, so a
# smartlog of fifty commits reads and parses the file once.
_CACHE_KEY = "gerrit_change_cache"
_ENTRY_KEY = "gerrit_change_entry"

# Distinguishes "this commit has no change" from "not looked up yet", since
# the former is itself worth caching.
_MISSING = object()


def _cache(repo, args):
    cache = args["cache"]
    loaded = cache.get(_CACHE_KEY)
    if loaded is None:
        loaded = cache[_CACHE_KEY] = status.load(repo)
    return loaded


def _entry(repo, ctx, args):
    revcache = args["revcache"]
    entry = revcache.get(_ENTRY_KEY, _MISSING)
    if entry is _MISSING:
        entry = revcache[_ENTRY_KEY] = status.entry(repo, ctx, _cache(repo, args))
    return entry


@templatekeyword("gerrit_repo")
def gerrit_repo(repo, ctx, templ, **args) -> bool:
    """Whether this repo is backed by Gerrit."""
    return bool(repo.ui.config("gerrit", "url"))


@templatekeyword("gerrit_change_id")
def gerrit_change_id(repo, ctx, templ, **args) -> str:
    """The commit's ``Change-Id`` trailer, e.g. ``I1234abcd...``."""
    return changeid.extract(ctx.description()) or ""


@templatekeyword("gerrit_change_number")
def gerrit_change_number(repo, ctx, templ, **args) -> str:
    """The Gerrit change number, e.g. ``142``.

    Empty until the change has been uploaded and the status cache refreshed:
    Gerrit assigns the number, unlike the Change-Id, which the commit carries.
    """
    number = status.field(_entry(repo, ctx, args), "number", 0)
    return str(number) if number else ""


@templatekeyword("gerrit_change_url")
def gerrit_change_url(repo, ctx, templ, **args) -> str:
    """The Gerrit web URL of the commit's change."""
    number = gerrit_change_number(repo, ctx, templ, **args)
    if not number:
        return ""
    try:
        return api.changeurl(repo.ui, number)
    except Exception:
        # A repo whose remote does not name a project still gets the change
        # number in smartlog; it just is not a link.
        return ""


@templatekeyword("gerrit_change_status")
def gerrit_change_status(repo, ctx, templ, **args) -> str:
    """Gerrit's own status for the change: ``NEW``, ``MERGED`` or ``ABANDONED``."""
    return status.field(_entry(repo, ctx, args), "status")


@templatekeyword("gerrit_review_state")
def gerrit_review_state(repo, ctx, templ, **args) -> str:
    """Where the change stands, as one word: ``APPROVED``, ``WIP``, ..."""
    return status.field(_entry(repo, ctx, args), "review_state")


@templatekeyword("gerrit_verified_state")
def gerrit_verified_state(repo, ctx, templ, **args) -> str:
    """The Verified label as a CI signal: ``VERIFIED``, ``FAILED`` or empty."""
    return status.field(_entry(repo, ctx, args), "verified_state")


@templatekeyword("gerrit_code_review")
def gerrit_code_review(repo, ctx, templ, **args) -> int:
    """The dominant Code-Review vote on the change, as a number."""
    return status.field(_entry(repo, ctx, args), "code_review", 0)


@templatekeyword("gerrit_submittable")
def gerrit_submittable(repo, ctx, templ, **args) -> bool:
    """Whether Gerrit would let the change be submitted."""
    return bool(status.field(_entry(repo, ctx, args), "submittable", False))


@templatekeyword("gerrit_status")
def gerrit_status(repo, ctx, templ, **args) -> str:
    """The change's review status in short form, e.g. ``CR+2 V+1``."""
    return status.field(_entry(repo, ctx, args), "summary")
