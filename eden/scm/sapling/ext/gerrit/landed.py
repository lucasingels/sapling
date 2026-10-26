# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed according to the terms of the
# GNU General Public License version 2.

"""Mark draft commits as landed once Gerrit has submitted them.

Gerrit submits a change by rebasing or cherry-picking it onto the branch, so
the commit that lands has a new hash. Sapling recognises a landed draft by hash
identity or by a mutation record, and neither survives that: after a pull the
local copy stays visible and non-obsolete, ``pull --rebase`` replays it onto
the trunk (and conflicts, when the landing was amended or conflict-resolved),
and nothing links it to the commit that landed.

The Change-Id is that link. It travels with the change through every patchset
and into the submitted commit, so a draft carrying the Change-Id of a public
commit on the branch it was sent to, above where the draft was written, is a
copy of something that has landed. For each one this records a synthetic
``land`` mutation pointing at the public commit -- the same record the GitHub
and Phabricator markers write -- and hides the draft. Rebase then skips it,
smartlog stops showing it, and anything following successors finds the
landed commit.

Hiding is what makes this dangerous, so a draft is left alone when it may hold
work that is not in what landed: it has to be a commit that was uploaded, a
trivial rebase of one, or the same patch as the landed commit. Another
worktree on such a draft is moved onto the landed commit once the pull is
done, as after any rewrite; with ``worktree.follow-rewrites=false`` the draft
is left alone instead, since hiding it would leave that checkout stale under
whoever is working there.

Nothing is asked of the server: the public commits are already local after a
pull. Their Change-Ids are indexed in the repo's cache, so a pull only reads
the descriptions of the public commits it brought in.
"""

import json

from sapling import bookmarks, mutation, visibility, worktreestale
from sapling.i18n import _, _n
from sapling.node import bin, hex, short

from . import changeid, diffs, status

# Drafts can sit on a trunk commit from long ago, and everything since is a
# place one of them might have landed. Reading every description back to there
# would make a pull in a busy repo crawl, so at most this many public commits
# are read at a time, newest first; a draft that landed further back than this
# can still be hidden by hand.
DEFAULT_SCAN_LIMIT = 10000

# Under repo.cachevfs, shared by the worktrees of a repo like the status cache.
INDEXFILE = "gerrit-landed-index.json"
UPLOADEDFILE = "gerrit-uploaded.json"

# How many uploaded commits to remember. Only drafts that have yet to land
# need to be found in it.
UPLOADED_LIMIT = 10000


def enabled(ui):
    return bool(ui.config("gerrit", "url")) and ui.configbool(
        "gerrit", "hide-landed-commits", True
    )


def hook(ui, repo, **kwargs):
    """``post-pull`` hook: mark what the pull brought in as landed."""
    marklanded(ui, repo)


def recorduploaded(repo, nodes):
    """Remember that ``nodes`` were pushed for review.

    What was uploaded is what Gerrit can have submitted, so a draft that is one
    of these holds nothing the landed commit lacks but what review changed.
    """
    if not nodes:
        return
    known = _loaduploaded(repo)
    for node in nodes:
        known.pop(hex(node), None)
        known[hex(node)] = True
    _save(repo, UPLOADEDFILE, list(known)[-UPLOADED_LIMIT:])


def _loaduploaded(repo):
    data = _load(repo, UPLOADEDFILE)
    return dict.fromkeys(data if isinstance(data, list) else [])


def marklanded(ui, repo, dry_run=False, full=False):
    """Hide drafts that have landed. Returns how many were found to have,
    including those left visible."""
    if not enabled(ui):
        return 0
    landings = findlanded(repo, full=full)
    if not landings:
        return 0

    cache = status.load(repo)
    uploaded = {bin(h) for h in _loaduploaded(repo)}
    for entry in cache.values():
        revision = entry.get("revision") if isinstance(entry, dict) else None
        if revision and len(revision) == 40:
            uploaded.add(bin(revision))
    # When worktrees follow rewrites, one on a landed draft is moved onto the
    # commit that landed once the pull is done, like one on a rebased commit.
    checkouts = {}
    if not worktreestale.follows(ui):
        torev = repo.changelog.rev
        checkouts = {
            node: path
            for path, node in worktreestale.checkoutsin(
                repo, [torev(draft) for draft, _public, _cid in landings]
            ).items()
        }

    tohide = []
    for draft, public, cid in landings:
        change = _changename(cache.get(cid), cid)
        if draft in checkouts:
            ui.warn(
                _(
                    "change %s landed as %s; not hiding %s, which worktree %s "
                    "has checked out\n"
                )
                % (change, short(public), short(draft), checkouts[draft])
            )
            continue
        if not _holdsnothingmore(repo, draft, public, uploaded):
            ui.warn(
                _(
                    "change %s landed as %s; %s has local changes not in it, "
                    "not hiding\n"
                )
                % (change, short(public), short(draft))
            )
            continue
        msg = _("%s landed as %s\n") % (short(draft), short(public))
        if dry_run:
            ui.status(_("would mark %s") % msg)
        else:
            ui.note(_("marking %s") % msg)
        tohide.append((draft, public))

    if tohide and not dry_run:
        with repo.lock(), repo.transaction("gerritmarker"):
            if mutation.enabled(repo):
                entries = [
                    mutation.createsyntheticentry(repo, [draft], public, "land")
                    for draft, public in tohide
                ]
                mutation.recordentries(repo, entries, skipexisting=False)
            if visibility.tracking(repo):
                visibility.remove(repo, [draft for draft, _public in tohide])
        # Other worktrees stacked on what was hidden are now stale; say so, as
        # any command that rewrites commits does.
        worktreestale.scheduleafterrewrite(repo, [draft for draft, _p in tohide])
        ui.status(
            _n(
                "marked %d commit as landed\n",
                "marked %d commits as landed\n",
                len(tohide),
            )
            % len(tohide)
        )
    return len(landings)


def findlanded(repo, full=False):
    """``(draft, public, changeid)`` for each draft that has landed as public.

    A public commit counts only if it is on the branch the change was sent to
    (from the status cache, or the main branch when the change is not in it)
    and above the public commit the draft was written on: the same Change-Id
    cherry-picked to another branch is another change, and a commit below the
    draft cannot be where it landed.
    """
    bycid = {}
    drafts = repo.revs("draft() - obsolete()")
    for rev in drafts:
        cid = changeid.extract(repo[rev].description())
        if cid:
            bycid.setdefault(cid, []).append(rev)
    if not bycid:
        return []

    index = _index(repo, drafts, full)
    cache = status.load(repo)
    cl = repo.changelog
    landed = []
    for cid, revs in bycid.items():
        publics = [bin(h) for h in index.get(cid, [])]
        if not publics:
            continue
        tip = _branchtip(repo, cache.get(cid))
        if tip is None:
            continue
        onbranch = [p for p in publics if cl.isancestor(p, tip) or p == tip]
        for rev in revs:
            bases = [repo[b].node() for b in repo.revs("heads(public() & ::%d)", rev)]
            above = [p for p in onbranch if any(cl.isancestor(b, p) for b in bases)]
            if above:
                # The newest: a change reverted and submitted again has landed
                # as the later commit.
                landed.append((rev, max(above, key=cl.rev), cid))
    landed.sort()
    return [(repo[rev].node(), public, cid) for rev, public, cid in landed]


def _index(repo, drafts, full):
    """{Change-Id: [hex node]} for the public commits a draft could have
    landed as: those above the oldest public commit a draft was written on.

    Kept in the cache with the part of the graph it covers, so a pull reads
    only the public commits that are new since.
    """
    window = repo.revs(
        "public() & (roots(public() & parents(draft() & ::%ld)))::", drafts
    )
    roots = list(repo.revs("roots(%ld)", window))
    data = None if full else _load(repo, INDEXFILE)
    if not isinstance(data, dict):
        data = {}
    index = data.get("changeids") or {}
    heads = [bin(h) for h in data.get("heads") or []]
    oldroots = [bin(h) for h in data.get("roots") or []]
    cl = repo.changelog
    ispublic = mutation.getispublicfunc(repo)
    usable = (
        heads
        and oldroots
        and all(cl.hasnode(n) and ispublic(n) for n in heads + oldroots)
        # The window may only have moved up since; if it reaches further down
        # now, what lies below the old one was never read.
        and not repo.revs("%ld - (%ln)::", roots, oldroots)
    )
    if usable:
        toread = repo.revs("%ld - ::%ln", window, heads)
    else:
        index = {}
        toread = window

    limit = repo.ui.configint("gerrit", "landed-scan-limit", DEFAULT_SCAN_LIMIT)
    for rev in sorted(toread, reverse=True)[:limit]:
        ctx = repo[rev]
        cid = changeid.extract(ctx.description())
        if cid:
            nodes = index.setdefault(cid, [])
            if ctx.hex() not in nodes:
                nodes.append(ctx.hex())

    # Drop what has fallen out of the window, so the index stays the size of
    # the history drafts are still written on.
    windowset = set(window)
    pruned = {}
    for cid, nodes in index.items():
        kept = [
            n for n in nodes if cl.hasnode(bin(n)) and cl.rev(bin(n)) in windowset
        ]
        if kept:
            pruned[cid] = kept
    _save(
        repo,
        INDEXFILE,
        {
            "roots": [repo[r].hex() for r in roots],
            "heads": [repo[r].hex() for r in repo.revs("heads(%ld)", window)],
            "changeids": pruned,
        },
    )
    return pruned


def _branchtip(repo, entry):
    """The public commit at the tip of the branch a change was sent to."""
    branch = entry.get("branch") if isinstance(entry, dict) else None
    if not branch:
        branch = bookmarks.mainbookmark(repo)
    for node, nametype, _remote, name in bookmarks.readremotenames(repo):
        if nametype != "bookmarks" or name != branch:
            continue
        if len(node) == 40:
            node = bin(node)
        if repo.changelog.hasnode(node):
            return node
    return None


def _holdsnothingmore(repo, draft, public, uploaded):
    """Whether hiding ``draft`` loses nothing that is not in ``public``.

    True when the draft was uploaded (so review saw it, and whatever changed
    on the way in was changed there), or is a trivial rebase of an uploaded
    predecessor, or is the same patch as what landed.
    """
    if draft in uploaded:
        return True
    lines = diffs.changedlines(repo[draft])
    if lines == diffs.changedlines(repo[public]):
        return True
    for pred in mutation.allpredecessors(repo, [draft], startdepth=1):
        if pred in uploaded and repo.changelog.hasnode(pred):
            if diffs.changedlines(repo[pred]) == lines:
                return True
    return False


def _changename(entry, cid):
    number = entry.get("number") if isinstance(entry, dict) else None
    return "#%s" % number if number else cid[:12]


def _load(repo, name):
    try:
        return json.loads(repo.cachevfs.tryreadutf8(name) or "null")
    except ValueError:
        return None


def _save(repo, name, data):
    with repo.cachevfs(name, "wb", atomictemp=True) as f:
        f.write(json.dumps(data, sort_keys=True).encode("utf-8"))
