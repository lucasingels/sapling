# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed according to the terms of the
# GNU General Public License version 2.

"""Teaching smartlog to draw a Gerrit change.

Definitions are template expressions, not ``{...}`` templates: that is what a
``[templatealias]`` value is once the config parser has had it.

Smartlog renders a code review through a handful of template aliases --
``sl_difflink`` for the link, ``sl_diffstatus`` and ``sl_difflabel`` for the
state and its color, ``sl_diffsignal`` for the CI glyph. The builtin config
points those at GitHub or Phabricator. Rather than add a Gerrit branch there,
which would put Gerrit specifics in config shared by every repo, the provider
points them at its own aliases when it loads in a Gerrit repo.
"""

# What smartlog asks the provider for, and what this provider answers with.
REDIRECTS = {
    "sl_difflink": "gerrit_sl_difflink",
    "sl_diffstatus": "gerrit_sl_diffstatus",
    "sl_difflabel": "gerrit_sl_difflabel",
    "sl_diffsignal": "gerrit_sl_diffsignal",
    "sl_diffsignallabel": "gerrit_sl_diffsignallabel",
    "sl_diff": "gerrit_sl_diff",
}

ALIASES = {
    "gerrit_sl_difflink": (
        "if(gerrit_change_number, hyperlink(gerrit_change_url, '#{gerrit_change_number}'))"
    ),
    # A merged or abandoned change's votes no longer say anything useful, so
    # the state folds "where is this change" and "what did review say about
    # it" into one word, the way github_pr_state does.
    "gerrit_sl_diffstatus": (
        "case(gerrit_review_state,"
        " 'MERGED', 'Merged',"
        " 'ABANDONED', 'Abandoned',"
        " 'APPROVED', 'Approved',"
        " 'REJECTED', 'Rejected',"
        " 'CHANGES_REQUESTED', 'Changes Requested',"
        " 'RECOMMENDED', 'Recommended',"
        " 'WIP', 'Work in Progress',"
        " 'PRIVATE', 'Private',"
        " 'REVIEW_REQUIRED', 'Review Required')"
    ),
    "gerrit_sl_difflabel": (
        "case(gerrit_review_state,"
        " 'MERGED', 'ssl.committed',"
        " 'ABANDONED', 'ssl.abandoned',"
        " 'APPROVED', 'ssl.accepted',"
        " 'REJECTED', 'ssl.revision',"
        " 'CHANGES_REQUESTED', 'ssl.revision',"
        " 'RECOMMENDED', 'ssl.review',"
        " 'WIP', 'ssl.unpublished',"
        " 'PRIVATE', 'ssl.unpublished',"
        " 'REVIEW_REQUIRED', 'ssl.review',"
        " 'sl.diff')"
    ),
    # Gerrit has no separate CI status to report: a project wires its builds
    # up to the Verified label, and a project with no Verified label shows no
    # glyph rather than one that would always say "pending".
    "gerrit_sl_diffsignal": (
        "case(gerrit_verified_state,"
        " 'VERIFIED', sl_signal_okay,"
        " 'FAILED', sl_signal_failed)"
    ),
    "gerrit_sl_diffsignallabel": (
        "case(gerrit_verified_state,"
        " 'VERIFIED', 'ssl.signal_okay',"
        " 'FAILED', 'ssl.signal_failed')"
    ),
    # Plain smartlog shows only the review link for GitHub and Phabricator,
    # where the number is stable and the state is a click away. A Gerrit
    # change is read by its votes -- whether it has the +2 it needs -- so
    # those ride along, in the color of the state they add up to.
    "gerrit_sl_diff": (
        "separate(' ', label(sl_difflabel, sl_difflink),"
        " if(gerrit_status, label(sl_difflabel, '[{gerrit_status}]')))"
    ),
}


def install(ui):
    """Point smartlog's review slots at this provider's aliases."""
    for name, definition in ALIASES.items():
        ui.setconfig("templatealias", name, definition, "gerrit")
    for slot, alias in REDIRECTS.items():
        if _customized(ui, slot):
            # Someone has written their own; theirs wins over the provider's.
            continue
        ui.setconfig("templatealias", slot, alias, "gerrit")


def _customized(ui, name):
    """Has the user defined ``name`` themselves?

    Everything sapling ships is sourced from a ``builtin:`` config, so a
    source that is anything else is a definition written by hand.
    """
    source = ui.configsource("templatealias", name)
    return bool(source) and not source.startswith("builtin:")
