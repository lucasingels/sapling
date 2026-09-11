# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed according to the terms of the
# GNU General Public License version 2.

"""The commands behind ``sl gerrit pull``, ``review`` and ``refresh``.

``gerrit`` itself is a native (Rust) command, and Rust resolves a command name
against its own table before Python extensions are loaded, so a Python command
called ``gerrit`` would never be reached. The native command owns the
user-facing name, ``publish`` and ``view``, and hands the other three to
``debuggerrit`` here.

They are here for the revset language, which Rust has no evaluator for: it
resolves a single name or hash, while these evaluate expressions --
``draft()``, whatever the user passes as a rev, ``roots(children(x) &
draft())``. ``pull`` goes on to drive the pull, rebase, bookmark and goto
commands, which are Python too. ``view`` needs none of that, so it is native.
"""

from sapling import commands, error, git, node as nodemod, registrar, scmutil
from sapling.i18n import _

from . import api, changeid, status

cmdtable = {}
command = registrar.command(cmdtable)


@command("debuggerrit", [], _("<pull|review|refresh>"), subonly=True)
def gerrit(ui, repo, **opts):
    """work with Gerrit changes (reached as '@prog@ gerrit')"""


subcmd = gerrit.subcommand(
    categories=[
        ("Inspect and update changes", ["review", "refresh"]),
        ("Bring changes into the repo", ["pull"]),
    ]
)


@subcmd(
    "pull",
    [],
    _("CHANGE"),
)
def pull(ui, repo, *args, **opts):
    """pull a Gerrit change and the open changes it depends on

    CHANGE is a change number or a Change-Id -- whatever a Gerrit link or
    ``@prog@ gerrit view`` showed you. Its open ancestors come too, since the
    change does not apply without them, and the checkout moves to the top of
    what was pulled.

    Examples::

      @prog@ gerrit pull 142     pull change 142 and its open ancestors
    """
    if len(args) != 1:
        raise error.Abort(_("specify one change to pull"))
    return _pullstack(ui, repo, api.stackfor(ui, args[0]))


@subcmd(
    "refresh",
    [],
    _("[REV]"),
)
def refresh(ui, repo, *revs, **opts):
    """update the local cache of Gerrit review status

    Smartlog reads review status from a cache rather than from Gerrit, so it
    can draw a line per commit without a round-trip each. The cache is
    refreshed after a push and after a pull; use this to refresh it now.

    Examples::

      @prog@ gerrit refresh        refresh every draft commit
      @prog@ gerrit refresh REV    refresh one commit
    """
    selected = scmutil.revrange(repo, revs) if revs else None
    changeids = status.draftchangeids(repo, selected)
    if not changeids:
        ui.status(_("no commits with a Change-Id found\n"))
        return 0

    ui.status(_("refreshing %d change(s)...\n") % len(changeids))
    cache = status.refresh(repo, changeids)
    for cid in changeids:
        entry = cache.get(cid)
        ui.write(
            "  %s #%s %s\n"
            % (
                cid[:12],
                status.field(entry, "number", ""),
                status.field(entry, "summary"),
            )
        )
    return 0


@subcmd(
    "review",
    [
        ("w", "wip", False, _("mark the change as work-in-progress")),
        ("", "ready", False, _("mark the change as ready for review")),
        ("r", "reviewer", [], _("add a reviewer (repeatable)"), _("USER")),
        ("t", "topic", "", _("set the change's topic"), _("TOPIC")),
    ],
    _("[REV]"),
)
def review(ui, repo, *revs, **opts):
    """show or update the Gerrit change for a commit

    With no options, prints the change's review status and URL.

    Examples::

      @prog@ gerrit review           show the current commit's change
      @prog@ gerrit review -w        mark it work-in-progress
      @prog@ gerrit review --ready   mark it ready for review
      @prog@ gerrit review -r alice  add alice as a reviewer
      @prog@ gerrit review -t bugfix set the topic
    """
    if len(revs) > 1:
        raise error.Abort(_("only one commit can be reviewed at a time"))
    ctx = scmutil.revsingle(repo, revs[0] if revs else ".")
    cid = changeid.extract(ctx.description())
    if not cid:
        raise error.Abort(
            _("commit %s has no Change-Id") % ctx.hex()[:12],
            hint=_("it has not been prepared for Gerrit; amend it to add one"),
        )

    change = api.change(ui, cid)
    if not change:
        api.abortnochange(cid[:12])

    number = change["number"]

    acted = False
    # Work-in-progress and ready are fields of Gerrit's review body rather
    # than options of its own, on either transport.
    if opts.get("wip"):
        ui.status(_("marking #%s as work-in-progress...\n") % number)
        api.review(ui, change, work_in_progress=True)
        acted = True
    if opts.get("ready"):
        ui.status(_("marking #%s as ready for review...\n") % number)
        api.review(ui, change, ready=True)
        acted = True
    topic = opts.get("topic")
    if topic:
        ui.status(_("setting topic '%s' on #%s...\n") % (topic, number))
        api.settopic(ui, change, topic)
        acted = True
    for reviewer in opts.get("reviewer") or []:
        ui.status(_("adding reviewer %s to #%s...\n") % (reviewer, number))
        api.addreviewer(ui, change, reviewer)
        acted = True

    if acted:
        # The change just moved; leave the cache matching the server so
        # smartlog does not show what was true a moment ago.
        status.refresh(repo, [cid])
        return 0

    cache = status.refresh(repo, [cid])
    entry = cache.get(cid)
    ui.write(
        "#%s %s %s\n"
        % (number, status.field(entry, "summary"), api.changeurl(ui, number))
    )
    return 0


def _pullstack(ui, repo, stack):
    """Pull ``stack``, bookmark its ends, and check out its tip."""
    tip = stack[-1]
    tipnode = tip.get("revision")
    bottomnode = stack[0].get("revision")
    if not tipnode or not bottomnode:
        raise error.Abort(_("Gerrit did not report a revision for the stack"))

    # Named by change number, which Gerrit keeps unique across the server, so
    # two people's stacks never collide. ":" is not allowed in a sapling name
    # and a bare number is reserved, hence the prefix.
    base = "gerrit/%s" % stack[0]["number"]
    tipmark = "%s-tip" % base
    # Where the stack ended last time it was pulled, so local work built on top
    # of it can be moved onto the new patchsets rather than left behind.
    previoustip = _bookmarknode(repo, tipmark)

    for change in stack:
        ui.write("  #%s %s\n" % (change["number"], change.get("subject", "")))

    ui.status(_("fetching a stack of %d change(s)...\n") % len(stack))
    _fetch(ui, repo, tip["fetch_ref"], tipnode)

    # Before any rebase, so that a rebase left half-finished by a conflict
    # still leaves the marks describing the stack that was fetched.
    ui.status(_("bookmarking %s at the base of the stack...\n") % base)
    commands.bookmark(ui, repo, base, rev=bottomnode, force=True)
    commands.bookmark(ui, repo, tipmark, rev=tipnode, force=True)

    _dropmergedparentmarks(ui, repo, stack)

    if previoustip and previoustip != tipnode:
        _rebaselocalwork(ui, repo, previoustip, tipnode, stack)

    # Land on local work built on the stack, if there is any, rather than
    # underneath it.
    local = repo.revs("max(descendants(%s) - %s)", tipnode, tipnode)
    target = repo[local.first()].hex() if local else tipnode
    ui.status(_("checking out %s...\n") % target[:12])
    commands.update(ui, repo, node=target)
    return 0


def _fetch(ui, repo, ref, node):
    """Fetch ``ref`` from the Gerrit remote and make its commits visible.

    Fetching the tip's ref brings the whole stack, since every change below it
    is an ancestor. It has to be the ref and not the commit hash: `sl pull -r`
    only takes a hash for a git repo, and a server is free to refuse a fetch
    of a hash that no ref it advertises points at, whereas
    ``refs/changes/<nn>/<change>/<patchset>`` is exactly what Gerrit publishes
    a patchset as.
    """
    abort_ifnot_git(repo)
    url, _remote = git.urlremote(ui, "default")
    # A visiblehead is how sapling holds on to a commit that no bookmark or
    # remote branch names -- the same landing spot `sl pull -r HASH` uses.
    refspec = "+%s:%s" % (ref, git.RefName.visiblehead(nodemod.bin(node)))
    if git.pullrefspecs(repo, url, [refspec]) != 0:
        raise error.Abort(_("could not fetch %s from %s") % (ref, url))


def abort_ifnot_git(repo):
    if not git.isgitstore(repo):
        raise error.Abort(
            _("this repo is not git-backed"),
            hint=_("Gerrit serves git; nothing here can be fetched from it"),
        )


def _bookmarknode(repo, name):
    """The node a local bookmark points at, or None if there is no such one."""
    node = repo._bookmarks.get(name)
    return nodemod.hex(node) if node else None


def _rebaselocalwork(ui, repo, previoustip, tipnode, stack):
    """Move local commits off the stack's old tip and onto its new one.

    A conflict here is left for the user to resolve rather than swallowed:
    the commits are fetched and the bookmarks are set, so finishing the
    rebase is all that is left to do.
    """
    from sapling.ext import rebase as rebasemod

    fetched = {change.get("revision") for change in stack}
    for rev in repo.revs("roots(children(%s) & draft())", previoustip):
        node = repo[rev].hex()
        if node in fetched:
            continue
        ui.status(_("rebasing local work onto the updated stack...\n"))
        rebasemod.rebase(ui, repo, source=node, dest=[tipnode])


def _dropmergedparentmarks(ui, repo, stack):
    """Delete the bookmarks of a parent change that has since been merged.

    Its commits are in the trunk now, so names pointing at the draft copies
    only make the smartlog harder to read.
    """
    parent = stack[0].get("depends_on")
    if parent and not stack[0].get("depends_on_open"):
        stale = "gerrit/%s" % parent
        for name in (stale, "%s-tip" % stale):
            if _bookmarknode(repo, name):
                commands.bookmark(ui, repo, name, delete=True)
