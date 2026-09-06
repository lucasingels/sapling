# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed according to the terms of the
# GNU General Public License version 2.

"""Gerrit ``Change-Id`` trailers.

Gerrit identifies a change by a ``Change-Id: I<sha1>`` trailer in the commit
message and attaches every later amend of that commit to the same change by
matching it. Gerrit's own tooling adds the trailer from a ``commit-msg`` hook;
sl adds it when the commit is created (see ``reposetup``), so that a plain
``sl push`` to ``refs/for/<branch>`` works and not only ``sl gerrit publish``.
"""

import hashlib
import re

TRAILER = "Change-Id"

# A git trailer line: a token of letters, digits and dashes, then ": ".
_TRAILER_RE = re.compile(r"^[A-Za-z][A-Za-z0-9-]*:[ \t]")
_CHANGE_ID_RE = re.compile(r"^Change-Id:[ \t]*(I[0-9a-f]{40})[ \t]*$", re.MULTILINE)


def extract(description):
    """Return the Change-Id in ``description``, or None.

    >>> extract("commit\\n\\nChange-Id: I" + "a" * 40)
    'Iaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    >>> extract("commit\\n\\nChange-Id: not-an-id") is None
    True
    >>> extract("commit") is None
    True
    """
    match = _CHANGE_ID_RE.search(description)
    return match.group(1) if match else None


def generate(*parts):
    """Build a Change-Id ("I" followed by 40 hex digits) from commit context.

    Gerrit only requires the id to match ``I[0-9a-f]{40}`` and to be unique per
    change, so any stable hash of the commit's identity will do.

    >>> generate("alice", "deadbeef", "a commit")
    'If83719e066795a52b0a32cbf491e506a02ef3998'
    """
    content = "\n".join(str(part) for part in parts)
    return "I" + hashlib.sha1(content.encode("utf-8")).hexdigest()


def attach(description, change_id):
    """Return ``description`` carrying ``change_id``, unless it has a trailer.

    >>> print(attach("a commit", "I" + "b" * 40))
    a commit
    <BLANKLINE>
    Change-Id: Ibbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
    <BLANKLINE>
    """
    if extract(description):
        return description
    body = description.rstrip()
    if not body:
        return description
    separator = "\n" if _ends_with_trailer_block(body) else "\n\n"
    return body + separator + "%s: %s" % (TRAILER, change_id) + "\n"


def ensure(description, *parts):
    """Return ``description`` with a Change-Id trailer, adding one if missing.

    An existing trailer is left alone, which is what makes an amend land on the
    same Gerrit change rather than opening a new one.

    >>> print(ensure("a commit", "alice", "deadbeef"))
    a commit
    <BLANKLINE>
    Change-Id: I9606a297e5bb089d44e37ec7927d6be4db6a27de
    <BLANKLINE>

    The trailer joins an existing trailer block instead of starting a new
    paragraph, the way git's own trailer handling does:

    >>> print(ensure("a commit\\n\\nSigned-off-by: alice", "alice", "deadbeef"))
    a commit
    <BLANKLINE>
    Signed-off-by: alice
    Change-Id: I8fc659a29a4b089d55ce3fd08ad8f41a01ce14c6
    <BLANKLINE>
    """
    if extract(description):
        return description
    body = description.rstrip()
    if not body:
        return description
    return attach(description, generate(body, *parts))


def strip(description):
    """Return ``description`` without its Change-Id trailer.

    A copied commit (``graft``, ``rebase --keep``) is new work that inherited
    the trailer along with the message. Leaving it there would attach the copy
    to a change it is not part of, so it is dropped and a fresh id minted.

    >>> print(strip("a commit\\n\\nChange-Id: I" + "c" * 40))
    a commit
    >>> print(strip("a commit\\n\\nSigned-off-by: alice\\nChange-Id: I" + "c" * 40))
    a commit
    <BLANKLINE>
    Signed-off-by: alice
    >>> print(strip("a commit"))
    a commit
    """
    stripped = _CHANGE_ID_RE.sub("", description)
    # Dropping a line that had blank lines either side leaves a double blank
    # line behind; collapse it. Keep the original if nothing else remains.
    return re.sub(r"\n{3,}", "\n\n", stripped).rstrip() or description.rstrip()


def _ends_with_trailer_block(body):
    """Does ``body`` end with a trailer block that is its own paragraph?

    >>> _ends_with_trailer_block("a commit\\n\\nSigned-off-by: alice")
    True
    >>> _ends_with_trailer_block("a commit")
    False
    >>> _ends_with_trailer_block("see this\\nnote: it is not a trailer block")
    False
    """
    lines = body.split("\n")
    index = len(lines)
    while index > 0 and _TRAILER_RE.match(lines[index - 1]):
        index -= 1
    if index == len(lines):
        # The last line is not a trailer at all.
        return False
    # A trailer block is a paragraph of its own, not the tail of a sentence.
    return index > 0 and not lines[index - 1].strip()
