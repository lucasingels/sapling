# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed according to the terms of the
# GNU General Public License version 2.

"""Comparing commits by what they change rather than by hash."""


def changedlines(ctx):
    """What a commit's diff changes, without where.

    Context lines and hunk headers go, since new lines upstream can move,
    split or merge hunks without changing the patch; so do blob ids. Two
    commits with the same changed lines are the same patch on different bases,
    which is what Gerrit calls a trivial rebase.
    """
    diff = b"".join(ctx.diff(git=True))
    return [
        line
        for line in diff.split(b"\n")
        if line
        and not line.startswith(b" ")
        and not line.startswith(b"@@")
        and not line.startswith(b"index ")
    ]
