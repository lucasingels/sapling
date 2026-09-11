# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed according to the terms of the
# GNU General Public License version 2.

"""The local cache of Gerrit review status, keyed by Change-Id.

Smartlog renders a line per commit and cannot afford a network round-trip for
each one, so what Gerrit says about a change is kept in a file under the
repo's cache directory and refreshed at the points where it is known to have
changed: after a push (the change was just updated) and after a pull (someone
may have reviewed it), plus on demand via ``sl gerrit refresh``.

What is cached is what :mod:`api` hands back, conclusions included, so
reading it back needs none of the rules that produced it.
"""

import json

from . import api, changeid

# Under repo.cachevfs, so it is shared by linked worktrees of the same repo
# and thrown away with the rest of the cache rather than tracked.
CACHEFILE = "gerrit-changes.json"

# Gerrit's query length and result count both have limits, and a user with a
# long-lived stack can accumulate a lot of open changes.
CHUNKSIZE = 50


def load(repo):
    """The cached changes, as a dict keyed by Change-Id."""
    try:
        data = json.loads(repo.cachevfs.tryreadutf8(CACHEFILE) or "{}")
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def save(repo, cache):
    # Written atomically: a refresh spawned in the background by `sl pull` can
    # land while another command is reading the cache.
    with repo.cachevfs(CACHEFILE, "wb", atomictemp=True) as f:
        f.write(json.dumps(cache, indent=2, sort_keys=True).encode("utf-8"))


def refresh(repo, changeids):
    """Ask Gerrit about ``changeids`` and update the cache. Returns the cache.

    Changes are queried in batches: one round-trip per change made ``sl pull``
    crawl for anyone with more than a handful of them open.
    """
    changeids = [cid for cid in dict.fromkeys(changeids) if cid]
    if not changeids:
        return load(repo)
    cache = load(repo)
    for start in range(0, len(changeids), CHUNKSIZE):
        chunk = changeids[start : start + CHUNKSIZE]
        terms = " OR ".join("change:%s" % cid for cid in chunk)
        try:
            changes = api.query(repo.ui, terms)
        except Exception as exc:
            # A server that is down or unreachable should not fail the command
            # that triggered the refresh; the stale cache stays readable.
            repo.ui.debug("gerrit: refresh failed: %s\n" % exc)
            continue
        for change in changes:
            cid = change.get("change_id")
            if cid:
                cache[cid] = change
    save(repo, cache)
    return cache


def entry(repo, ctx, cache=None):
    """The cached change for ``ctx``, or None if it has none."""
    cid = changeid.extract(ctx.description())
    if not cid:
        return None
    if cache is None:
        cache = load(repo)
    return cache.get(cid)


def field(entry, name, default=""):
    """One field of a cached change, or ``default`` when there is no change."""
    return entry.get(name, default) if entry else default


def draftchangeids(repo, revs=None):
    """The Change-Ids of ``revs``, defaulting to every draft commit."""
    changeids = []
    for rev in repo.revs("draft()") if revs is None else revs:
        cid = changeid.extract(repo[rev].description())
        if cid:
            changeids.append(cid)
    return changeids
