# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed according to the terms of the
# GNU General Public License version 2.

"""Checks run before commits are uploaded to ``refs/for/<branch>``.

A push for review sends the commit named and every draft below it, and Gerrit
makes a patchset of each one that is a new commit object. Two ways that goes
wrong without anyone meaning it to:

- The same Change-Id is on two live commits -- typically two worktrees that
  each rewrote their own copy of a change. Whichever is pushed becomes the
  change's new patchset, and the other copy's work is silently left out.
  :func:`checkduplicates` refuses the push and names both.

- The stack was moved onto a newer trunk, so every change in it has a new
  hash and nothing else new. Each gets a patchset that only rebases it: noise
  in the change's history, and churn for anyone who has the old patchset
  checked out, though Gerrit's default copy conditions carry votes over a
  trivial rebase. :func:`checkrebaseonly` lists them; it can be made to refuse
  the push instead (``gerrit.republish-check=abort``), with
  ``--force-republish`` to upload them anyway.

The rebase-only test is ISL's (``isl-server/src/gerrit/rebasedRevisions.ts``),
which is also what Gerrit calls a trivial rebase: the same commit message, the
same changed lines with context ignored, and an equivalent parent.

What is on Gerrit comes from the status cache, and counts only for the branch
the push is for: the same Change-Id on another branch is another change, so
moving a stack there is a first upload, not a republish.

Config::

    [gerrit]
    # Refuse a push that carries a Change-Id another live draft also has.
    check-duplicate-change-ids = True

    # What to do when changes would get patchsets that only rebase them:
    # warn (the default), abort, or off.
    republish-check = warn

    # internal config: gerrit.force-republish
    # Set for the one command by `--force-republish`.
"""

from sapling import error, git
from sapling.i18n import _, _n
from sapling.node import bin, short

from . import changeid, diffs, status


def uploads(pushnode_to_pairs):
    """``(node, branch)`` for the commits in a push that go to Gerrit's
    upload refs."""
    result = []
    for pushnode, ref in pushnode_to_pairs:
        ref = str(ref) if ref else ""
        if pushnode is None or not ref.startswith(git.GERRIT_UPLOAD_REFS):
            continue
        result.append((pushnode, branch(ref)))
    return result


def branch(ref):
    """The branch an upload ref is for review against.

    >>> branch("refs/for/main")
    'main'
    >>> branch("refs/for/release/1.0%topic=x,r=alice")
    'release/1.0'
    >>> branch("refs/drafts/main%wip")
    'main'
    """
    for prefix in git.GERRIT_UPLOAD_REFS:
        if ref.startswith(prefix):
            ref = ref[len(prefix) :]
            break
    return ref.partition("%")[0]


def check(repo, pushnode_to_pairs):
    """Run the pre-upload checks. Raises Abort when a push should not happen."""
    for tip, target in uploads(pushnode_to_pairs):
        pushed = list(repo.revs("draft() & ::%n", tip))
        cache = status.load(repo)
        checkduplicates(repo, pushed, target, cache)
        checkrebaseonly(repo, pushed, repo[tip].rev(), target, cache)


def uploadednode(repo, entry, target):
    """The commit a change's current patchset is, if it is in the repo and the
    change is for ``target``.

    A cache entry from before branches were recorded is taken to be for
    ``target``; the next refresh fills it in.
    """
    if not isinstance(entry, dict):
        return None
    if entry.get("branch") and entry.get("branch") != target:
        return None
    revision = entry.get("revision")
    if not revision or len(revision) != 40:
        return None
    try:
        node = bin(revision)
    except (TypeError, ValueError):
        return None
    return node if repo.changelog.hasnode(node) else None


def checkduplicates(repo, pushed, target, cache):
    """Abort if a pushed Change-Id is on a live draft other than its own."""
    ui = repo.ui
    if not ui.configbool("gerrit", "check-duplicate-change-ids", True):
        return
    bycid = {}
    clashes = []
    for rev in pushed:
        ctx = repo[rev]
        cid = changeid.extract(ctx.description())
        if not cid:
            continue
        # Already the change's current patchset, so the push adds nothing to
        # it -- as after rebasing work back onto what is on Gerrit, which
        # leaves the rebased copies of these behind.
        if uploadednode(repo, cache.get(cid), target) == ctx.node():
            continue
        if cid in bycid:
            ui.warn(
                _("Change-Id %s is on two of the commits being pushed, %s and %s\n")
                % (cid[:12], _describe(repo, bycid[cid]), _describe(repo, rev))
            )
            clashes.append(cid)
        else:
            bycid[cid] = rev
    if bycid:
        for rev in repo.revs("(draft() - obsolete()) - %ld", pushed):
            cid = changeid.extract(repo[rev].description())
            if cid in bycid:
                ui.warn(
                    _("Change-Id %s is on both %s (pushed) and %s\n")
                    % (cid[:12], _describe(repo, bycid[cid]), _describe(repo, rev))
                )
                clashes.append(cid)
    if clashes:
        raise error.Abort(
            _("the same change is on more than one live commit"),
            hint=_(
                "hide the stale copy with '@prog@ hide REV' first: Gerrit takes "
                "whichever is pushed as the change's next patchset, dropping the "
                "other's work"
            ),
        )


def checkrebaseonly(repo, pushed, tiprev, target, cache):
    """Warn about, or stop, patchsets that would only rebase their change."""
    ui = repo.ui
    mode = ui.config("gerrit", "republish-check", "warn")
    if mode == "off" or ui.configbool("gerrit", "force-republish"):
        return
    rebased = findrebased(repo, pushed, target, cache)
    if not rebased:
        return

    listing = "".join(
        _("  %s (on Gerrit as %s)\n") % (_describe(repo, rev), short(uploaded))
        for rev, uploaded in sorted(rebased.items())
    )
    count = len(rebased)
    if tiprev in rebased:
        # The commit being pushed is itself unchanged, so everything going up
        # with it is: there is nothing to rebase onto Gerrit's copy instead.
        what = _n(
            "nothing but a rebase to upload: %d change would get a patchset that only rebases it:\n",
            "nothing but a rebase to upload: %d changes would get patchsets that only rebase them:\n",
            count,
        ) % count
        hint = _("pass --force-republish to upload it anyway")
        refusal = _("nothing but a rebase to upload")
    else:
        what = _n(
            "%d change below the one being pushed would get a patchset that only rebases it:\n",
            "%d changes below the one being pushed would get patchsets that only rebase them:\n",
            count,
        ) % count
        hint = _rebasehint(repo, pushed, rebased)
        if hint:
            hint += _("; or pass --force-republish to upload them anyway")
        else:
            hint = _("pass --force-republish to upload them anyway")
        refusal = _("refusing to upload rebase-only patchsets")

    if mode != "abort":
        ui.warn(_("warning: ") + what + listing)
        return
    ui.warn(what + listing)
    raise error.Abort(refusal, hint=hint)


def findrebased(repo, revs, target, cache):
    """Map each of ``revs`` that is a trivial rebase of its uploaded patchset
    to that patchset's node.

    The uploaded patchset is the change's current revision in the status
    cache. It has to be in the repo to compare against, which it is when it was
    published from here; when it is not, the commit counts as changed.
    """
    candidates = {}
    for rev in revs:
        ctx = repo[rev]
        uploaded = uploadednode(
            repo, cache.get(changeid.extract(ctx.description()) or ""), target
        )
        if uploaded is None or uploaded == ctx.node():
            continue
        up = repo[uploaded]
        if len(ctx.parents()) != 1 or len(up.parents()) != 1:
            continue
        if ctx.description() != up.description():
            continue
        if diffs.changedlines(ctx) != diffs.changedlines(up):
            continue
        candidates[rev] = uploaded

    # A commit counts only if its parent is equivalent too, or reordering a
    # stack would slip through: both parents public (the stack moved to a
    # newer trunk), or the local parent is the uploaded parent or a trivial
    # rebase of it. Parents come first in revision order, so one pass settles
    # it.
    equivalent = {}
    rebased = {}
    for rev in sorted(candidates):
        uploaded = candidates[rev]
        p = repo[rev].p1()
        q = repo[uploaded].p1()
        pnode = equivalent.get(p.rev(), p.node())
        if pnode == q.node() or (p.phase() == 0 and q.phase() == 0):
            equivalent[rev] = uploaded
            rebased[rev] = uploaded
    return rebased


def _rebasehint(repo, pushed, rebased):
    """A rebase that keeps the unchanged ancestors as they are on Gerrit.

    Only when the rebased commits are exactly the bottom of a linear stack:
    the first changed commit can then go onto the uploaded patchset of its
    parent, and only it and what is above it get uploaded. The rebased copies
    are left behind with the same Change-Ids, so they have to go too, or the
    next push trips over them as duplicates.
    """
    pushed = set(pushed)
    changed = [rev for rev in sorted(pushed) if rev not in rebased]
    if not changed:
        return ""
    first = changed[0]
    parent = repo[first].p1().rev()
    below = set(repo.revs("%ld & ::%d", pushed, parent))
    if parent not in rebased or below != set(rebased):
        return ""
    return _(
        "rebase the rest onto what is on Gerrit with '@prog@ rebase -s %s -d %s', "
        "then hide the rebased copies with '@prog@ hide %s'"
    ) % (
        short(repo[first].node()),
        short(rebased[parent]),
        " ".join(short(repo[rev].node()) for rev in sorted(rebased)),
    )


def _describe(repo, rev):
    ctx = repo[rev]
    return "%s %s" % (short(ctx.node()), ctx.description().split("\n", 1)[0])
